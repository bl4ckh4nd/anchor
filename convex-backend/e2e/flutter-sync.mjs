import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const origin = process.argv[2];
assert.equal(origin, "http://127.0.0.1:3735");
async function request(path, method, status, token, body, protocol) {
	const response = await fetch(origin + "/api/" + path, {
		method,
		headers: {
			...(token ? { Authorization: "Bearer " + token } : {}),
			...(protocol ? { "X-Anchor-Protocol": protocol } : {}),
			"Content-Type": "application/json",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	assert.equal(response.status, status, method + " " + path);
	return response.json();
}
const register = () =>
	request("auth/register", "POST", 201, null, {
		name: "Flutter fixture",
		email: `flutter-sync-${randomUUID()}@example.test`,
		password: "SyntheticFlutterSync2026!",
	});
const [owner, viewer] = await Promise.all([register(), register()]);
const writer = owner.access_token;
const reader = viewer.access_token;
const { apiToken } = await request(
	"auth/api-token/regenerate",
	"POST",
	200,
	reader,
);
const post = (token, data, protocol = "4", status = 200) =>
	request("sync", "POST", status, token, data, protocol);
await post(null, {}, "4", 401);
assert.deepEqual((await request("health", "GET", 200, null)).protocols, [3, 4]);
assert.deepEqual((await post(writer, {}, "2", 426)).protocols, [3, 4]);
assert.equal((await post(writer, {}, "5", 426)).code, "SERVER_OUTDATED");
await post(writer, { cursor: "invalid" }, "4", 400);

const pending = randomUUID();
const originTag = randomUUID();
const date = "2024-06-01T10:00:00.000Z";
const changes = [
	{ type: "tag", id: originTag, name: "Lost on cutover if push drops" },
	{
		type: "note",
		id: pending,
		title: "Offline before cutover",
		createdAt: date,
		content: null,
		background: null,
		isArchived: false,
		state: "active",
		tagIds: [originTag],
	},
	{ type: "pin", id: pending, isPinned: true },
	{
		type: "reminder",
		id: pending,
		remindAt: "2026-12-01T12:30",
		recurrence: "daily",
	},
];
const old = Buffer.from(JSON.stringify({ v: 3, m: "d", s: "9" })).toString(
	"base64url",
);
const migrated = await post(writer, { cursor: old, changes }, "3");
assert.equal(migrated.protocol, 3);
assert.equal(migrated.resetRequired, true);
assert.equal(migrated.nextCursor, null);
assert.deepEqual(
	migrated.results.map((result) => result.status),
	["applied", "applied", "applied", "applied"],
);
const path = "notes/" + pending;
assert.equal((await request(path, "GET", 200, writer)).createdAt, date);
const share = await request(path + "/shares", "POST", 201, writer, {
	sharedWithUserId: viewer.user.id,
	permission: "viewer",
});
const attachment = await fetch(
	origin +
		"/api/compose/attachments?noteId=" +
		pending +
		"&attachmentId=" +
		randomUUID(),
	{
		method: "POST",
		headers: {
			Authorization: "Bearer " + writer,
			"Content-Type": "audio/wav",
			"X-Anchor-Filename": "while-offline.wav",
		},
		body: Buffer.from("sync fixture"),
	},
);
assert.equal(attachment.status, 201);
const snapshot = [];
let page = await post(apiToken, { limit: 1 });
assert.ok(page.entries.length <= 1);
snapshot.push(...page.entries);
while (page.hasMore) {
	page = await post(apiToken, { cursor: page.nextCursor, limit: 1 });
	assert.ok(page.entries.length <= 1);
	snapshot.push(...page.entries);
}
const shared = snapshot.find((entry) => entry.entityType === "note").note;
assert.equal(shared.permission, "viewer");
assert.equal(shared.sharedBy.id, owner.user.id);
assert.equal(shared.createdAt, date);
assert.equal(typeof shared.updatedAt, "string");
const files = snapshot.find((entry) => entry.entityType === "attachments");
assert.equal(files.attachments[0].originalFilename, "while-offline.wav");
assert.equal(files.attachments[0].position, 0);
const after = await post(apiToken, {
	cursor: page.nextCursor,
	changes: [
		{ type: "note", id: pending, title: "Viewer proposal", baseVersion: 1 },
	],
});
assert.equal(after.results[0].status, "conflict");
assert.equal(after.results[0].serverCopy.sharedBy.id, owner.user.id);
assert.equal(typeof after.results[0].serverCopy.updatedAt, "string");
await request(
	path + "/attachments/" + files.attachments[0].id,
	"DELETE",
	200,
	writer,
);
const delta = await post(apiToken, { cursor: after.nextCursor, limit: 1 });
assert.deepEqual(
	delta.entries.map((row) => row.entityType),
	["note"],
);
assert.equal(delta.hasMore, true);
const carry = await post(apiToken, {
	cursor: delta.nextCursor,
	limit: 1,
	changes: [{ type: "pin", id: pending, isPinned: true }],
});
assert.deepEqual(
	carry.entries.find((entry) => entry.entityType === "attachments").attachments,
	[],
);
assert.equal(carry.results[0].status, "applied");
const resumed = await post(apiToken, { cursor: carry.nextCursor, limit: 1 });
assert.deepEqual(
	resumed.entries.map((row) => row.entityType),
	["pin"],
);
await request(path + "/shares/" + share.id, "DELETE", 200, writer);
const revokedCarry = await post(apiToken, {
	cursor: delta.nextCursor,
	limit: 1,
});
assert.equal(revokedCarry.entries.length, 1);
assert.equal(revokedCarry.entries[0].entityType, "attachments");
assert.equal(revokedCarry.entries[0].op, "remove");
const badCarry = await post(apiToken, { cursor: "la:bad" }, "4", 400);
assert.equal(badCarry.code, "INVALID_SYNC_CURSOR");
console.log(
	JSON.stringify({
		protocol3And4: true,
		acceptedOldCursorWithPendingWrites: true,
		viewerConflict: true,
		legacyAttachmentsAndDates: true,
		singleEntrySnapshotAndDelta: true,
		carryAuthorizationAndPush: true,
	}),
);
