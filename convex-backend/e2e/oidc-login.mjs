import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout } from "node:timers/promises";
import { createServer } from "node:https";
import { readFileSync } from "node:fs";
import {
	createHash,
	generateKeyPairSync,
	randomBytes,
	randomUUID,
	sign,
} from "node:crypto";

const [origin, cert, key, androidEnv] = process.argv.slice(2);
assert.ok(
	[
		"http://127.0.0.1:3735",
		"http://127.0.0.1:3737",
		"http://127.0.0.1:3987",
	].includes(origin),
);
const issuer = "https://host.containers.internal:3742";
const api = origin + "/api/auth/oidc/";
const clientId = "anchor-local-fixture";
const clientSecret = "oidc-synthetic-client-secret";
const name = "OIDC fixture";
const email = `oidc-${randomUUID()}@example.test`;
const subject = randomUUID();
const linkedEmail = `oidc-link-${randomUUID()}@example.test`;
const linkedSubject = randomUUID();
const wrongKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
const callback = api + "callback";
const codes = new Map();
const tokens = new Set();
const legacyTokens = new Map();
const { publicKey, privateKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
});
const jwk = {
	...publicKey.export({ format: "jwk" }),
	kid: "fixture-provider",
	use: "sig",
	alg: "RS256",
};
const b64 = (data) => Buffer.from(JSON.stringify(data)).toString("base64url");
const hash = (value) => createHash("sha256").update(value).digest("base64url");
function jwt(payload, key = privateKey) {
	const data = b64({ alg: "RS256", kid: jwk.kid }) + "." + b64(payload);
	return (
		data +
		"." +
		sign("RSA-SHA256", Buffer.from(data), key).toString("base64url")
	);
}
const server = createServer(
	{ cert: readFileSync(cert), key: readFileSync(key) },
	async (request, response) => {
		const url = new URL(request.url, issuer);
		const json = (value, status = 200) =>
			response
				.writeHead(status, {
					"Content-Type": "application/json",
					"Cache-Control": "no-store",
				})
				.end(JSON.stringify(value));
		try {
			if (url.pathname === "/.well-known/openid-configuration")
				return json({
					issuer,
					authorization_endpoint: issuer + "/authorize",
					token_endpoint: issuer + "/token",
					introspection_endpoint: issuer + "/introspect",
					introspection_endpoint_auth_methods_supported: ["client_secret_post"],
					jwks_uri: issuer + "/jwks",
					userinfo_endpoint: issuer + "/userinfo",
					response_types_supported: ["code"],
					code_challenge_methods_supported: ["S256"],
					subject_types_supported: ["public"],
					id_token_signing_alg_values_supported: ["RS256"],
					token_endpoint_auth_methods_supported: ["client_secret_post"],
				});
			if (url.pathname === "/jwks") return json({ keys: [jwk] });
			if (url.pathname === "/authorize") {
				const p = url.searchParams;
				assert.equal(p.get("client_id"), clientId);
				assert.equal(p.get("redirect_uri"), callback);
				assert.equal(p.get("response_type"), "code");
				assert.equal(p.get("code_challenge_method"), "S256");
				assert.ok(p.get("nonce"));
				const code = randomUUID();
				codes.set(code, {
					challenge: p.get("code_challenge"),
					nonce: p.get("nonce"),
					scenario: p.get("fixture"),
				});
				const redirect = new URL(callback);
				redirect.search = new URLSearchParams({ code, state: p.get("state") });
				return response.writeHead(302, { Location: redirect.href }).end();
			}
			if (url.pathname === "/token") {
				const chunks = [];
				for await (const chunk of request) chunks.push(chunk);
				const body = new URLSearchParams(Buffer.concat(chunks).toString());
				assert.equal(body.get("client_id"), clientId);
				assert.equal(body.get("client_secret"), clientSecret);
				assert.equal(body.get("redirect_uri"), callback);
				const record = codes.get(body.get("code"));
				if (!record || hash(body.get("code_verifier")) !== record.challenge)
					return json({ error: "invalid_grant" }, 400);
				codes.delete(body.get("code"));
				const access = randomUUID();
				tokens.add(access);
				const iat = Math.floor(Date.now() / 1000);
				return json({
					token_type: "Bearer",
					access_token: access,
					id_token: jwt(
						{
							iss: issuer,
							aud: clientId,
							sub:
								record.scenario === "link"
									? linkedSubject
									: record.scenario === "conflict"
										? randomUUID()
										: subject,
							iat,
							exp: iat + 300,
							nonce: record.scenario === "nonce" ? "wrong-nonce" : record.nonce,
							email: ["link", "conflict"].includes(record.scenario)
								? linkedEmail
								: email,
							email_verified: record.scenario !== "email",
							name,
						},
						record.scenario === "signature" ? wrongKey : privateKey,
					),
				});
			}
			if (url.pathname === "/introspect") {
				const chunks = [];
				for await (const chunk of request) chunks.push(chunk);
				const body = new URLSearchParams(Buffer.concat(chunks).toString());
				assert.equal(body.get("client_id"), clientId);
				assert.equal(body.get("client_secret"), clientSecret);
				const token = legacyTokens.get(body.get("token"));
				return json(
					token
						? {
								active: true,
								iss: issuer,
								sub: subject,
								client_id:
									token === "missing-client"
										? undefined
										: token === "foreign-client"
											? "another-client"
											: clientId,
							}
						: { active: false },
				);
			}
			if (url.pathname === "/userinfo") {
				const access = request.headers.authorization?.split(" ")[1];
				const legacy = legacyTokens.get(access);
				if (legacy)
					return json({
						sub: legacy === "different-subject" ? randomUUID() : subject,
						email,
						email_verified: legacy !== "unverified-email",
						name,
					});
				if (!tokens.has(access)) return json({ error: "invalid_token" }, 401);
				return json({ sub: subject, email, name });
			}
			return json({}, 404);
		} catch (error) {
			console.error(error.name);
			return json({ error: "invalid_request" }, 400);
		}
	},
);

await new Promise((resolve, reject) =>
	server.listen(3742, "0.0.0.0", resolve).once("error", reject),
);
try {
	const get = (url, cookie) =>
		fetch(url, {
			redirect: "manual",
			headers: cookie ? { Cookie: cookie } : {},
			signal: AbortSignal.timeout(15000),
		});
	const post = (url, data, cookie) =>
		fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(cookie ? { Cookie: cookie } : {}),
			},
			body: JSON.stringify(data),
			signal: AbortSignal.timeout(15000),
		});
	const config = await get(api + "config");
	assert.equal(config.status, 200);
	const publicConfig = await config.json();
	assert.equal(publicConfig.enabled, true);
	assert.equal(publicConfig.clientId, clientId);
	assert.ok(!JSON.stringify(publicConfig).includes(clientSecret));

	async function begin(redirect = "/notes", scenario = "", challenge) {
		const start = await get(
			api +
				"initiate?" +
				new URLSearchParams({
					redirect,
					...(challenge ? { mobile_challenge: challenge } : {}),
				}),
		);
		assert.equal(start.status, 302, await start.clone().text());
		const cookie = start.headers.get("set-cookie");
		assert.match(cookie, /HttpOnly/i);
		assert.match(cookie, /SameSite=Lax/i);
		const localProvider = new URL(start.headers.get("location"));
		assert.equal(localProvider.origin, issuer);
		localProvider.hostname = "127.0.0.1";
		localProvider.searchParams.set("fixture", scenario);
		const accepted = await get(localProvider);
		assert.equal(accepted.status, 302);
		return {
			cookie: cookie.split(";")[0],
			location: accepted.headers.get("location"),
		};
	}
	const flow = await begin();
	const noCookie = new URL((await get(flow.location)).headers.get("location"));
	assert.equal(noCookie.searchParams.has("code"), false);
	const returned = await get(flow.location, flow.cookie);
	assert.equal(returned.status, 302);
	assert.equal(returned.headers.get("Referrer-Policy"), "no-referrer");
	const done = new URL(returned.headers.get("location"));
	assert.equal(done.origin, origin);
	assert.equal(done.pathname, "/login");
	assert.equal(done.searchParams.get("redirect"), "/notes");
	assert.ok(
		!done.searchParams.has("access_token") &&
			!done.searchParams.has("refresh_token"),
	);
	const code = done.searchParams.get("code");
	assert.ok(code);
	assert.equal(
		new URL(
			(await get(flow.location, flow.cookie)).headers.get("location"),
		).searchParams.has("code"),
		false,
	);
	assert.equal((await post(api + "exchange", { code })).status, 400);
	const sessionResponse = await post(api + "exchange", { code }, flow.cookie);
	assert.equal(
		sessionResponse.status,
		200,
		await sessionResponse.clone().text(),
	);
	const session = await sessionResponse.json();
	assert.ok(session.access_token && session.refresh_token);
	assert.equal(session.user.email, email);
	assert.equal(session.user.hasPassword, false);
	assert.equal(
		(await post(api + "exchange", { code }, flow.cookie)).status,
		400,
	);
	const me = await fetch(origin + "/api/auth/me", {
		headers: { Authorization: `Bearer ${session.access_token}` },
	});
	assert.equal(me.status, 200);
	assert.equal((await me.json()).id, session.user.id);
	const refresh = await post(origin + "/api/auth/refresh", {
		refresh_token: session.refresh_token,
	});
	assert.equal(refresh.status, 200);
	const another = await begin("//other.example.test");
	const recovered = new URL(
		(await get(another.location, another.cookie)).headers.get("location"),
	);
	assert.equal(recovered.searchParams.get("redirect"), "/");
	const repeat = await (
		await post(
			api + "exchange",
			{ code: recovered.searchParams.get("code") },
			another.cookie,
		)
	).json();
	assert.equal(repeat.user.id, session.user.id);
	for (const scenario of ["nonce", "email", "signature"]) {
		const invalid = await begin("/", scenario);
		const result = new URL(
			(await get(invalid.location, invalid.cookie)).headers.get("location"),
		);
		assert.equal(result.searchParams.has("code"), false);
		assert.ok(result.searchParams.has("error"));
	}

	const verifier = randomBytes(32).toString("hex");
	const mobileChallenge = createHash("sha256").update(verifier).digest("hex");
	const mobile = await begin("/", "", mobileChallenge);
	const handoff = new URL(
		(await get(mobile.location, mobile.cookie)).headers.get("location"),
	);
	assert.equal(handoff.protocol, "com.zhfahim.anchor.compose:");
	assert.equal(handoff.hostname, "oidc");
	assert.equal(handoff.pathname, "/callback");
	assert.deepEqual([...handoff.searchParams.keys()], ["code"]);
	const mobileCode = handoff.searchParams.get("code");
	assert.equal(
		(await post(api + "exchange", { code: mobileCode }, mobile.cookie)).status,
		400,
	);
	const mobileExchange = (code, proof) =>
		post(api + "exchange/compose", { code, verifier: proof });
	assert.equal(
		(await mobileExchange(mobileCode, randomBytes(32).toString("hex"))).status,
		400,
	);
	const mobileResponse = await mobileExchange(mobileCode, verifier);
	assert.equal(mobileResponse.status, 200);
	const mobileSession = await mobileResponse.json();
	assert.equal(mobileSession.user.id, session.user.id);
	assert.equal((await mobileExchange(mobileCode, verifier)).status, 400);

	const webFlow = await begin();
	const webCode = new URL(
		(await get(webFlow.location, webFlow.cookie)).headers.get("location"),
	).searchParams.get("code");
	assert.equal((await mobileExchange(webCode, verifier)).status, 400);
	assert.equal(
		(await post(api + "exchange", { code: webCode }, webFlow.cookie)).status,
		200,
	);

	const local = await post(origin + "/api/auth/register", {
		email: linkedEmail,
		name: "Local fixture",
		password: "SyntheticLocalLink2026!",
	});
	assert.equal(local.status, 201);
	const localSession = await local.json();
	const exchange = async (scenario) => {
		const pending = await begin("/", scenario);
		const result = new URL(
			(await get(pending.location, pending.cookie)).headers.get("location"),
		);
		return post(
			api + "exchange",
			{ code: result.searchParams.get("code") },
			pending.cookie,
		);
	};
	const linked = await exchange("link");
	assert.equal(linked.status, 200);
	const linkedSession = await linked.json();
	assert.equal(linkedSession.user.id, localSession.user.id);
	assert.equal(linkedSession.user.hasPassword, true);
	assert.equal((await exchange("conflict")).status, 409);
	const legacyExchange = (access_token) =>
		post(api + "exchange/mobile", { access_token });
	assert.equal((await post(api + "exchange/mobile", {})).status, 400);
	assert.equal((await legacyExchange(randomUUID())).status, 401);
	for (const scenario of [
		"foreign-client",
		"missing-client",
		"different-subject",
		"unverified-email",
	]) {
		const token = randomUUID();
		legacyTokens.set(token, scenario);
		assert.equal((await legacyExchange(token)).status, 401, scenario);
	}
	const legacyToken = randomUUID();
	legacyTokens.set(legacyToken, "valid");
	const legacyResponse = await legacyExchange(legacyToken);
	assert.equal(legacyResponse.status, 200);
	const legacySession = await legacyResponse.json();
	assert.equal(legacySession.user.id, session.user.id);
	assert.equal(legacySession.redirectUrl, "/");
	assert.equal(
		(
			await post(origin + "/api/auth/refresh", {
				refresh_token: legacySession.refresh_token,
			})
		).status,
		200,
	);

	legacyTokens.delete(legacyToken);
	assert.equal((await legacyExchange(legacyToken)).status, 401);

	const browserRunner = process.env.ANCHOR_TEST_OIDC_BROWSER_RUNNER;
	if (browserRunner) {
		await promisify(execFile)("bash", [browserRunner, origin], {
			timeout: 120_000,
		});
	}

	const providerPassword = await fetch(origin + "/api/auth/change-password", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${session.access_token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			currentPassword: "placeholder",
			newPassword: "TestUnchanged2026!",
		}),
	});
	assert.equal(providerPassword.status, 400);
	const deleteOidc = await fetch(origin + "/api/auth/delete-account", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${session.access_token}`,
			"Content-Type": "application/json",
		},
		body: "{}",
	});
	assert.equal(deleteOidc.status, 200);
	assert.equal(
		(
			await fetch(origin + "/api/auth/me", {
				headers: { Authorization: `Bearer ${repeat.access_token}` },
			})
		).status,
		401,
	);

	await post(origin + "/api/auth/logout", {
		refreshToken: linkedSession.refresh_token,
	});
	await post(origin + "/api/auth/logout", {
		refreshToken: localSession.refresh_token,
	});

	if (androidEnv) {
		const app = "com.zhfahim.anchor.compose";
		const tunnel = "tcp:3737";
		const adb = (...args) =>
			execFileSync("adb", args, { encoding: "utf8", timeout: 30000 });
		const shell = (...args) => adb("shell", ...args);
		const launch = () =>
			shell("am", "start", "-W", "-n", app + "/anchor.AnchorActivity");
		const find = (text, last = false) => {
			shell("uiautomator", "dump", "/data/local/tmp/anchor-oidc.xml");
			const xml = shell("cat", "/data/local/tmp/anchor-oidc.xml");
			const nodes = [...xml.matchAll(/<node [^>]+>/g)].map(([tag]) => tag);
			return (last ? nodes.reverse() : nodes).find(
				(tag) =>
					tag.includes(`package="${app}"`) &&
					(tag.includes(`text="${text}"`) ||
						tag.includes(`content-desc="${text}"`)),
			);
		};
		const waitFor = async (text, last = false) => {
			for (let attempt = 0; attempt < 12; attempt++) {
				const node = find(text, last);
				if (node) return node;
				await setTimeout(250);
			}
			assert.fail("Missing Android label: " + text);
		};
		const tap = (node) => {
			const [x1, y1, x2, y2] = node
				.match(/bounds="([^"]+)"/)[1]
				.match(/\d+/g)
				.map(Number);
			shell("input", "tap", String((x1 + x2) >> 1), String((y1 + y2) >> 1));
		};
		const fillServer = async () => {
			tap(await waitFor("Server address"));
			shell("input", "keycombination", "113", "29");
			shell("input", "text", origin);
			if (shell("dumpsys", "input_method").includes("mInputShown=true"))
				shell("input", "keyevent", "4");
		};
		const convexEnv = (...args) =>
			execFileSync(
				process.execPath,
				[
					`--env-file=${androidEnv}`,
					"node_modules/convex/bin/main.js",
					"env",
					...args,
				],
				{
					stdio: "ignore",
					timeout: 10000,
					cwd: new URL("../", import.meta.url),
				},
			);
		const challenges = () =>
			JSON.parse(
				execFileSync(
					process.execPath,
					[
						`--env-file=${androidEnv}`,
						"node_modules/convex/bin/main.js",
						"run",
						"--inline-query",
						'return (await ctx.db.query("oidcFlows").order("desc").take(64)).filter(x => x.payload.type === "state" && x.mobileChallenge).map(x => x.mobileChallenge);',
					],
					{
						encoding: "utf8",
						timeout: 10000,
						cwd: new URL("../", import.meta.url),
					},
				),
			);
		const sendLink = (url) =>
			shell(
				"am",
				"start",
				"-W",
				"-a",
				"android.intent.action.VIEW",
				"-d",
				url,
				"-p",
				app,
			);
		assert.ok(
			!adb("reverse", "--list").includes(tunnel),
			"Port 3737 ADB tunnel is already active",
		);
		adb("reverse", tunnel, tunnel);
		try {
			const before = new Set(challenges());
			shell("am", "force-stop", app);
			launch();
			const signOut = find("Sign out");
			const cancel = find("Cancel browser sign-in");
			if (signOut) tap(signOut);
			if (cancel) tap(cancel);
			await fillServer();
			tap(await waitFor("Continue with Fixture SSO"));
			let browserChallenge;
			for (let attempt = 0; attempt < 45; attempt++) {
				browserChallenge = challenges().find(
					(challenge) => !before.has(challenge),
				);
				if (browserChallenge) break;
				await setTimeout(250);
			}
			assert.ok(
				browserChallenge,
				"The Android system browser never started the OIDC request",
			);
			const browserFlow = await begin("/", "", browserChallenge);
			const callback = new URL(
				(await get(browserFlow.location, browserFlow.cookie)).headers.get(
					"location",
				),
			);
			assert.equal(callback.protocol, "com.zhfahim.anchor.compose:");
			const missed = new URL(callback);
			missed.searchParams.set("code", randomBytes(32).toString("hex"));
			sendLink(missed.href);
			await waitFor("Could not complete browser sign-in. Try again.");
			shell("am", "force-stop", app);
			sendLink(callback.href);
			await waitFor("New note");
			shell("am", "force-stop", app);
			launch();
			await waitFor("Sign out");
			tap(await waitFor("Account settings"));
			await waitFor("Name");
			tap(await waitFor("Delete account", true));
			await waitFor("Delete your account?");
			assert.equal(find("Enter your password to confirm."), undefined);
			tap(await waitFor("Delete account", true));
			await waitFor("Account deleted.");
			await waitFor("Sign in");
			convexEnv("set", "DISABLE_INTERNAL_AUTH", "true");
			try {
				shell("am", "force-stop", app);
				launch();
				await fillServer();
				await waitFor("Continue with Fixture SSO");
				assert.equal(find("Password"), undefined);
				assert.equal(find("Create account"), undefined);
				if (process.env.ANCHOR_OIDC_SCREENSHOT) {
					const { writeFileSync } = await import("node:fs");
					writeFileSync(
						process.env.ANCHOR_OIDC_SCREENSHOT,
						execFileSync("adb", ["exec-out", "screencap", "-p"]),
					);
				}
			} finally {
				convexEnv("remove", "DISABLE_INTERNAL_AUTH");
			}

			console.log(
				JSON.stringify({
					androidBrowserStarted: true,
					oidcOnlyHidesPasswordAndSignup: true,
					invalidCodeRejected: true,
					deepLinkAfterProcessStop: true,
					sessionRestoredAfterRestart: true,
					providerAccountDeletedFromCompose: true,
				}),
			);
		} finally {
			adb("reverse", "--remove", tunnel);
		}
	}

	console.log(
		JSON.stringify({
			pkce: true,
			mobileVerifier: true,
			mobileCodeSingleUse: true,
			legacyMobileExchange: true,
			legacyMobileClientBinding: true,
			legacyMobileSubjectAndVerifiedEmail: true,
			legacyMobileRevocation: true,
			nonceVerified: true,
			serverSignatureVerified: true,
			verifiedLocalLink: true,
			providerAccountDeleted: true,
			verifiedEmail: true,
			browserBoundExchange: true,
			sameAccount: true,
			sessionRefresh: true,
		}),
	);
} finally {
	server.close();
}
