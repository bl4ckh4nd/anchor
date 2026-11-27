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

const register = (name) =>
	request("auth/register", "POST", 201, null, {
		name,
		email: `history-${randomUUID()}@example.test`,
		password: "SyntheticHistory2026!",
	});
const [owner, reader] = await Promise.all([
	register("History owner"),
	register("History reader"),
]);
const token = owner.access_token;
const { apiToken } = await request(
	"auth/api-token/regenerate",
	"POST",
	200,
	token,
);
const note = await request("notes", "POST", 201, token, {
	title: "First",
	content: "Original document",
});
const path = "notes/" + note.id;
const history = path + "/revisions";
await request(history, "GET", 401);
assert.deepEqual(await request(history, "GET", 200, token), {
	revisions: [],
	nextCursor: null,
});
await request(path, "PATCH", 200, token, {
	title: "Second",
	content: "Second document",
	baseVersion: 1,
});
await request(path, "PATCH", 409, token, {
	title: "Draft",
	content: "Conflict document",
	baseVersion: 1,
});
await request(history + "?limit=0", "GET", 400, token);
const first = await request(history + "?limit=1", "GET", 200, apiToken);
const [summary] = first.revisions;
assert.equal(summary.noteId, note.id);
assert.equal(summary.cause, "conflict");
assert.equal(summary.author.id, owner.user.id);
assert.equal(summary.author.name, "History owner");
assert.ok(!Number.isNaN(Date.parse(summary.createdAt)));
assert.equal("content" in summary, false);
assert.equal(first.nextCursor, summary.id);
const second = await request(
	history + "?withContent=true&limit=1&cursor=" + first.nextCursor,
	"GET",
	200,
	token,
);
assert.equal(second.revisions[0].content, "Original document");
assert.equal(second.nextCursor, null);
const draftPath = history + "/" + summary.id;
assert.equal(
	(await request(draftPath, "GET", 200, token)).content,
	"Conflict document",
);
const other = await request("notes", "POST", 201, token, { title: "Other" });
await request(
	"notes/" + other.id + "/revisions/" + summary.id,
	"GET",
	404,
	token,
);

const shared = await fetch("http://127.0.0.1:3734/api/mutation", {
	method: "POST",
	headers: {
		Authorization: "Bearer " + token,
		"Content-Type": "application/json",
	},
	body: JSON.stringify({
		path: "notes:setShare",
		args: {
			id: note.id,
			subject: reader.user.id,
			permission: "viewer",
		},
	}),
});
assert.equal((await shared.json()).status, "success");
await request(history, "GET", 403, reader.access_token);
await request(draftPath + "/restore", "POST", 403, reader.access_token);
await request(path, "DELETE", 200, token);
await request(draftPath, "GET", 200, token);
await request(draftPath + "/restore", "POST", 400, token);
const active = await request(path + "/restore", "PATCH", 200, token);
const restored = await request(draftPath + "/restore", "POST", 200, apiToken);
assert.equal(restored.title, "Draft");
assert.equal(restored.content, "Conflict document");
assert.equal(restored.version, active.version + 1);
assert.equal(
	(await request(draftPath + "/restore", "POST", 200, token)).version,
	restored.version,
);
const final = await request(history + "?withContent=true", "GET", 200, token);
assert.equal(final.revisions[0].cause, "restore");
assert.equal(final.revisions[0].content, "Second document");
assert.equal(final.revisions.length, 3);
const beforeRestorePath = history + "/" + final.revisions[0].id + "/restore";
const invalid = await request(
	beforeRestorePath + "?baseVersion=0",
	"POST",
	400,
	token,
);
assert.equal(invalid.code, "INVALID_BASE_VERSION");
const stale = await request(
	beforeRestorePath + "?baseVersion=" + active.version,
	"POST",
	409,
	token,
);
assert.equal(stale.code, "NOTE_CHANGED");
assert.equal(
	(await request(path, "GET", 200, token)).content,
	"Conflict document",
);
const undone = await request(
	beforeRestorePath + "?baseVersion=" + restored.version,
	"POST",
	200,
	token,
);
assert.equal(undone.content, "Second document");
assert.equal(undone.version, restored.version + 1);
const pull = await request("compose/sync", "POST", 200, token, {});
assert.equal(
	pull.entries.find((entry) => entry.note?.id === note.id).note.content,
	"Second document",
);
console.log(
	JSON.stringify({
		pagination: true,
		author: true,
		conflictRecovery: true,
		noteAndPermissionIsolation: true,
		trashGuard: true,
		composeReadback: true,
		guardedUndo: true,
	}),
);
