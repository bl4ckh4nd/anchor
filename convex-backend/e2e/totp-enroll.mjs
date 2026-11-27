import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";

const [env] = process.argv.slice(2);
const origin = "http://127.0.0.1:3723";
const email = JSON.parse(
	execFileSync(
		process.execPath,
		[
			`--env-file=${env}`,
			"node_modules/convex/bin/main.js",
			"run",
			"--inline-query",
			'return (await ctx.db.query("accounts").filter(q => q.eq(q.field("name"), "Reader")).unique()).email;',
		],
		{ encoding: "utf8" },
	),
);
const call = (path, body, token) =>
	fetch(origin + "/api/auth/" + path, {
		method: body === undefined ? "GET" : "POST",
		headers: {
			"Content-Type": "application/json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify(body),
	});
const login = { email, password: "native-auth-fixture-password" };
const first = await (await call("login", login)).json();
const second = await (await call("login", login)).json();
assert.ok(first.access_token && second.access_token);
assert.equal((await call("2fa/setup", {})).status, 401);
const status = await (await call("2fa", undefined, first.access_token)).json();
assert.equal(status.totp.enabled, false);
const setup = await call("2fa/setup", {}, first.access_token);
assert.equal(setup.status, 200);
const { secret, otpauthUri } = await setup.json();
assert.equal(new URL(otpauthUri).searchParams.get("secret"), secret);
const bytes = [];
let bits = 0,
	value = 0;
for (const character of secret) {
	value = (value << 5) | "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(character);
	bits += 5;
	if (bits >= 8) {
		bytes.push((value >>> (bits - 8)) & 255);
		bits -= 8;
	}
}
const counter = Buffer.alloc(8);
counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
const hash = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
const code = String(
	(hash.readUInt32BE(hash.at(-1) & 15) & 0x7fffffff) % 1_000_000,
).padStart(6, "0");
const confirmations = await Promise.all(
	[first, second].map(({ access_token }) =>
		call("2fa/enable", { code }, access_token),
	),
);
assert.equal(confirmations.filter((result) => result.ok).length, 1);
const enabled = await confirmations.find((result) => result.ok).json();
assert.equal(new Set(enabled.recoveryCodes).size, 10);
assert.equal((await call("me", undefined, enabled.access_token)).status, 200);
const updated = await (
	await call("2fa", undefined, enabled.access_token)
).json();
assert.equal(updated.totp.enabled, true);
assert.equal(updated.totp.recoveryCodesRemaining, 10);
for (const previous of [first, second]) {
	assert.equal(
		(await call("me", undefined, previous.access_token)).status,
		401,
	);
	assert.equal(
		(await call("refresh", { refresh_token: previous.refresh_token })).status,
		401,
	);
}
const challenge = await call("login", login);
assert.equal(challenge.status, 401);
assert.equal((await challenge.json()).twoFactorRequired, true);
await call("logout", { refreshToken: enabled.refresh_token });
console.log(
	JSON.stringify({
		setup: true,
		concurrentEnableWins: 1,
		recoveryCount: 10,
		revokedOldSessions: 2,
	}),
);
