import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";

const [origin, config] = process.argv.slice(2);
assert.equal(origin, "http://127.0.0.1:3735");
assert.ok(config);
async function call(path, method, status, token, data) {
	const form = data instanceof FormData;
	const response = await fetch(origin + "/api/" + path, {
		method,
		headers: {
			...(token ? { Authorization: "Bearer " + token } : {}),
			...(form ? {} : { "Content-Type": "application/json" }),
		},
		body: form ? data : data === undefined ? undefined : JSON.stringify(data),
	});
	assert.equal(response.status, status, method + " " + path);
	return response.headers.get("content-type")?.startsWith("application/json")
		? response.json()
		: response.text();
}
const register = () =>
	call("auth/register", "POST", 201, null, {
		name: "Retention fixture",
		email: `retention-${randomUUID()}@example.test`,
		password: "SyntheticTrash2026!",
	});
const [owner, viewer] = await Promise.all([register(), register()]);
const writer = owner.access_token;
const reader = viewer.access_token;
const create = (title) => call("notes", "POST", 201, writer, { title });
const oldest = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
const path = (note) => "notes/" + note.id;
const trash = (note, backdate = false) =>
	call(
		path(note) + (backdate ? "?trashedAt=" + oldest : ""),
		"DELETE",
		200,
		writer,
	);

const source = await create("Expired source");
const recent = await create("Recent trash");
const restored = await create("Restored in time");
const media = new FormData();
media.set(
	"file",
	new Blob(["archive fixture bytes"], { type: "audio/wav" }),
	"fixture.wav",
);
await call(path(source) + "/attachments", "POST", 201, writer, media);
await call(path(source) + "/shares", "POST", 201, writer, {
	sharedWithUserId: viewer.user.id,
	permission: "viewer",
});
const duplicate = await call(path(source) + "/duplicate", "POST", 201, reader);
const [duplicateFile] = await call(
	path(duplicate) + "/attachments",
	"GET",
	200,
	reader,
);
await trash(source, true);
await trash(recent);
await trash(restored, true);
await call(path(restored) + "/restore", "PATCH", 200, writer);
const expired = [source];
for (let i = 0; i < 8; i++) {
	const note = await create("Expired batch fixture");
	await trash(note, true);
	expired.push(note);
}

const pull = (token, cursor) =>
	call("compose/sync", "POST", 200, token, { cursor });
async function currentCursor(token) {
	let page = await pull(token);
	while (page.hasMore) page = await pull(token, page.nextCursor);
	return page.nextCursor;
}
const [writerCursor, readerCursor] = await Promise.all([
	currentCursor(writer),
	currentCursor(reader),
]);
const cli = (...params) =>
	execFileSync(
		process.execPath,
		[
			`--env-file=${config}`,
			"node_modules/convex/bin/main.js",
			"run",
			...params,
		],
		{ cwd: new URL("../", import.meta.url), encoding: "utf8" },
	);
cli("notes:expireTrashBatch", "{}");
const ids = expired.map(({ id }) => id);
for (let attempt = 0; attempt < 20; attempt++) {
	const done = JSON.parse(
		cli(
			"--inline-query",
			`const ids = ${JSON.stringify(ids)}; const rows = await Promise.all(ids.map(id => ctx.db.query("notes").withIndex("by_note_id", q => q.eq("id", id)).unique())); const source = rows[0]; return rows.every(row => row?.state === "deleted" && row.version === 3) && !(await ctx.db.query("noteAttachments").withIndex("by_note_id", q => q.eq("noteId", source._id)).first());`,
		),
	);
	if (done) break;
	if (attempt === 19)
		assert.fail("Expired notes or source file metadata survived maintenance");
	await setTimeout(200);
}
await call(path(source), "GET", 404, writer);
assert.equal((await call(path(recent), "GET", 200, writer)).state, "trashed");
assert.equal((await call(path(restored), "GET", 200, writer)).state, "active");
assert.equal(
	await call(
		path(duplicate) + "/attachments/" + duplicateFile.id,
		"GET",
		200,
		reader,
	),
	"archive fixture bytes",
);
const ownerDelta = await pull(writer, writerCursor);
assert.deepEqual(
	new Set(
		ownerDelta.entries
			.filter((row) => row.op === "remove")
			.map((row) => row.entityId),
	),
	new Set(ids),
);
const readerDelta = await pull(reader, readerCursor);
assert.deepEqual(
	readerDelta.entries.map(({ entityId, op }) => [entityId, op]),
	[[source.id, "remove"]],
);
console.log(
	JSON.stringify({
		expiredAcrossBatches: true,
		tombstonesAndFeed: true,
		freshAndRestoredIntact: true,
		sharedBytesIntact: true,
	}),
);
