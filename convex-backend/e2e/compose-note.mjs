import assert from "node:assert/strict";
import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { readFileSync } from "node:fs";

const [origin, keyFile] = process.argv.slice(2);
assert.match(origin ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
const key = createPrivateKey(readFileSync(keyFile));
const encode = (value) =>
	Buffer.from(JSON.stringify(value)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
function tokenFor(sub) {
	const jwt = [
		encode({ alg: "RS256", typ: "JWT", kid: "anchor-convex" }),
		encode({
			iss: "https://anchor-e2e.invalid",
			sub,
			aud: "anchor",
			iat: now,
			exp: now + 120,
		}),
	].join(".");
	return `${jwt}.${sign("RSA-SHA256", Buffer.from(jwt), key).toString("base64url")}`;
}
const token = tokenFor(`compose-http-fixture-${randomUUID()}`);
const id = randomUUID();
const content = JSON.stringify({
	ops: [{ insert: "Wichtig", attributes: { bold: true } }, { insert: "\n" }],
});

function create(body, credential = token) {
	return fetch(new URL("/api/compose/notes", origin), {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(credential ? { Authorization: `Bearer ${credential}` } : {}),
		},
		body,
	});
}

assert.equal((await create("{}", null)).status, 401);
assert.equal((await create("{")).status, 400);
assert.equal(
	(await create(JSON.stringify({ id: "invalid", title: "Note" }))).status,
	400,
);
assert.equal((await create(JSON.stringify({ id, title: 7 }))).status, 400);
assert.equal(
	(await create(JSON.stringify({ id, title: "Note", background: 7 }))).status,
	400,
);

const response = await create(
	JSON.stringify({ id, title: "Rich text", content, background: "pattern_music" }),
);
assert.equal(response.status, 200);
assert.equal(response.headers.get("cache-control"), "no-store");
const note = await response.json();
assert.equal(note.id, id);
assert.equal(note.version, 1);
assert.equal(note.content, content);
assert.equal(note.background, "pattern_music");
assert.deepEqual(
	await (
		await create(JSON.stringify({ id, title: "Retry", content, background: "pattern_code" }))
	).json(),
	note,
);
const collision = await create(
	JSON.stringify({ id, title: "Collision" }),
	tokenFor("another-user"),
);
assert.equal(collision.status, 409);
assert.deepEqual(await collision.json(), { code: "NOTE_ID_CONFLICT" });
console.log(
	"Passed: authorization, invalid input, exact rich-text bytes, idempotent create and ID collision.",
);

function sync(body, credential = token) {
	return fetch(new URL("/api/compose/sync", origin), {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(credential ? { Authorization: `Bearer ${credential}` } : {}),
		},
		body: JSON.stringify(body),
	});
}

assert.equal((await sync({}, null)).status, 401);
let page = await (await sync({ limit: 1 })).json();
for (let i = 0; page.hasMore && i < 200; i++) {
	const response = await sync({ cursor: page.nextCursor });
	assert.equal(response.status, 200);
	page = await response.json();
}
assert.equal(page.hasMore, false);
const change = { type: "note", id, title: "Synced HTTP", baseVersion: 1 };
assert.equal(
	(await sync({ cursor: "malformed", changes: [change] })).status,
	400,
);
assert.equal((await sync({ limit: 0, changes: [change] })).status, 400);
assert.equal(
	(await sync({ changes: [{ ...change, baseVersion: 0 }] })).status,
	400,
);
assert.equal(
	(await sync({ changes: [{ ...change, state: "unknown" }] })).status,
	400,
);
const future = await sync({ cursor: "n1:d:999999999:", changes: [change] });
assert.equal(future.status, 200);
assert.deepEqual(await future.json(), {
	entries: [],
	results: [],
	hasMore: false,
	nextCursor: null,
	resetRequired: true,
});
const result = await sync({ cursor: page.nextCursor, changes: [change] });
assert.equal(result.status, 200);
assert.equal(result.headers.get("cache-control"), "no-store");
const combined = await result.json();
assert.deepEqual(combined.results, [
	{ type: "note", id, status: "applied", version: 2 },
]);
assert.equal(combined.entries.length, 1);
assert.equal(combined.entries[0].note.title, change.title);
assert.equal(combined.entries[0].note.version, 2);
assert.equal(combined.entries[0].note.background, "pattern_music");
const replay = await (
	await sync({ cursor: combined.nextCursor, changes: [change] })
).json();
assert.deepEqual(replay.results, combined.results);
assert.deepEqual(replay.entries, []);
const stale = await (
	await sync({
		cursor: replay.nextCursor,
		changes: [{ ...change, title: "Distinct stale draft" }],
	})
).json();
assert.equal(stale.results[0].status, "conflict");
assert.deepEqual(stale.results[0].serverCopy, combined.entries[0].note);
assert.deepEqual(stale.entries, []);
console.log(
	"Passed: HTTP push before pull, validation without writes, reset and stale conflict.",
);

const deviceHistoryChange = {
	...change,
	title: "Do not apply this title",
	revisionsOnly: true,
	revisions: [
		{
			id: randomUUID(),
			title: "Earlier device text",
			content,
			cause: "edit",
			createdAt: new Date().toISOString(),
		},
	],
};
const invalidHistory = await sync({
	cursor: stale.nextCursor,
	changes: [
		{
			...deviceHistoryChange,
			revisions: [
				{ ...deviceHistoryChange.revisions[0], createdAt: "invalid" },
			],
		},
	],
});
assert.equal(invalidHistory.status, 400);
const historyReceipt = await sync({
	cursor: stale.nextCursor,
	changes: [deviceHistoryChange],
});
assert.equal(historyReceipt.status, 200);
const confirmed = await historyReceipt.json();
assert.deepEqual(confirmed.results, [
	{ type: "note", id, status: "applied", version: 2 },
]);
assert.equal(confirmed.entries.length, 1);
assert.equal(confirmed.entries[0].note.title, change.title);
const replayedHistory = await (
	await sync({ cursor: confirmed.nextCursor, changes: [deviceHistoryChange] })
).json();
assert.deepEqual(replayedHistory.results, confirmed.results);
assert.deepEqual(replayedHistory.entries, []);
console.log("Passed: validated and idempotent history-only HTTP sync.");

async function setArchived(isArchived) {
	const response = await fetch(new URL(`/api/notes/${id}`, origin), {
		method: "PATCH",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ isArchived }),
	});
	assert.equal(response.status, 200);
	assert.equal((await response.json()).isArchived, isArchived);
}
await setArchived(true);
await setArchived(false);
await setArchived(true);
const archive = await sync({
	cursor: replayedHistory.nextCursor,
});
assert.equal(archive.status, 200);
const archived = await archive.json();
assert.equal(archived.entries.at(-1).note.isArchived, true);
assert.equal(archived.entries.at(-1).note.version, 2);
console.log("Passed: HTTP archive sync without a content version bump.");

const trashResponse = await sync({
	cursor: archived.nextCursor,
	changes: [
		{ ...change, baseVersion: 2, state: "trashed", background: "#f4e9d7" },
	],
});
assert.equal(trashResponse.status, 200);
const trashed = await trashResponse.json();
assert.equal(trashed.entries[0].note.state, "trashed");
assert.equal(trashed.entries[0].note.background, "#f4e9d7");
const restored = await (await sync({
	cursor: trashed.nextCursor,
	changes: [{ ...change, baseVersion: 3, state: "active" }],
})).json();
assert.equal(restored.entries[0].note.state, "active");
const staleDelete = await (await sync({
	cursor: restored.nextCursor,
	changes: [{ ...change, baseVersion: 3, state: "deleted" }],
})).json();
assert.equal(staleDelete.results[0].status, "conflict");
assert.deepEqual(staleDelete.entries, []);

const retrash = await (await sync({
	cursor: staleDelete.nextCursor,
	changes: [{ ...change, baseVersion: 4, state: "trashed" }],
})).json();
assert.equal(retrash.entries[0].note.state, "trashed");
const deleteResponse = await sync({
	cursor: retrash.nextCursor,
	changes: [{ ...change, baseVersion: 5, state: "deleted" }],
});
assert.equal(deleteResponse.status, 200);
const removed = await deleteResponse.json();
assert.equal(removed.results[0].version, 6);
assert.deepEqual(
	removed.entries.map((entry) => [entry.entityId, entry.op, entry.note]),
	[[id, "remove", undefined]],
);
console.log(
	"Passed: HTTP lifecycle sync restores trash, rejects stale permanent deletion and emits a removal without note data.",
);

const pinnedId = randomUUID();
const mixedPins = await sync({
	cursor: removed.nextCursor,
	changes: [
		{ type: "note", id: pinnedId, title: "Pin in the same batch" },
		{ type: "pin", id: pinnedId, isPinned: true },
	],
});
assert.equal(mixedPins.status, 200);
const pinned = await mixedPins.json();
assert.deepEqual(pinned.results, [
	{ type: "note", id: pinnedId, status: "applied", version: 1 },
	{ type: "pin", id: pinnedId, status: "applied" },
]);
assert.equal(pinned.entries[0].note.isPinned, true);
assert.equal(pinned.entries[1].entityType, "pin");
assert.equal(pinned.entries[1].op, "upsert");
console.log(
	"Passed: HTTP sync accepts independent note and pin changes with the same ID.",
);

const reminder = {
	type: "reminder",
	id: pinnedId,
	remindAt: "2027-02-03T12:30",
	recurrence: "weekly",
};
assert.equal(
	(await sync({ changes: [{ ...reminder, remindAt: "2027-02-03T12:30Z" }] }))
		.status,
	400,
);
const reminderResponse = await sync({
	cursor: pinned.nextCursor,
	changes: [reminder],
});
assert.equal(reminderResponse.status, 200);
const reminderPage = await reminderResponse.json();
const expectedReminder = {
	remindAt: reminder.remindAt,
	recurrence: reminder.recurrence,
	version: 1,
};
assert.deepEqual(reminderPage.results, [
	{ type: "reminder", id: pinnedId, status: "applied", version: 1 },
]);
assert.deepEqual(
	reminderPage.entries.map((entry) => [
		entry.entityType,
		entry.entityId,
		entry.reminder,
	]),
	[["reminder", pinnedId, expectedReminder]],
);
const staleClear = await (
	await sync({
		cursor: reminderPage.nextCursor,
		changes: [{ type: "reminder", id: pinnedId, remindAt: null }],
	})
).json();
assert.deepEqual(staleClear.results, [
	{
		type: "reminder",
		id: pinnedId,
		status: "conflict",
		version: 1,
		serverCopy: expectedReminder,
	},
]);
assert.deepEqual(staleClear.entries, []);
console.log(
	"Passed: reminder HTTP validation, independent delta and stale clear.",
);

const tagId = randomUUID();
const tagResponse = await sync({
	cursor: reminderPage.nextCursor,
	changes: [{ type: "tag", id: tagId, name: "HTTP tag", color: "#209040" }],
});
assert.equal(tagResponse.status, 200);
const tagPage = await tagResponse.json();
assert.deepEqual(tagPage.results, [
	{ type: "tag", id: tagId, status: "applied", version: 1 },
]);
assert.deepEqual(
	tagPage.entries.map((entry) => [
		entry.entityType,
		entry.tag.name,
		entry.tag.color,
	]),
	[["tag", "HTTP tag", "#209040"]],
);
console.log("Passed: HTTP tag creation and delta.");

const tagAttach = await sync({
	cursor: tagPage.nextCursor,
	changes: [
		{
			type: "note",
			id: pinnedId,
			title: "Pin in the same batch",
			tagIds: [tagId, tagId, randomUUID()],
		},
	],
});
assert.equal(tagAttach.status, 200);
const tagAttached = await tagAttach.json();
assert.deepEqual(tagAttached.results, [
	{ type: "note", id: pinnedId, status: "applied", version: 1 },
]);
assert.equal(tagAttached.entries.length, 1);
assert.deepEqual(tagAttached.entries[0].note.tagIds, [tagId]);
console.log(
	"Passed: HTTP note tag attachment ignores unknown IDs and does not change the version.",
);

function positions(path, rows, credential = token) {
	return fetch(new URL(path, origin), {
		method: "PUT",
		headers: {
			"Content-Type": "application/json",
			...(credential ? { Authorization: `Bearer ${credential}` } : {}),
		},
		body: JSON.stringify({ positions: rows }),
	});
}
assert.equal((await positions("/api/notes/positions", [], null)).status, 401);
assert.equal(
	(
		await positions("/api/notes/positions", [
			{ noteId: pinnedId, position: "bad key" },
		])
	).status,
	400,
);
assert.equal(
	(await positions("/api/tags/positions", [{ noteId: tagId, position: "a0" }]))
		.status,
	400,
);
assert.deepEqual(
	await (
		await positions("/api/notes/positions", [
			{ noteId: pinnedId, position: "Zz" },
		])
	).json(),
	{ updated: [pinnedId] },
);
assert.deepEqual(
	await (
		await positions("/api/tags/positions", [{ id: tagId, position: "a0" }])
	).json(),
	{ updated: [tagId] },
);
const ordering = await (await sync({ cursor: tagAttached.nextCursor })).json();
assert.deepEqual(
	ordering.entries.map((entry) => [
		entry.entityType,
		(entry.note ?? entry.tag).position,
		(entry.note ?? entry.tag).version,
	]),
	[
		["note", "Zz", 1],
		["tag", "a0", 1],
	],
);
assert.deepEqual(
	await (
		await positions("/api/notes/positions", [
			{ noteId: pinnedId, position: null },
		])
	).json(),
	{ updated: [pinnedId] },
);
const clearedOrder = await (await sync({ cursor: ordering.nextCursor })).json();
assert.equal(clearedOrder.entries[0].note.position, null);
console.log(
	"Passed: positions HTTP contract, validation, clearing and no version change.",
);

const notePath = "/api/notes/" + pinnedId;
function patchNote(body, credential = token) {
	return fetch(new URL(notePath, origin), {
		method: "PATCH",
		headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}
const separateTags = [randomUUID(), randomUUID()];
const newTags = await (await sync({
	changes: separateTags.map((id, index) => ({ type: "tag", id, name: `Assignment ${index}` })),
})).json();
assert.ok(newTags.results.every((result) => result.status === "applied"));
const assign = (id, assigned = true, credential = token) =>
	patchNote({ tagAssignment: { id, assigned } }, credential);
const additions = await Promise.all(separateTags.map((id) => assign(id)));
assert.ok(additions.every((response) => response.status === 200));
assert.equal((await assign(randomUUID())).status, 404);
assert.equal((await assign(tagId, true, tokenFor("outside-assignment"))).status, 404);
assert.equal((await patchNote({ tagAssignment: { id: tagId, assigned: true }, tagIds: [] })).status, 400);
for (let retry = 0; retry < 2; retry++) {
	const response = await assign(separateTags[0], false);
	assert.equal(response.status, 200);
	const note = await response.json();
	assert.deepEqual(note.tagIds.sort(), [tagId, separateTags[1]].sort());
	assert.equal(note.version, 1);
}
console.log("Passed: atomic personal tag additions and removal preserve other assignments and note version.");

const renamed = await fetch(new URL("/api/tags/" + separateTags[1], origin), {
	method: "PATCH",
	headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
	body: JSON.stringify({ name: "Renamed assignment", baseVersion: 1 }),
});
assert.equal(renamed.status, 200);
assert.equal((await renamed.json()).version, 2);
const deleteTag = { type: "tag", id: separateTags[1], name: "Assignment 1", isDeleted: true, baseVersion: 1 };
const staleTagDelete = await (await sync({ changes: [deleteTag] })).json();
assert.equal(staleTagDelete.results[0].status, "conflict");
assert.equal(staleTagDelete.results[0].serverCopy.name, "Renamed assignment");
const noteRead = () => fetch(new URL(notePath, origin), {
	headers: { Authorization: `Bearer ${token}` },
}).then((response) => response.json());
assert.deepEqual((await noteRead()).tagIds.sort(), [tagId, separateTags[1]].sort());
const currentTagDelete = await (await sync({ changes: [{ ...deleteTag, baseVersion: 2 }] })).json();
assert.equal(currentTagDelete.results[0].status, "applied");
const afterTagDelete = await noteRead();
assert.deepEqual(afterTagDelete.tagIds, [tagId]);
assert.equal(afterTagDelete.version, 1);
console.log("Passed: stale tag deletion leaves renamed tag and assignments intact.");

const clearedReminder = await sync({
	changes: [{ type: "reminder", id: pinnedId, remindAt: null, baseVersion: 1 }],
});
assert.equal(clearedReminder.status, 200);
assert.deepEqual((await clearedReminder.json()).results, [
	{ type: "reminder", id: pinnedId, status: "applied" },
]);
const outdatedReminder = await sync({
	changes: [{ ...reminder, remindAt: "2027-02-03T13:30", baseVersion: 1 }],
});
assert.equal(outdatedReminder.status, 200);
assert.deepEqual((await outdatedReminder.json()).results, [
	{ type: "reminder", id: pinnedId, status: "conflict", serverCopy: null },
]);
console.log("Passed: Compose HTTP reports a deleted reminder as an explicit null conflict.");

const firstId = randomUUID();
const secondId = randomUUID();
for (const id of [firstId, secondId]) {
	assert.equal((await create(JSON.stringify({ id, title: "Reorder fixture" }))).status, 200);
}
const move = (notes, credential = token, otherGroup) =>
	fetch(new URL("/api/compose/notes/order", origin), {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(credential ? { Authorization: `Bearer ${credential}` } : {}),
		},
		body: JSON.stringify({
			...(otherGroup ? { groups: { moved: notes, other: otherGroup } } : { notes }),
			noteId: secondId,
			step: -1,
		}),
	});
const order = [firstId, secondId].map((id) => ({ id, position: null }));
assert.equal((await move(order, null)).status, 401);
assert.equal((await move(order, tokenFor("outside-order"))).status, 409);
assert.deepEqual(await (await move(order)).json(), { applied: true });
assert.equal((await move(order)).status, 409);
const placed = await Promise.all(order.map(async ({ id }) => {
	const response = await fetch(new URL(`/api/notes/${id}`, origin), {
		headers: { Authorization: `Bearer ${token}` },
	});
	assert.equal(response.status, 200);
	const note = await response.json();
	assert.equal(note.version, 1);
	assert.equal(typeof note.position, "string");
	return { id, position: note.position };
}));
assert.ok(placed[1].position < placed[0].position);
const pinForMove = await sync({ changes: [{ type: "pin", id: firstId, isPinned: true }] });
assert.equal((await pinForMove.json()).results[0].status, "applied");
assert.equal((await move(placed)).status, 409);
console.log("Passed: Compose HTTP moves notes within a group, preserving versions and rejecting stale, mixed or unauthorized snapshots.");

const otherIds = [randomUUID(), randomUUID()];
for (const id of otherIds) {
	assert.equal((await create(JSON.stringify({ id, title: "Other group" }))).status, 200);
}
const regroup = await sync({ changes: [
	{ type: "pin", id: firstId, isPinned: false },
	...otherIds.map((id) => ({ type: "pin", id, isPinned: true })),
] });
assert.deepEqual((await regroup.json()).results.map(({ status }) => status), ["applied", "applied", "applied"]);
const otherGroup = otherIds.map((id) => ({ id, position: null }));
assert.equal((await move(placed, token, [{ ...otherGroup[0], position: "a0" }, otherGroup[1]])).status, 409);
assert.equal((await move(placed, token, [placed[0]])).status, 409);
assert.deepEqual(await (await move(placed, token, otherGroup)).json(), { applied: true });
const siblingKeys = await Promise.all(otherIds.map(async (id) => {
	const response = await fetch(new URL(`/api/notes/${id}`, origin), {
		headers: { Authorization: `Bearer ${token}` },
	});
	assert.equal(response.status, 200);
	const note = await response.json();
	assert.equal(note.version, 1);
	return note.position;
}));
assert.ok(siblingKeys.every((key) => typeof key === "string") && siblingKeys[0] < siblingKeys[1]);
console.log("Passed: Compose HTTP captures the other visible group atomically and rejects stale or duplicate snapshots.");
