import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const env = process.env.ANCHOR_TEST_CONVEX_ENV;
assert.ok(env, "Run inside the disposable native Convex fixture");
const origin = "http://127.0.0.1:" + process.env.ANCHOR_CONVEX_SITE_PORT;
assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
const cli = (...args) =>
	execFileSync(
		process.execPath,
		["node_modules/convex/bin/main.js", ...args, "--env-file", env],
		{ encoding: "utf8" },
	).trim();

async function call(path, status, body, token) {
	const response = await fetch(origin + "/api/auth/" + path, {
		method: body === undefined ? "GET" : "POST",
		headers: {
			...(body === undefined ? {} : { "Content-Type": "application/json" }),
			...(token ? { Authorization: "Bearer " + token } : {}),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(15_000),
	});
	assert.equal(
		response.status,
		status,
		response.status === status
			? path
			: path + ": " + (await response.text()).slice(0, 400),
	);
	return response.json();
}

const user = {
	email: "rotation@example.test",
	password: "RotationFixture2026!",
};
const before = await call("register", 201, {
	...user,
	name: "Rotation fixture",
});
const keyID = (token) =>
	JSON.parse(Buffer.from(token.split(".")[0], "base64url")).kid;
assert.equal(keyID(before.access_token), "anchor-convex");
assert.equal(
	(await call("me", 200, undefined, before.access_token)).id,
	before.user.id,
);

const idle = await call("login", 200, user);
assert.equal(keyID(idle.access_token), "anchor-convex");

const configured = cli("env", "get", "ANCHOR_AUTH_JWKS");
const prefix = "data:application/json;base64,";
assert.ok(configured.startsWith(prefix));
const previous = JSON.parse(
	Buffer.from(configured.slice(prefix.length), "base64").toString("utf8"),
);
const nextID = "anchor-convex-rotation-test";
const { publicKey, privateKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
});
const nextJwk = {
	...publicKey.export({ format: "jwk" }),
	alg: "RS256",
	kid: nextID,
};
function publish(keys) {
	const jwks =
		prefix + Buffer.from(JSON.stringify({ keys })).toString("base64");
	cli("env", "set", "ANCHOR_AUTH_JWKS", jwks);
	cli("deploy", "--yes", "--codegen", "disable");
}
publish([...previous.keys, nextJwk]);
await call("me", 200, undefined, before.access_token);

const directory = mkdtempSync(join(tmpdir(), "anchor-rotation-env."));
try {
	const update = join(directory, "signer.env");
	const pem = privateKey.export({ format: "pem", type: "pkcs8" });
	writeFileSync(
		update,
		`ANCHOR_CONVEX_SIGNING_KEY_ID=${nextID}\nANCHOR_CONVEX_SIGNING_KEY=${JSON.stringify(pem)}\n`,
		{ mode: 0o600 },
	);
	cli("env", "set", "--force", "--from-file", update);
} finally {
	rmSync(directory, { recursive: true });
}

const next = await call("refresh", 200, {
	refresh_token: before.refresh_token,
});
assert.equal(
	keyID(next.access_token),
	nextID,
	"The refresh did not select the new key",
);
assert.equal(
	(await call("me", 200, undefined, next.access_token)).id,
	before.user.id,
);
await call("me", 200, undefined, before.access_token);
const login = await call("login", 200, user);
assert.equal(keyID(login.access_token), nextID);
await call("me", 200, undefined, login.access_token);

publish([nextJwk]);
await call("me", 401, undefined, before.access_token);
await call("me", 200, undefined, next.access_token);
await call("me", 401, undefined, idle.access_token);
const recovered = await call("refresh", 200, {
	refresh_token: idle.refresh_token,
});
assert.equal(keyID(recovered.access_token), nextID);
assert.equal(
	(await call("me", 200, undefined, recovered.access_token)).id,
	before.user.id,
);
const continued = await call("refresh", 200, {
	refresh_token: next.refresh_token,
});
assert.equal(
	(await call("me", 200, undefined, continued.access_token)).id,
	before.user.id,
);

console.log(
	JSON.stringify({
		previousKeyAcceptedDuringOverlap: true,
		refreshSelectedNewKey: true,
		newLoginSelectedNewKey: true,
		retiredKeyRejected: true,
		sessionSurvivedKeyRotation: true,
		idleSessionRefreshedAfterRetirement: true,
	}),
);
