import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const origin = process.argv[2];
assert.equal(origin, "http://127.0.0.1:3735");
const request = (path, method, credential, data) =>
	fetch(origin + "/api/" + path, {
		method,
		headers: {
			...(credential ? { Authorization: `Bearer ${credential}` } : {}),
			"Content-Type": "application/json",
		},
		body: data === undefined ? undefined : JSON.stringify(data),
	});
async function register() {
	const response = await request("auth/register", "POST", null, {
		name: "List fixture",
		email: `lists-${randomUUID()}@example.test`,
		password: "SyntheticLists2026!",
	});
	assert.equal(response.status, 201);
	return response.json();
}
assert.equal((await request("notes", "GET")).status, 401);
assert.equal((await request("tags", "GET")).status, 401);
const [owner, reader] = await Promise.all([register(), register()]);
const issue = await request(
	"auth/api-token/regenerate",
	"POST",
	reader.access_token,
);
assert.equal(issue.status, 200);
const { apiToken } = await issue.json();
async function sync(actor, changes) {
	const response = await request("compose/sync", "POST", actor.access_token, {
		changes,
	});
	assert.equal(response.status, 200);
	assert.ok(
		(await response.json()).results.every(
			(result) => result.status === "applied",
		),
	);
}
const ownerTag = randomUUID();
const readerTag = randomUUID();
const share = randomUUID();
const archive = randomUUID();
const trash = randomUUID();
const privateNote = randomUUID();
const fillers = Array.from({ length: 10 }, () => randomUUID());
const n = (id, title, args = {}) => ({ type: "note", id, title, ...args });
await sync(owner, [
	{ type: "tag", id: ownerTag, name: "Private owner tag" },
	n(share, "Shared", { content: "distinct OMEGA marker", tagIds: [ownerTag] }),
	n(privateNote, "Owner only"),
]);
await sync(reader, [
	{ type: "tag", id: readerTag, name: "Reader tag" },
	n(archive, "Archived", { tagIds: [readerTag], isArchived: true }),
	n(trash, "Trashed", { tagIds: [readerTag], state: "trashed" }),
	...fillers.map((id) => n(id, "Reader note")),
]);
const shared = await fetch("http://127.0.0.1:3734/api/mutation", {
	method: "POST",
	headers: {
		Authorization: `Bearer ${owner.access_token}`,
		"Content-Type": "application/json",
	},
	body: JSON.stringify({
		path: "notes:setShare",
		args: { id: share, subject: reader.user.id, permission: "viewer" },
	}),
});
assert.equal((await shared.json()).status, "success");
await sync(reader, [n(share, "Shared", { tagIds: [readerTag] })]);

const list = async (path, credential = apiToken) => {
	const response = await request(path, "GET", credential);
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("Cache-Control"), "no-store");
	return response.json();
};
const active = await list("notes");
assert.equal(active.length, fillers.length + 1);
assert.deepEqual(active, await list("notes", reader.access_token));
assert.ok(
	active.every(
		(note, i) =>
			i === 0 ||
			active[i - 1].updatedAt > note.updatedAt ||
			(active[i - 1].updatedAt === note.updatedAt &&
				active[i - 1].id > note.id),
	),
);
assert.deepEqual(await list("notes?limit=3"), active.slice(0, 3));
const found = await list("notes?search=omega");
assert.deepEqual(
	found.map((note) => note.id),
	[share],
);
assert.equal(found[0].permission, "viewer");
assert.deepEqual(found[0].tagIds, [readerTag]);
assert.equal(found[0].sharedBy.id, owner.user.id);
assert.deepEqual(
	(await list("notes?tagId=" + readerTag)).map((note) => note.id),
	[share],
);
assert.deepEqual(await list("notes?tagId=" + ownerTag), []);
assert.deepEqual(
	(await list("notes/archive")).map((note) => note.id),
	[archive],
);
assert.deepEqual(
	(await list("notes/trash")).map((note) => note.id),
	[trash],
);
const tags = await list("tags");
assert.equal(tags.length, 1);
assert.equal(tags[0].id, readerTag);
assert.equal(tags[0].userId, reader.user.id);
assert.equal(tags[0]._count.notes, 2);
assert.deepEqual(await list("tags/" + readerTag), tags[0]);
assert.equal((await request("tags/" + ownerTag, "GET", apiToken)).status, 404);
const ownedTaggedNotes = await list("tags/" + readerTag + "/notes");
assert.deepEqual(
	ownedTaggedNotes.map((note) => note.id),
	[archive],
);
assert.deepEqual(
	ownedTaggedNotes[0].tags.map((tag) => tag.id),
	[readerTag],
);
assert.equal(
	(await request("tags/" + ownerTag + "/notes", "GET", apiToken)).status,
	404,
);
console.log(
	JSON.stringify({
		activeArchivedTrashed: true,
		searchAndOrdering: true,
		tagsAndCounts: true,
		tagNotesOwnerOnly: true,
		shareIsolation: true,
		apiTokenParity: true,
	}),
);
