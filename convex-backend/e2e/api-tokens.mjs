import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

const [origin, env] = process.argv.slice(2);
assert.equal(origin, "http://127.0.0.1:3735");
assert.ok(env);
const password = "SyntheticTokenFixture2026!";
const api = (path, method, credential, body) =>
	fetch(origin + "/api/" + path, {
		method,
		headers: {
			...(credential ? { Authorization: `Bearer ${credential}` } : {}),
			"Content-Type": "application/json",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
async function register() {
	const response = await api("auth/register", "POST", null, {
		email: `token-${randomUUID()}@example.test`,
		name: "Token fixture",
		password,
	});
	assert.equal(response.status, 201);
	return response.json();
}
const [owner, peer] = await Promise.all([register(), register()]);
const path = "auth/api-token";
assert.equal((await api(path, "GET")).status, 401);
const status = await api(path, "GET", owner.access_token);
assert.equal(status.status, 200);
assert.equal(status.headers.get("Cache-Control"), "no-store");
assert.deepEqual(await status.json(), { apiToken: null, hasApiToken: false });
const issue = async () => {
	const response = await api(path + "/regenerate", "POST", owner.access_token);
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("Cache-Control"), "no-store");
	const body = await response.json();
	assert.equal(body.hasApiToken, true);
	assert.match(body.apiToken, /^[a-f0-9]{64}$/);
	return body.apiToken;
};
const token = await issue();
assert.deepEqual(await (await api(path, "GET", owner.access_token)).json(), {
	apiToken: null,
	hasApiToken: true,
});
assert.equal((await api(path, "DELETE", token)).status, 401);
assert.equal((await api(path + "/regenerate", "POST", token)).status, 401);
assert.equal((await api("auth/me", "GET", token)).status, 401);
const hash = createHash("sha256").update(token).digest("hex");
const saved = JSON.parse(
	execFileSync(
		process.execPath,
		[
			`--env-file=${env}`,
			"node_modules/convex/bin/main.js",
			"run",
			"--inline-query",
			`const a = await ctx.db.query("accounts").withIndex("by_issuer_id", q => q.eq("issuer","https://anchor-e2e.invalid").eq("id",${JSON.stringify(owner.user.id)})).unique(); return { matches: a.apiTokenHash === ${JSON.stringify(hash)}, leaked: "apiToken" in a };`,
		],
		{ encoding: "utf8", cwd: new URL("../", import.meta.url) },
	),
);
assert.deepEqual(saved, { matches: true, leaked: false });
const [owned, shared] = [randomUUID(), randomUUID()];
for (const [id, user] of [
	[owned, owner],
	[shared, peer],
]) {
	assert.equal(
		(
			await api("compose/notes", "POST", user.access_token, {
				id,
				title: "Token note",
			})
		).status,
		200,
	);
}
const detail = (id, credential) => api("notes/" + id, "GET", credential);
assert.equal((await detail(owned)).status, 401);
assert.equal((await detail(shared, token)).status, 404);
const response = await detail(owned, token);
assert.equal(response.status, 200);
const note = await response.json();
assert.equal(note.id, owned);
assert.equal(note.userId, owner.user.id);
assert.equal(note.permission, "owner");
assert.ok(!Number.isNaN(Date.parse(note.createdAt)));
assert.deepEqual(await (await detail(owned, owner.access_token)).json(), note);
const share = await fetch("http://127.0.0.1:3734/api/mutation", {
	method: "POST",
	headers: {
		Authorization: `Bearer ${peer.access_token}`,
		"Content-Type": "application/json",
	},
	body: JSON.stringify({
		path: "notes:setShare",
		args: { id: shared, subject: owner.user.id, permission: "viewer" },
	}),
});
assert.equal((await share.json()).status, "success");
assert.equal((await (await detail(shared, token)).json()).permission, "viewer");
const next = await issue();
assert.equal((await detail(owned, token)).status, 401);
assert.equal((await detail(owned, next)).status, 200);
assert.deepEqual(await (await api(path, "DELETE", owner.access_token)).json(), {
	apiToken: null,
	hasApiToken: false,
});
assert.equal((await detail(owned, next)).status, 401);
console.log(
	JSON.stringify({
		hashOnly: true,
		managementRequiresSession: true,
		ownershipAndShareAccess: true,
		rotationInvalidatesPrevious: true,
		revokedTokenDenied: true,
	}),
);
