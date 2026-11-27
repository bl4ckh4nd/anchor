import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";

const origin = "http://127.0.0.1:" + process.env.ANCHOR_CONVEX_SITE_PORT;
const report = process.argv[2];
assert.ok(report);
async function call(path, method, expected, token, data) {
	const multipart = data instanceof FormData;
	const res = await fetch(origin + "/api/" + path, {
		method,
		headers: {
			...(token ? { Authorization: "Bearer " + token } : {}),
			...(!multipart && data !== undefined ? { "Content-Type": "application/json" } : {}),
		},
		body: multipart ? data : data === undefined ? undefined : JSON.stringify(data),
	});
	assert.equal(res.status, expected, method + " " + path);
	return res.json();
}
async function register() {
	const account = await call("auth/register", "POST", 201, null, {
		name: "Undo fixture",
		email: `undo-${randomUUID()}@example.test`,
		password: "SyntheticUndo2026!",
	});
	return account.access_token;
}
const [owner, other] = await Promise.all([register(), register()]);
const source = await call("notes", "POST", 201, owner, { title: "Source for undo" });
const sourcePath = "notes/" + source.id;
const copy = () => call(sourcePath + "/duplicate?undo=true", "POST", 201, owner);
const undo = (note, expected = 200, token = owner) => call(
	`notes/${note.id}/duplicate/undo?baseSequence=${note.undoSequence}`, "POST", expected, token,
);
const original = await copy();
assert.match(original.undoSequence ?? "", /^[1-9]\d*$/);
await undo(original, 404, other);
await undo({ ...original, undoSequence: "9223372036854775808" }, 400);
await undo({ ...original, id: source.id }, 409);
await call("notes", "POST", 201, owner, { title: "Unrelated later note" });
await undo(original);
await undo(original);
await call("notes/" + original.id, "GET", 404, owner);
assert.equal((await call(sourcePath, "GET", 200, owner)).title, source.title);

const edited = await copy();
await call("notes/" + edited.id, "PATCH", 200, owner, { title: "Retain later edit" });
assert.equal((await undo(edited, 409)).code, "NOTE_CHANGED");
assert.equal((await call("notes/" + edited.id, "GET", 200, owner)).title, "Retain later edit");

const withFile = await copy();
const body = new FormData();
body.set("file", new Blob(["fixture bytes"], { type: "audio/wav" }), "later.wav");
const attachment = await call("notes/" + withFile.id + "/attachments", "POST", 201, owner, body);
assert.equal((await call("notes/" + withFile.id, "GET", 200, owner)).version, withFile.version);
assert.equal((await undo(withFile, 409)).code, "NOTE_CHANGED");
assert.equal((await call("notes/" + withFile.id + "/attachments", "GET", 200, owner))[0].id, attachment.id);
const legacy = await call(sourcePath + "/duplicate", "POST", 201, owner);
assert.equal(Object.hasOwn(legacy, "undoSequence"), false);
writeFileSync(report, JSON.stringify({
	unchangedCopyRemoved: true, idempotentUndo: true, wrongNoteAndAccountRejected: true,
	remoteEditProtected: true, unversionedAttachmentProtected: true, legacyShapePreserved: true,
}, null, 2) + "\n");
