import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";

const [env, origin = "http://127.0.0.1:3723"] = process.argv.slice(2);
assert.ok(["http://127.0.0.1:3719", "http://127.0.0.1:3723"].includes(origin));
const email = JSON.parse(
	execFileSync(
		process.execPath,
		[
			`--env-file=${env}`,
			"node_modules/convex/bin/main.js",
			"run",
			"--inline-query",
			'return (await ctx.db.query("accounts").filter(q => q.eq(q.field("name"), "Owner")).unique()).email;',
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
function hotp(bytes, step) {
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(step));
	const hash = createHmac("sha1", bytes).update(counter).digest();
	return String(
		(hash.readUInt32BE(hash.at(-1) & 15) & 0x7fffffff) % 1_000_000,
	).padStart(6, "0");
}
function decode(secret) {
	const bytes = [];
	let bits = 0,
		value = 0;
	for (const char of secret) {
		value = (value << 5) | "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(char);
		bits += 5;
		if (bits >= 8) {
			bytes.push((value >>> (bits - 8)) & 255);
			bits -= 8;
		}
	}
	return Buffer.from(bytes);
}
const login = await (await call("login", { email, password })).json();
const old = Buffer.from("12345678901234567890");
const step = () => Math.floor(Date.now() / 30_000);
const signed = await call("login/2fa", {
	challenge: login.challenge,
	code: hotp(old, step() - 1),
});
assert.equal(signed.status, 200);
const { access_token: token } = await signed.json();
const regeneration = { password, code: hotp(old, step()) };
assert.equal((await call("2fa/recovery-codes", regeneration)).status, 401);
assert.equal(
	(
		await call(
			"2fa/recovery-codes",
			{ ...regeneration, password: "wrong" },
			token,
		)
	).status,
	403,
);
const rotation = await Promise.all(
	[1, 2].map(() => call("2fa/recovery-codes", regeneration, token)),
);
assert.deepEqual(
	rotation.map((response) => response.status).sort(),
	[200, 400],
);
const { recoveryCodes } = await rotation.find((response) => response.ok).json();
assert.equal(new Set(recoveryCodes).size, 10);
assert.equal((await call("2fa/setup", {}, token)).status, 403);
const setup = await call(
	"2fa/setup",
	{ recoveryCode: recoveryCodes[0] },
	token,
);
assert.equal(setup.status, 200);
const { secret } = await setup.json();
const enabled = await call(
	"2fa/enable",
	{ code: hotp(decode(secret), step()) },
	token,
);
assert.equal(enabled.status, 200);
const updated = await enabled.json();
assert.equal((await call("me", undefined, token)).status, 401);
assert.equal(
	(
		await call(
			"2fa/disable",
			{ password, recoveryCode: recoveryCodes[1] },
			updated.access_token,
		)
	).status,
	400,
);
assert.equal(
	(
		await call(
			"2fa/disable",
			{ password, recoveryCode: updated.recoveryCodes[0] },
			updated.access_token,
		)
	).status,
	200,
);
const status = await (
	await call("2fa", undefined, updated.access_token)
).json();
assert.equal(status.totp.enabled, false);
assert.equal(status.totp.recoveryCodesRemaining, 0);
const passwordOnly = await call("login", { email, password });
assert.equal(passwordOnly.status, 403);
assert.equal((await passwordOnly.json()).code, "ADDITIONAL_FACTOR_REQUIRED");
await call("logout", { refreshToken: updated.refresh_token });
console.log(
	JSON.stringify({
		parallelRegenerationWins: 1,
		replacement: true,
		priorCodesInvalidated: true,
		disabled: true,
	}),
);
