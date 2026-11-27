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
		name: "Note bulk fixture",
		email: `bulk-${randomUUID()}@example.test`,
		password: "SyntheticBulkNotes2026!",
	});
const [owner, recipient] = await Promise.all([register(), register()]);
const writer = owner.access_token;
const reader = recipient.access_token;
const { apiToken } = await request(
	"auth/api-token/regenerate",
	"POST",
	200,
	reader,
);
const bulk = (action, noteIds, fields, token = apiToken, status = 201) =>
	request("notes/bulk/" + action, "POST", status, token, {
		noteIds,
		...fields,
	});
await bulk("archive", [], {}, "", 401);
await bulk("pin", [], {}, reader, 400);
await bulk(
	"tags",
	[],
	{ tagIds: Array.from({ length: 51 }, randomUUID) },
	reader,
	400,
);
await bulk("delete", Array.from({ length: 201 }, randomUUID), {}, reader, 400);
assert.deepEqual(await bulk("archive", []), { count: 0 });

const createTag = async (credential, name) =>
	(await request("tags", "POST", 201, credential, { name })).id;
const initial = await createTag(reader, "Keep this tag");
const added = await createTag(reader, "Add this tag");
const foreignTag = await createTag(writer, "Private tag");
const createNote = (credential, title, tagIds) =>
	request("notes", "POST", 201, credential, { title, tagIds });
const owned = await createNote(reader, "Owned", [initial]);
const shared = await createNote(writer, "Shared", [foreignTag]);
const privateNote = await createNote(writer, "Private");
const share = await fetch("http://127.0.0.1:3734/api/mutation", {
	method: "POST",
	headers: {
		Authorization: "Bearer " + writer,
		"Content-Type": "application/json",
	},
	body: JSON.stringify({
		path: "notes:setShare",
		args: {
			id: shared.id,
			subject: recipient.user.id,
			permission: "viewer",
		},
	}),
});
assert.equal((await share.json()).status, "success");
const picked = [owned.id, shared.id, owned.id, privateNote.id, randomUUID()];
const detail = (note, token = reader, status = 200) =>
	request("notes/" + note.id, "GET", status, token);
const pull = (cursor) =>
	request("compose/sync", "POST", 200, reader, { cursor });
let page = await pull();
while (page.hasMore) page = await pull(page.nextCursor);
const cursor = page.nextCursor;

const maxSelection = [...picked, ...Array.from({ length: 195 }, randomUUID)];
assert.deepEqual(await bulk("archive", maxSelection), { count: 2 });
assert.deepEqual(await bulk("pin", picked, { isPinned: true }), { count: 2 });
assert.deepEqual(await bulk("tags", picked, { tagIds: [foreignTag] }), {
	count: 0,
});
assert.deepEqual(
	await bulk("tags", picked, { tagIds: [added, foreignTag, added] }),
	{ count: 2 },
);
assert.deepEqual(await bulk("tags", picked, { tagIds: [added] }), { count: 2 });
const ownedView = await detail(owned);
assert.deepEqual(new Set(ownedView.tagIds), new Set([initial, added]));
assert.equal(ownedView.version, owned.version);
assert.equal(ownedView.isArchived, true);
assert.equal(ownedView.isPinned, true);
assert.deepEqual((await detail(shared)).tagIds, [added]);
const ownerView = await detail(shared, writer);
assert.deepEqual(ownerView.tagIds, [foreignTag]);
assert.equal(ownerView.isPinned, false);
assert.equal(ownerView.isArchived, false);
const delta = await pull(cursor);
assert.ok(
	delta.entries.find(
		(row) => row.entityId === shared.id && row.note?.tagIds.includes(added),
	),
);
assert.ok(
	delta.entries.find(
		(row) =>
			row.entityId === owned.id &&
			row.entityType === "pin" &&
			row.op === "upsert",
	),
);
assert.deepEqual(await bulk("pin", picked, { isPinned: false }), { count: 2 });
assert.equal((await detail(owned)).isPinned, false);

assert.deepEqual(await bulk("delete", picked), { count: 2 });
assert.equal((await detail(owned)).state, "trashed");
await detail(shared, reader, 404);
assert.equal((await detail(shared, writer)).state, "active");
assert.equal((await detail(privateNote, writer)).state, "active");
const removed = await pull(delta.nextCursor);
assert.ok(
	removed.entries.find(
		(row) =>
			row.entityId === shared.id &&
			row.entityType === "note" &&
			row.op === "remove",
	),
);
console.log(
	JSON.stringify({
		maxBatch: true,
		personalFields: true,
		shareRemoval: true,
		composeDelta: true,
	}),
);
