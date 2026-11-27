import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const origin = process.argv[2];
assert.equal(origin, "http://127.0.0.1:3735");

async function request(path, method, status, token, body) {
	const response = await fetch(origin + "/api/" + path, {
		method,
		headers: {
			...(token ? { Authorization: "Bearer " + token } : {}),
			"Content-Type": "application/json",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	assert.equal(response.status, status, method + " " + path);
	return response.json();
}

const register = () =>
	request("auth/register", "POST", 201, null, {
		name: "Note write fixture",
		email: `web-writes-${randomUUID()}@example.test`,
		password: "SyntheticWrites2026!",
	});
const [owner, viewer] = await Promise.all([register(), register()]);
const session = owner.access_token;
const reader = viewer.access_token;
const { apiToken } = await request(
	"auth/api-token/regenerate",
	"POST",
	200,
	session,
);
const id = randomUUID();
const tag = randomUUID();
await request("compose/sync", "POST", 200, session, {
	changes: [{ type: "tag", id: tag, name: "Write fixture tag" }],
});
await request("notes", "POST", 401, null, { title: "Unauthorized" });
await request("notes", "POST", 400, session, { title: false });
const created = await request("notes", "POST", 201, apiToken, {
	id,
	title: "",
	content: '[{"insert":"Original\\n"}]',
	isPinned: true,
	tagIds: [tag],
	background: "blue",
	reminder: { remindAt: "2026-12-01T12:30", recurrence: "daily" },
});
assert.equal(created.id, id);
assert.equal(created.version, 1);
assert.equal(created.isPinned, true);
assert.equal(created.background, "blue");
assert.equal(created.reminder.recurrence, "daily");
assert.deepEqual(created.tagIds, [tag]);

const path = "notes/" + id;
assert.deepEqual(
	await request("notes", "POST", 201, session, { id, title: "Retry" }),
	created,
);
assert.equal(
	typeof (
		await request("notes", "POST", 201, session, { title: "Generated ID" })
	).id,
	"string",
);
await request("notes", "POST", 409, reader, { id, title: "Collision" });

const shared = await fetch("http://127.0.0.1:3734/api/mutation", {
	method: "POST",
	headers: {
		Authorization: "Bearer " + session,
		"Content-Type": "application/json",
	},
	body: JSON.stringify({
		path: "notes:setShare",
		args: { id, subject: viewer.user.id, permission: "viewer" },
	}),
});
assert.equal((await shared.json()).status, "success");
await request(path, "PATCH", 403, reader, { title: "Denied" });
await request(path + "/permanent", "DELETE", 403, reader);
const personal = await request(path, "PATCH", 200, reader, {
	isArchived: true,
	isPinned: true,
});
assert.equal(personal.version, 1);
assert.equal(personal.isArchived, true);
assert.equal((await request(path, "GET", 200, session)).isArchived, false);

const saved = await request(path, "PATCH", 200, session, {
	title: "First edit",
	baseVersion: 1,
	content: null,
	reminder: null,
});
assert.equal(saved.version, 2);
assert.equal(saved.content, null);
assert.equal(saved.reminder, null);
const conflict = await request(path, "PATCH", 409, apiToken, {
	title: "Losing draft",
	baseVersion: 1,
	isArchived: true,
});
assert.deepEqual(conflict.serverNote, saved);

const flushed = await request(path, "PATCH", 200, session, {
	title: "Page-close edit",
	replacesOtherEdit: true,
});
assert.equal(flushed.version, 3);
const query = await fetch("http://127.0.0.1:3734/api/query", {
	method: "POST",
	headers: {
		Authorization: "Bearer " + session,
		"Content-Type": "application/json",
	},
	body: JSON.stringify({ path: "notes:history", args: { id } }),
});
const history = await query.json();
assert.equal(history.status, "success");
assert.ok(JSON.stringify(history.value).includes("Losing draft"));
assert.ok(JSON.stringify(history.value).includes("First edit"));

const leave = await request(path, "DELETE", 200, reader);
assert.deepEqual(leave, { success: true });
await request(path, "GET", 404, reader);
const trashDate = new Date(Date.now() - 3600_000).toISOString();
const trashed = await request(
	path + "?trashedAt=" + trashDate,
	"DELETE",
	200,
	apiToken,
);
assert.equal(trashed.state, "trashed");
assert.equal(trashed.stateChangedAt, trashDate);
assert.equal(
	(await request(path, "DELETE", 200, session)).version,
	trashed.version,
);
assert.equal(
	(await request(path + "/restore", "PATCH", 200, session)).state,
	"active",
);
await request(path + "/restore", "PATCH", 404, session);
assert.equal(
	(await request(path + "/permanent", "DELETE", 200, apiToken)).state,
	"deleted",
);
await request(path, "GET", 404, session);
const repeated = await request(path + "/permanent", "DELETE", 200, session);
assert.equal(repeated.state, "deleted");
await request("notes", "POST", 409, session, { id, title: "No resurrection" });
console.log(
	JSON.stringify({
		createRetry: true,
		apiTokenWrites: true,
		viewerPermissions: true,
		versionConflictAndHistory: true,
		trashRestoreAndTombstone: true,
	}),
);
