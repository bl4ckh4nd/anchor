import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";

const [origin, adminEnv] = process.argv.slice(2);
assert.equal(origin, "http://127.0.0.1:3719");
const profile = JSON.parse(
	execFileSync(
		process.execPath,
		[
			`--env-file=${adminEnv}`,
			"node_modules/convex/bin/main.js",
			"run",
			"--inline-query",
			'const row = await ctx.db.query("accounts").filter(q => q.eq(q.field("name"), "Owner")).unique(); return {id:row.id,email:row.email};',
		],
		{ encoding: "utf8" },
	),
);
const post = (path, body, token) =>
	fetch(origin + path, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify(body),
	});
async function challenge() {
	const response = await post("/api/auth/login", {
		email: profile.email,
		password: "native-auth-fixture-password",
	});
	assert.equal(response.status, 401);
	const body = await response.json();
	assert.equal(body.twoFactorRequired, true);
	assert.equal(typeof body.challenge, "string");
	assert.equal(body.access_token, undefined);
	return body.challenge;
}
const verify = (challenge, factor) =>
	post("/api/auth/login/2fa", { challenge, ...factor });
const code = () => {
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
	const digest = createHmac("sha1", Buffer.from("12345678901234567890"))
		.update(counter)
		.digest();
	return String(
		(digest.readUInt32BE(digest.at(-1) & 15) & 0x7fff_ffff) % 1_000_000,
	).padStart(6, "0");
};

const left = await challenge();
const right = await challenge();
const totp = code();
const results = await Promise.all([
	verify(left, { code: totp }),
	verify(right, { code: totp }),
]);
assert.deepEqual(results.map((r) => r.status).sort(), [200, 401]);
const accepted = await results.find((r) => r.ok).json();
assert.equal(accepted.user.id, profile.id);
assert.equal(
	(await post("/api/compose/sync", {}, accepted.access_token)).status,
	200,
);
assert.equal((await verify(await challenge(), { code: totp })).status, 401);
const rotated = await post("/api/auth/refresh", {
	refresh_token: accepted.refresh_token,
});
assert.equal(rotated.status, 200);
await post("/api/auth/logout", {
	refreshToken: (await rotated.json()).refresh_token,
});

const recovery = await challenge();
assert.equal(
	(await verify(recovery, { code: totp, recoveryCode: "K7M29-XQP3A" })).status,
	400,
);
assert.equal(
	(await verify(recovery, { recoveryCode: "bbb22-bbb22" })).status,
	401,
);
const res = await verify(recovery, { recoveryCode: " K7M29-XQP3A " });
assert.equal(res.status, 200);
assert.equal(
	(await verify(recovery, { recoveryCode: "k7m29xqp3a" })).status,
	401,
);
const reused = await challenge();
assert.equal(
	(await verify(reused, { recoveryCode: "k7m29xqp3a" })).status,
	401,
);
for (let remaining = 4; remaining > 0; remaining--)
	assert.equal(
		(await verify(reused, { recoveryCode: "bbb22-bbb22" })).status,
		401,
	);
assert.equal((await verify(await challenge(), { code: code() })).status, 429);
console.log(
	JSON.stringify({
		legacyEncryptedTotp: true,
		parallelResults: [200, 401],
		recoverySingleUse: true,
		loginChallengeSingleUse: true,
		lockoutAcrossChallenges: true,
		authenticatedSyncAndRefresh: true,
	}),
);
