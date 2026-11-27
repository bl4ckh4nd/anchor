import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const origin = process.argv[2];
assert.equal(origin, "http://127.0.0.1:3735");
async function request(path, method, status, credential, body) {
	const response = await fetch(origin + "/api/" + path, {
		method,
		headers: {
			...(credential ? { Authorization: "Bearer " + credential } : {}),
			"Content-Type": "application/json",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	assert.equal(response.status, status, method + " " + path);
	return response.json();
}
const register = () =>
	request("auth/register", "POST", 201, null, {
		name: "Tag write fixture",
		email: `tags-${randomUUID()}@example.test`,
		password: "SyntheticTagWrites2026!",
	});
const [owner, other] = await Promise.all([register(), register()]);
const token = owner.access_token;
const { apiToken } = await request(
	"auth/api-token/regenerate",
	"POST",
	200,
	token,
);
const pull = (cursor) =>
	request("compose/sync", "POST", 200, token, { cursor });
async function currentCursor() {
	let page = await pull();
	while (page.hasMore) page = await pull(page.nextCursor);
	return page.nextCursor;
}
const before = await currentCursor();
await request("tags", "POST", 401, null, { name: "Reading" });
await request("tags", "POST", 400, token, { name: "" });
const events = await Promise.all(
	[0, 1].map(() =>
		fetch(origin + "/api/tags", {
			method: "POST",
			headers: {
				Authorization: "Bearer " + apiToken,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ name: "Reading", color: "#123456" }),
		}),
	),
);
assert.deepEqual(events.map((event) => event.status).sort(), [201, 409]);
const tag = await events.find((event) => event.status === 201).json();
assert.equal(tag.userId, owner.user.id);
assert.equal(tag.version, 1);
assert.deepEqual(tag._count, { notes: 0 });
const path = "tags/" + tag.id;
const createDelta = await pull(before);
assert.deepEqual(
	createDelta.entries.map((entry) => [entry.entityId, entry.op]),
	[[tag.id, "upsert"]],
);

const stranger = await request("tags", "POST", 201, other.access_token, {
	name: "Reading",
});
assert.notEqual(stranger.id, tag.id);
await request(path, "PATCH", 404, other.access_token, { name: "No access" });
await request(path, "DELETE", 404, other.access_token);
await request("tags", "POST", 201, token, { name: "Occupied" });
const note = await request("notes", "POST", 201, token, {
	title: "Tagged",
	tagIds: [tag.id],
});
const unchanged = await request(path, "PATCH", 200, apiToken, {
	name: "Reading",
});
assert.equal(unchanged.version, 1);
assert.deepEqual(unchanged._count, { notes: 1 });
await request(path, "PATCH", 409, token, { name: "Occupied" });
const edited = await request(path, "PATCH", 200, token, {
	name: "Edited",
	color: null,
	baseVersion: 1,
});
assert.equal(edited.version, 2);
assert.equal(edited.color, null);
assert.deepEqual(edited._count, { notes: 1 });
const stale = await request(path, "PATCH", 409, apiToken, {
	name: "Edited",
	baseVersion: 1,
});
assert.deepEqual(stale.serverTag, edited);
const positioned = await request("tags/positions", "PUT", 200, apiToken, {
	positions: [
		{ id: tag.id, position: "a0" },
		{ id: stranger.id, position: "a1" },
	],
});
assert.deepEqual(positioned, { updated: [tag.id] });
const afterPosition = await request(path, "GET", 200, token);
assert.equal(afterPosition.position, "a0");
assert.equal(afterPosition.version, 2);

const afterEdit = await currentCursor();
const deleted = await request(path, "DELETE", 200, apiToken);
assert.equal(deleted.isDeleted, true);
assert.equal(deleted.version, 3);
assert.equal(Object.hasOwn(deleted, "_count"), false);
await request(path, "GET", 404, token);
assert.deepEqual(
	(await request("notes/" + note.id, "GET", 200, token)).tagIds,
	[],
);
const deleteDelta = await pull(afterEdit);
assert.deepEqual(
	deleteDelta.entries.map((entry) => [entry.entityId, entry.op]),
	[[tag.id, "remove"]],
);
const replacement = await request("tags", "POST", 201, token, {
	name: "Edited",
});
assert.notEqual(replacement.id, tag.id);
assert.deepEqual(
	(await request("notes/" + note.id, "GET", 200, token)).tagIds,
	[],
);
console.log(
	JSON.stringify({
		uniqueNamesAndIsolation: true,
		optimisticConflict: true,
		tokenOrdering: true,
		webAndComposeSameTags: true,
		deletedAssignmentsHidden: true,
	}),
);
