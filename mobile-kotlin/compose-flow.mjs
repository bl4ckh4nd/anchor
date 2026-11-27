import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const [origin, convexApi] = process.argv.slice(2);
for (const url of [origin, convexApi]) {
	assert.match(url ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
}

async function post(base, path, body, token, expectedStatus) {
	const response = await fetch(new URL(path, base), {
		method: "POST",
		redirect: "error",
		headers: {
			"Content-Type": "application/json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify(body),
	});
	assert.equal(response.status, expectedStatus, path);
	return response.json();
}

const id = randomUUID();
const credentials = {
	email: `compose-${id}@example.test`,
	password: randomUUID(),
};
await post(
	origin,
	"/api/auth/register",
	{ ...credentials, name: "Compose test" },
	null,
	201,
);
const session = await post(origin, "/api/auth/login", credentials, null, 200);
const { token } = await post(
	origin,
	"/api/auth/convex-token",
	{},
	session.access_token,
	200,
);
const note = {
	id,
	title: "Compose same-origin test",
	content: JSON.stringify({ ops: [{ insert: "Änderung vom Gerät\n" }] }),
};
const saved = await post(origin, "/api/compose/notes", note, token, 200);
const readback = await post(
	convexApi,
	"/api/query",
	{ path: "notes:get", args: { id }, format: "json" },
	token,
	200,
);
assert.equal(readback.status, "success");
assert.deepEqual(readback.value, saved);
assert.equal(saved.id, id);
assert.equal(saved.content, note.content);
assert.equal(saved.version, 1);
assert.equal(saved.permission, "owner");
console.log(
	"Passed: real Anchor password sign-in, same-origin token exchange and Convex note readback.",
);

const changedTitle = "Updated through same-origin sync";
const sync = await post(
	origin,
	"/api/compose/sync",
	{ changes: [{ type: "note", id, title: changedTitle, baseVersion: 1 }] },
	token,
	200,
);
assert.deepEqual(sync.results, [
	{ type: "note", id, status: "applied", version: 2 },
]);
assert.equal(
	sync.entries.find((entry) => entry.entityId === id)?.note.title,
	changedTitle,
);
const synced = await post(
	convexApi,
	"/api/query",
	{ path: "notes:get", args: { id }, format: "json" },
	token,
	200,
);
assert.equal(synced.status, "success");
assert.deepEqual(
	synced.value,
	sync.entries.find((entry) => entry.entityId === id)?.note,
);
console.log(
	"Passed: issued Anchor token can push and pull a note through the same-origin sync route.",
);
