import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { setTimeout } from "node:timers/promises";

const [origin, adminEnv] = process.argv.slice(2);
assert.equal(origin, "http://127.0.0.1:3735");
assert.ok(adminEnv);
const password = "SyntheticDuplicate2026!";
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
	const type = response.headers.get("content-type") ?? "";
	return type.startsWith("application/json")
		? response.json()
		: response.text();
}
const register = () =>
	call("auth/register", "POST", 201, null, {
		name: "Copy fixture",
		email: `copy-${randomUUID()}@example.test`,
		password,
	});
const [owner, viewer, outsider] = await Promise.all([
	register(),
	register(),
	register(),
]);
const writer = owner.access_token;
const reader = viewer.access_token;
const { apiToken } = await call(
	"auth/api-token/regenerate",
	"POST",
	200,
	reader,
);
const ownerTag = await call("tags", "POST", 201, writer, { name: "Owner tag" });
const viewerTag = await call("tags", "POST", 201, reader, {
	name: "Viewer tag",
});
const source = await call("notes", "POST", 201, writer, {
	title: "Source",
	content: "Fixture body",
	background: "blue",
	tagIds: [ownerTag.id],
});
const path = (note) => "notes/" + note.id;
const duplicate = (note, token, status = 201) =>
	call(path(note) + "/duplicate", "POST", status, token);
await duplicate(source, null, 401);
await duplicate(source, outsider.access_token, 404);
await call(path(source) + "/shares", "POST", 201, writer, {
	sharedWithUserId: viewer.user.id,
	permission: "viewer",
});
await call(path(source), "PATCH", 200, reader, {
	tagIds: [viewerTag.id],
	isPinned: true,
	isArchived: true,
	reminder: { remindAt: "2026-12-01T12:30" },
});
const files = [];
for (const filename of ["first.wav", "second.wav"]) {
	const form = new FormData();
	form.set("file", new Blob([filename], { type: "audio/wav" }), filename);
	files.unshift(
		await call(path(source) + "/attachments", "POST", 201, writer, form),
	);
}
const copy = await duplicate(source, apiToken);
assert.equal(copy.userId, viewer.user.id);
assert.equal(copy.state, "active");
assert.equal(copy.version, 1);
assert.equal(copy.content, source.content);
assert.equal(copy.background, source.background);
assert.deepEqual(copy.tagIds, [viewerTag.id]);
assert.deepEqual(copy.shareIds, []);
assert.equal(copy.reminder, null);
assert.equal(copy.isArchived, false);
assert.equal(copy.isPinned, false);
assert.equal(copy.attachmentCount, 2);
assert.notEqual(copy.id, source.id);
const getFiles = (note) =>
	call(path(note) + "/attachments", "GET", 200, reader);
const copiedFiles = await getFiles(copy);
assert.deepEqual(
	copiedFiles.map((x) => x.originalFilename),
	files.map((x) => x.originalFilename),
);
assert.deepEqual(
	copiedFiles.map((x) => x.position),
	[0, 1],
);
assert.ok(
	copiedFiles.every(
		(file) =>
			file.uploadedByUserId === viewer.user.id &&
			files.every((original) => original.id !== file.id),
	),
);
await call(path(copy), "GET", 404, writer);
const readFile = (note, file) =>
	call(path(note) + "/attachments/" + file.id, "GET", 200, reader);
const readCopies = async (note, list) => {
	for (const file of list)
		assert.equal(await readFile(note, file), file.originalFilename);
};
await readCopies(copy, copiedFiles);
const inspect = (source) =>
	JSON.parse(
		execFileSync(
			process.execPath,
			[
				`--env-file=${adminEnv}`,
				"node_modules/convex/bin/main.js",
				"run",
				"--inline-query",
				source,
			],
			{ cwd: new URL("../", import.meta.url), encoding: "utf8" },
		),
	);
const storageIds = (note) =>
	inspect(
		`const n = await ctx.db.query("notes").withIndex("by_note_id", q => q.eq("id", ${JSON.stringify(note.id)})).unique(); return (await ctx.db.query("noteAttachments").withIndex("by_note_id", q => q.eq("noteId", n._id)).collect()).map(a => a.storageId).sort();`,
	);
async function eventually(check, message) {
	for (let i = 0; i < 15; i++) {
		if (check()) return;
		await setTimeout(200);
	}
	assert.fail(message);
}
const originalBlobs = storageIds(source);
assert.deepEqual(storageIds(copy), originalBlobs);
await call(path(source) + "/attachments/" + files[0].id, "DELETE", 200, writer);
await readCopies(copy, copiedFiles);
const later = await duplicate(copy, reader);
const laterFiles = await getFiles(later);
await call(path(copy), "DELETE", 200, reader);
await duplicate(copy, reader, 404);
await call(path(copy) + "/permanent", "DELETE", 200, reader);
await eventually(
	() => storageIds(copy).length === 0,
	"The first copy's file rows were not purged",
);
await readCopies(later, laterFiles);
await call("auth/delete-account", "POST", 200, writer, { password });
await eventually(
	() =>
		inspect(
			`return await ctx.db.query("notes").withIndex("by_note_id", q => q.eq("id", ${JSON.stringify(source.id)})).unique() === null;`,
		),
	"The source note was not purged after account deletion",
);
await readCopies(later, laterFiles);
await call(path(later) + "/permanent", "DELETE", 200, reader);
await eventually(
	() =>
		inspect(
			`return (await Promise.all(${JSON.stringify(originalBlobs)}.map(id => ctx.db.system.get("_storage", id)))).every(x => x === null);`,
		),
	"The last copy did not release its blobs",
);
console.log(
	JSON.stringify({
		viewerCopy: true,
		ownTagsOnly: true,
		independentIds: true,
		threeDeletionPaths: true,
		releasedLastReference: true,
	}),
);
