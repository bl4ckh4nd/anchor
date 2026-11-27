import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
const [env] = process.argv.slice(2);
const origin = "http://127.0.0.1:3727";
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
const password = "native-auth-fixture-password";
const call = (path, body, token) =>
	fetch(origin + "/api/auth/" + path, {
		method: body === undefined ? "GET" : "POST",
		headers: {
			"Content-Type": "application/json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify(body),
	});
const login = await call("login", { email, password });
assert.equal(login.status, 403);
const gate = await login.json();
assert.equal(gate.twoFactorSetupRequired, true);
assert.equal(gate.access_token, undefined);
assert.equal(gate.methods.totp, true);
assert.equal(
	(await call("enroll/totp/setup", { challenge: "a".repeat(128) })).status,
	401,
);
const setup = await call("enroll/totp/setup", { challenge: gate.challenge });
assert.equal(setup.status, 200);
const { secret } = await setup.json();
let value = 0,
	bits = 0;
const bytes = [];
for (const char of secret) {
	value = (value << 5) | "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(char);
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
	(hash.readUInt32BE(hash.at(-1) & 15) & 0x7fff_ffff) % 1_000_000,
).padStart(6, "0");
const request = { challenge: gate.challenge, code };
const results = await Promise.all([
	call("enroll/totp/enable", request),
	call("enroll/totp/enable", request),
]);
assert.deepEqual(results.map((item) => item.status).sort(), [200, 401]);
const session = await results.find((item) => item.ok).json();
assert.equal(session.recoveryCodes.length, 10);
const status = await (
	await call("2fa", undefined, session.access_token)
).json();
assert.equal(status.policy, "everyone");
assert.equal(status.totp.enabled, true);
assert.equal(
	(
		await call(
			"2fa/disable",
			{ password, recoveryCode: session.recoveryCodes[0] },
			session.access_token,
		)
	).status,
	403,
);
await call("logout", { refreshToken: session.refresh_token });
console.log(
	JSON.stringify({
		importedPolicy: status.policy,
		sessionWithEnrolledFactor: true,
		concurrentEnableWins: 1,
		removalDenied: true,
	}),
);
