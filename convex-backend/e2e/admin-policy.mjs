import assert from "node:assert/strict";
import { createDecipheriv, createHmac, hkdfSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const [env, keyFile, mode] = process.argv.slice(2);
const origin = [
	"directory",
	"accounts",
	"password",
	"signup",
	"deletion",
	"oidc",
].includes(mode)
	? "http://127.0.0.1:3731"
	: "http://127.0.0.1:3727";
const request = (path, method, body, token) =>
	fetch(origin + "/api/" + path, {
		method,
		body: body === undefined ? undefined : JSON.stringify(body),
		headers: {
			"Content-Type": "application/json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
	});
const signup = mode === "signup";
const deletion = mode === "deletion";
const oidc = mode === "oidc";
if (signup)
	assert.equal(
		(await request("admin/settings/registration", "GET")).status,
		401,
	);
const passwordReset = mode === "password";
if (passwordReset)
	assert.equal(
		(await request("admin/users/absent/reset-password", "POST", {})).status,
		401,
	);
const management = mode === "accounts";
if (management)
	assert.equal(
		(await request("admin/users/absent/approve", "POST")).status,
		401,
	);
const directory = mode === "directory";
if (directory) assert.equal((await request("admin/users", "GET")).status, 401);
const reset = mode === "reset";
const resetPath = (id) => "admin/users/" + id + "/reset-2fa";
if (reset) {
	assert.equal((await request(resetPath("absent"), "POST")).status, 401);
}
const policyPath = "admin/settings/two-factor";
assert.equal((await request(policyPath, "GET")).status, 401);

const accounts = JSON.parse(
	execFileSync(
		process.execPath,
		[
			`--env-file=${env}`,
			"node_modules/convex/bin/main.js",
			"run",
			"--inline-query",
			'return (await ctx.db.query("accounts").collect()).map(({id,name,email,totpSecretEnc}) => ({id,name,email,totpSecretEnc}));',
		],
		{ encoding: "utf8" },
	),
);
const key = hkdfSync(
	"sha256",
	Buffer.from(readFileSync(keyFile, "utf8").trim(), "base64"),
	"",
	"anchor/2fa/encrypt",
	32,
);
function totp(encrypted) {
	const [version, iv, tag, data] = encrypted.split(".");
	assert.equal(version, "v1");
	const cipher = createDecipheriv(
		"aes-256-gcm",
		Buffer.from(key),
		Buffer.from(iv, "base64url"),
	);
	cipher.setAuthTag(Buffer.from(tag, "base64url"));
	const decoded = Buffer.concat([
		cipher.update(Buffer.from(data, "base64url")),
		cipher.final(),
	]).toString("utf8");
	const bytes = [];
	let bits = 0,
		value = 0;
	for (const c of decoded) {
		value = (value << 5) | "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(c);
		bits += 5;
		if (bits >= 8) {
			bytes.push((value >>> (bits - 8)) & 255);
			bits -= 8;
		}
	}
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
	const hash = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
	return String(
		(hash.readUInt32BE(hash.at(-1) & 15) & 0x7fff_ffff) % 1_000_000,
	).padStart(6, "0");
}
async function signIn(name) {
	const account = accounts.find((row) => row.name === name);
	const login = await request("auth/login", "POST", {
		email: account.email,
		password: "native-auth-fixture-password",
	});
	assert.equal(login.status, 401);
	const { challenge } = await login.json();
	const factor = await request("auth/login/2fa", "POST", {
		challenge,
		code: totp(account.totpSecretEnc),
	});
	assert.equal(factor.status, 200);
	return factor.json();
}

const [admin, member] = await Promise.all([signIn("Owner"), signIn("Reader")]);
try {
	if (oidc) {
		const path = "admin/settings/oidc";
		assert.equal((await request(path, "GET")).status, 401);
		assert.equal(
			(await request(path, "GET", undefined, member.access_token)).status,
			403,
		);
		assert.equal(
			(await request(path, "PATCH", { enabled: true }, member.access_token))
				.status,
			403,
		);
		const get = async () => {
			const response = await request(
				path,
				"GET",
				undefined,
				admin.access_token,
			);
			assert.equal(response.status, 200);
			const settings = await response.json();
			assert.ok(!Object.hasOwn(settings, "clientSecret"));
			return settings;
		};
		const set = (patch) => request(path, "PATCH", patch, admin.access_token);
		const before = await get();
		assert.equal(before.enabled, false);
		assert.equal(before.isLocked, false);
		assert.equal(
			(await set({ issuerUrl: "https://user:password@provider.example.test" }))
				.status,
			400,
		);
		assert.equal((await set({ unexpected: true })).status, 400);
		const secret = "synthetic-oidc-secret";
		try {
			const updated = await set({
				enabled: true,
				providerName: "Fixture SSO",
				issuerUrl: "https://provider.example.test/tenant",
				clientId: "anchor-fixture",
				clientSecret: secret,
				disableInternalAuth: true,
			});
			assert.equal(updated.status, 200);
			assert.ok(!(await updated.text()).includes(secret));
			const saved = await get();
			assert.equal(saved.enabled, true);
			assert.equal(saved.providerName, "Fixture SSO");
			assert.equal(saved.issuerUrl, "https://provider.example.test/tenant");
			assert.equal(saved.clientId, "anchor-fixture");
			assert.equal(saved.hasClientSecret, true);
			assert.equal(saved.disableInternalAuth, true);
			assert.equal(saved.source, "database");
			assert.ok(saved.callbackUrl.endsWith("/api/auth/oidc/callback"));
			assert.equal(
				(await set({ clearClientSecret: true, clientSecret: "ignored" }))
					.status,
				200,
			);
			assert.equal((await get()).hasClientSecret, false);

			const vars = {
				OIDC_ENABLED: "true",
				OIDC_ISSUER_URL: "https://locked.example.test",
				OIDC_CLIENT_ID: "locked",
			};
			const cli = (args) =>
				execFileSync(
					process.execPath,
					[
						`--env-file=${env}`,
						"node_modules/convex/bin/main.js",
						"env",
						...args,
					],
					{ stdio: "ignore", timeout: 10000 },
				);
			try {
				for (const [name, value] of Object.entries(vars))
					cli(["set", name, value]);
				const locked = await get();
				assert.equal(locked.issuerUrl, vars.OIDC_ISSUER_URL);
				assert.equal(locked.clientId, vars.OIDC_CLIENT_ID);
				assert.equal(locked.source, "env");
				assert.equal(locked.isLocked, true);
				assert.equal((await set({ enabled: false })).status, 403);
			} finally {
				for (const name of Object.keys(vars)) cli(["remove", name]);
			}
			assert.equal((await get()).providerName, "Fixture SSO");
		} finally {
			assert.equal(
				(
					await set({
						enabled: false,
						providerName: before.providerName,
						issuerUrl: before.issuerUrl ?? "",
						clientId: before.clientId ?? "",
						disableInternalAuth: false,
						clearClientSecret: true,
					})
				).status,
				200,
			);
		}
		console.log(
			JSON.stringify({
				administratorOnly: true,
				secretRedacted: true,
				settingsPersisted: true,
				envTakesPrecedence: true,
			}),
		);
	} else if (deletion) {
		const selfDeletion = await request(
			"auth/delete-account",
			"POST",
			{
				password: "native-auth-fixture-password",
			},
			admin.access_token,
		);
		assert.equal(selfDeletion.status, 409);
		const adminPath = "admin/users/" + admin.user.id;
		const lastAdmin = await request(
			adminPath,
			"DELETE",
			undefined,
			admin.access_token,
		);
		assert.equal(lastAdmin.status, 400);
		assert.equal(
			(await request("auth/me", "GET", undefined, admin.access_token)).status,
			200,
		);

		assert.equal(
			(await (await request("auth/registration-mode", "GET")).json()).mode,
			"review",
		);
		const email = "admin-delete-" + crypto.randomUUID() + "@example.test";
		const registration = await request("auth/register", "POST", {
			name: "Administrative deletion fixture",
			email,
			password: "synthetic-delete-account",
		});
		assert.equal(registration.status, 201);
		const { user } = await registration.json();
		assert.equal(user.status, "pending");
		const path = "admin/users/" + user.id;
		assert.equal(
			(await request(path, "DELETE", undefined, member.access_token)).status,
			403,
		);
		const deleted = await request(
			path,
			"DELETE",
			undefined,
			admin.access_token,
		);
		assert.equal(deleted.status, 200);
		assert.deepEqual(await deleted.json(), {
			message: "User deleted successfully",
		});
		assert.equal(
			(await request(path, "DELETE", undefined, admin.access_token)).status,
			404,
		);
		console.log(
			JSON.stringify({
				lastAdministratorProtected: true,
				pendingAccountDeleted: user.id,
			}),
		);
	} else if (signup) {
		const path = "admin/settings/registration";
		assert.equal(
			(await request(path, "PATCH", { mode: "review" }, member.access_token))
				.status,
			403,
		);
		const set = async (mode) => {
			const res = await request(path, "PATCH", { mode }, admin.access_token);
			assert.equal(res.status, 200);
			assert.deepEqual(await res.json(), {
				mode,
				isLocked: false,
				source: "database",
			});
			assert.deepEqual(
				await (await request("auth/registration-mode", "GET")).json(),
				{ mode },
			);
		};
		const registration = {
			email: "review-" + crypto.randomUUID() + "@example.test",
			name: "Review fixture",
			password: "fixture-password-for-signup",
		};
		const register = (data) => request("auth/register", "POST", data);
		await set("disabled");
		assert.equal((await register(registration)).status, 403);
		await set("review");
		const pending = await Promise.all([1, 2].map(() => register(registration)));
		assert.deepEqual(pending.map(({ status }) => status).sort(), [201, 409]);
		const review = await pending.find((response) => response.ok).json();
		assert.equal(review.user.status, "pending");
		assert.equal(review.access_token, undefined);
		assert.equal(review.user.isAdmin, false);
		await set("enabled");
		const active = await register({
			...registration,
			email: "active-" + registration.email,
		});
		assert.equal(active.status, 201);
		const enrolled = await active.json();
		assert.equal(enrolled.user.status, "active");
		assert.equal(enrolled.twoFactorSetupRequired, true);
		assert.equal(enrolled.access_token, undefined);
		await set("review");
		console.log(
			JSON.stringify({
				modes: 3,
				duplicateDenied: true,
				reviewPending: true,
				requiredEnrollment: true,
			}),
		);
	} else if (passwordReset) {
		const reader = accounts.find(({ name }) => name === "Reader");
		const path = "admin/users/" + reader.id + "/reset-password";
		const password = "native-auth-fixture-password";
		const login = (value) =>
			request("auth/login", "POST", { email: reader.email, password: value });
		assert.equal(
			(await request(path, "POST", {}, member.access_token)).status,
			403,
		);
		assert.equal(
			(
				await request(
					"admin/users/absent/reset-password",
					"POST",
					{},
					admin.access_token,
				)
			).status,
			404,
		);
		assert.equal(
			(
				await request(
					path,
					"POST",
					{ newPassword: "short" },
					admin.access_token,
				)
			).status,
			400,
		);
		const oldChallenge = await (await login(password)).json();
		const generated = await request(path, "POST", {}, admin.access_token);
		assert.equal(generated.status, 201);
		const body = await generated.json();
		assert.ok(body.newPassword.length >= 16);
		assert.equal(generated.headers.get("cache-control"), "no-store");
		try {
			assert.equal(
				(await request("auth/me", "GET", undefined, member.access_token))
					.status,
				401,
			);
			assert.equal(
				(
					await request("auth/refresh", "POST", {
						refresh_token: member.refresh_token,
					})
				).status,
				401,
			);
			assert.equal(
				(
					await request("auth/login/2fa", "POST", {
						challenge: oldChallenge.challenge,
						code: totp(reader.totpSecretEnc),
					})
				).status,
				401,
			);
			assert.equal(
				(await (await login(password)).json()).code,
				"INVALID_CREDENTIALS",
			);
			const authenticated = await (await login(body.newPassword)).json();
			assert.equal(authenticated.twoFactorRequired, true);
			assert.equal(authenticated.access_token, undefined);
		} finally {
			const restored = await request(
				path,
				"POST",
				{ newPassword: password },
				admin.access_token,
			);
			assert.equal(restored.status, 201);
			assert.equal((await restored.json()).newPassword, undefined);
		}
		assert.equal(
			(await (await login(password)).json()).twoFactorRequired,
			true,
		);
		console.log(
			JSON.stringify({
				generatedPassword: true,
				suppliedPassword: true,
				accessAndRefreshRevoked: true,
				mfaPreserved: true,
			}),
		);
	} else if (management) {
		const user = accounts.find(({ name }) => name === "Outsider");
		const reader = accounts.find(({ name }) => name === "Reader");
		const owner = accounts.find(({ name }) => name === "Owner");
		const path = "admin/users/" + user.id;
		const edit = "admin/users/" + reader.id;
		assert.equal(
			(await request(path + "/approve", "POST", undefined, member.access_token))
				.status,
			403,
		);
		assert.equal(
			(
				await request(
					"admin/users/absent/approve",
					"POST",
					undefined,
					admin.access_token,
				)
			).status,
			404,
		);
		const password = "native-auth-fixture-password";
		assert.equal(
			(await request("auth/login", "POST", { email: user.email, password }))
				.status,
			403,
		);
		const responses = await Promise.all(
			[1, 2].map(() =>
				request(path + "/approve", "POST", undefined, admin.access_token),
			),
		);
		assert.deepEqual(responses.map(({ status }) => status).sort(), [201, 400]);
		const approved = await responses.find((response) => response.ok).json();
		assert.equal(approved.id, user.id);
		assert.equal(approved.status, "active");
		assert.equal(approved.passwordHash, undefined);
		assert.equal(
			(await request(path + "/approve", "POST", undefined, admin.access_token))
				.status,
			400,
		);
		const login = await request("auth/login", "POST", {
			email: user.email,
			password,
		});
		assert.equal(login.status, 403);
		const gate = await login.json();
		assert.equal(gate.twoFactorSetupRequired, true);
		assert.equal(gate.access_token, undefined);
		assert.equal(
			(await request(edit, "PATCH", { name: "Denied" }, member.access_token))
				.status,
			403,
		);
		assert.equal(
			(await request(edit, "PATCH", { email: owner.email }, admin.access_token))
				.status,
			409,
		);
		assert.equal(
			(
				await request(
					edit,
					"PATCH",
					{ passwordHash: "unexpected" },
					admin.access_token,
				)
			).status,
			400,
		);
		assert.equal(
			(
				await request(
					"admin/users/" + owner.id,
					"PATCH",
					{ isAdmin: false },
					admin.access_token,
				)
			).status,
			400,
		);
		const changed = await request(
			edit,
			"PATCH",
			{ name: " Reader verified " },
			admin.access_token,
		);
		assert.equal(changed.status, 200);
		assert.equal((await changed.json()).name, "Reader verified");
		const current = await (
			await request("auth/me", "GET", undefined, member.access_token)
		).json();
		assert.equal(current.name, "Reader verified");
		assert.equal(
			(await request(edit, "PATCH", { name: "Reader" }, admin.access_token))
				.status,
			200,
		);
		console.log(
			JSON.stringify({
				approvalWins: 1,
				enrollmentEnforced: true,
				edit: true,
				adminOnly: true,
				duplicateEmailDenied: true,
			}),
		);
	} else if (directory) {
		assert.equal(
			(await request("admin/users", "GET", undefined, member.access_token))
				.status,
			403,
		);
		const list = (params = "") =>
			request("admin/users" + params, "GET", undefined, admin.access_token);
		const active = await (await list("?status=active&take=1&skip=1")).json();
		assert.equal(active.total, 2);
		assert.equal(active.users.length, 1);
		assert.equal(active.skip, 1);
		const filtered = await (await list("?q=OwNeR&status=active")).json();
		assert.equal(filtered.total, 1);
		const [owner] = filtered.users;
		assert.equal(owner.name, "Owner");
		assert.equal(owner.twoFactor, "both");
		assert.equal(owner.hasPassword, true);
		assert.deepEqual(owner._count, { notes: 1, tags: 0 });
		assert.equal(owner.passwordHash, undefined);
		assert.equal(owner.totpSecretEnc, undefined);
		const pending = await (
			await request("admin/users/pending", "GET", undefined, admin.access_token)
		).json();
		assert.deepEqual(
			pending.map(({ name, authMethod, status }) => ({
				name,
				authMethod,
				status,
			})),
			[{ name: "Outsider", authMethod: "oidc", status: "pending" }],
		);
		console.log(
			JSON.stringify({
				directory: true,
				filtered: true,
				counts: true,
				pendingQueue: true,
				scopes: true,
			}),
		);
	} else if (reset) {
		const reader = accounts.find((row) => row.name === "Reader");
		const path = resetPath(reader.id);
		assert.equal(
			(await request(path, "POST", undefined, member.access_token)).status,
			403,
		);
		assert.equal(
			(
				await request(
					resetPath("absent"),
					"POST",
					undefined,
					admin.access_token,
				)
			).status,
			404,
		);
		const oldChallenge = await (
			await request("auth/login", "POST", {
				email: reader.email,
				password: "native-auth-fixture-password",
			})
		).json();
		const changed = await request(path, "POST", undefined, admin.access_token);
		assert.equal(changed.status, 200);
		assert.deepEqual(await changed.json(), { message: "Two-factor reset" });
		assert.equal(
			(await request("auth/me", "GET", undefined, member.access_token)).status,
			401,
		);
		assert.equal(
			(
				await request("auth/refresh", "POST", {
					refresh_token: member.refresh_token,
				})
			).status,
			401,
		);
		assert.equal(
			(
				await request("auth/login/2fa", "POST", {
					challenge: oldChallenge.challenge,
					code: totp(reader.totpSecretEnc),
				})
			).status,
			401,
		);
		const next = await request("auth/login", "POST", {
			email: reader.email,
			password: "native-auth-fixture-password",
		});
		assert.equal(next.status, 403);
		assert.equal((await next.json()).twoFactorSetupRequired, true);
		const status = await (
			await request(policyPath, "GET", undefined, admin.access_token)
		).json();
		assert.deepEqual(status.coverage, { covered: 1, total: 2 });
		console.log(
			JSON.stringify({
				reset: true,
				sessionsRevoked: true,
				challengeRejected: true,
				policyStillRequired: true,
			}),
		);
	} else {
		assert.equal(
			(await request(policyPath, "GET", undefined, member.access_token)).status,
			403,
		);
		assert.equal(
			(
				await request(
					policyPath,
					"PATCH",
					{ policy: "optional" },
					member.access_token,
				)
			).status,
			403,
		);
		const before = await request(
			policyPath,
			"GET",
			undefined,
			admin.access_token,
		);
		assert.equal(before.status, 200);
		assert.deepEqual(await before.json(), {
			policy: "everyone",
			isLocked: false,
			available: { totp: true, passkeys: false },
			coverage: { covered: 2, total: 2 },
		});
		assert.equal(
			(
				await request(
					policyPath,
					"PATCH",
					{ policy: "invalid" },
					admin.access_token,
				)
			).status,
			400,
		);
		for (const policy of ["optional", "admins", "everyone"]) {
			const patch = await request(
				policyPath,
				"PATCH",
				{ policy },
				admin.access_token,
			);
			assert.equal(patch.status, 200);
			assert.equal((await patch.json()).policy, policy);
			const readerStatus = await request(
				"auth/2fa",
				"GET",
				undefined,
				member.access_token,
			);
			assert.equal((await readerStatus.json()).policy, policy);
		}
	}
} finally {
	await Promise.all(
		[admin, member].map((session) =>
			request("auth/logout", "POST", { refreshToken: session.refresh_token }),
		),
	);
}
if (
	!reset &&
	!directory &&
	!management &&
	!passwordReset &&
	!signup &&
	!deletion &&
	!oidc
)
	console.log(
		JSON.stringify({
			anonymousDenied: true,
			memberDenied: true,
			policiesPersisted: 3,
			covered: 2,
			total: 2,
		}),
	);
