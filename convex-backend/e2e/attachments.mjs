import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, randomUUID, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { parseEnv } from "node:util";

const [origin, keyFile, apiOrigin, adminEnvFile] = process.argv.slice(2);
assert.match(origin ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
assert.match(apiOrigin ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
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

const id = randomUUID();
const token = tokenFor("attachment-owner-" + id);
const readerSubject = "attachment-reader-" + id;
const reader = tokenFor(readerSubject);
const outsider = tokenFor("attachment-outsider-" + id);
const response = await fetch(new URL("/api/compose/notes", origin), {
	method: "POST",
	headers: {
		authorization: `Bearer ${token}`,
		"content-type": "application/json",
	},
	body: JSON.stringify({ id, title: "Attachment fixture" }),
});
assert.equal(response.status, 200);
const attachmentId = randomUUID();
const url = new URL("/api/compose/attachments", origin);
url.search = new URLSearchParams({ noteId: id, attachmentId });
const bytes = Buffer.alloc(50 * 1024 * 1024, 73);
const hash = createHash("sha256").update(bytes).digest("hex");

const adminEnv = adminEnvFile && parseEnv(readFileSync(adminEnvFile, "utf8"));
if (adminEnv) assert.equal(adminEnv.CONVEX_SELF_HOSTED_URL, apiOrigin);
function readDeployment(inlineQuery) {
	return JSON.parse(runDeployment(["--inline-query", inlineQuery]));
}
function runDeployment(args) {
	return execFileSync(
		process.execPath,
		[
			"node_modules/convex/bin/main.js",
			"run",
			"--env-file",
			resolve(adminEnvFile),
			...args,
		],
		{
			cwd: new URL("../", import.meta.url),
			encoding: "utf8",
			timeout: 10000,
		},
	);
}
function readAttachmentRows() {
	return readDeployment(`const note = await ctx.db.query("notes").withIndex("by_note_id", q => q.eq("id", ${JSON.stringify(id)})).unique();
		const rows = await ctx.db.query("noteAttachments").withIndex("by_note_id", q => q.eq("noteId", note._id)).collect();
		return rows.map(({id, storageId, deletedAt}) => ({id, storageId, deletedAt: deletedAt ?? null}));`);
}
function hasBlob(storageId) {
	return readDeployment(
		`return (await ctx.db.system.get("_storage", ${JSON.stringify(storageId)})) !== null;`,
	);
}

function upload(body, credential = token, type = "audio/wav") {
	return fetch(url, {
		method: "POST",
		headers: {
			...(credential ? { authorization: `Bearer ${credential}` } : {}),
			"content-type": type,
			"x-anchor-filename-encoded": encodeURIComponent("Aufnahme ä.wav"),
		},
		body,
	});
}
function download(credential, range) {
	return fetch(url, {
		headers: {
			authorization: `Bearer ${credential}`,
			...(range ? { range } : {}),
		},
	});
}
function remove(credential) {
	return fetch(url, {
		method: "DELETE",
		headers: credential ? { authorization: `Bearer ${credential}` } : {},
	});
}
async function share(permission) {
	const result = await fetch(new URL("/api/mutation", apiOrigin), {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			path: "notes:setShare",
			args: { id, subject: readerSubject, permission },
		}),
	});
	assert.equal((await result.json()).status, "success");
}
async function syncPage(
	credential,
	cursor,
	attachmentMetadata,
	attachmentOrder,
) {
	const result = await fetch(new URL("/api/compose/sync", origin), {
		method: "POST",
		headers: {
			authorization: `Bearer ${credential}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({ cursor, attachmentMetadata, attachmentOrder }),
	});
	assert.equal(result.status, 200);
	return result.json();
}
async function sync(credential, cursor, attachmentMetadata, attachmentOrder) {
	const entries = [];
	let page;
	do {
		page = await syncPage(
			credential,
			cursor,
			attachmentMetadata,
			attachmentOrder,
		);
		entries.push(...page.entries);
		cursor = page.nextCursor;
	} while (page.hasMore);
	return { entries, nextCursor: cursor };
}

const beforeUpload = await sync(token);
assert.equal(beforeUpload.entries[0].note.version, 1);
assert.equal((await upload(bytes, null)).status, 401);
assert.equal((await upload(Buffer.alloc(1), outsider)).status, 404);
assert.equal((await upload(Buffer.alloc(1), token, "text/html")).status, 415);
assert.equal((await upload(Buffer.alloc(bytes.length + 1))).status, 413);
const sent = await upload(bytes);
assert.equal(sent.status, 201, await sent.clone().text());
const attachment = await sent.json();
assert.equal(attachment.id, attachmentId);
assert.equal(attachment.fileSize, bytes.length);
assert.equal(attachment.originalFilename, "Aufnahme ä.wav");
assert.equal(attachment.storageId, undefined);
const uploadDelta = await sync(token, beforeUpload.nextCursor);
const ownerNote = uploadDelta.entries.find(
	(entry) => entry.entityId === id,
)?.note;
assert.equal(ownerNote?.version, 1);
assert.deepEqual(ownerNote.attachments, [attachment]);
assert.equal((await download(reader)).status, 404);
const received = await download(token);
assert.equal(received.status, 200);
assert.equal(received.headers.get("cache-control"), "private, no-store");
assert.equal(received.headers.get("content-type"), "audio/wav");
const digest = createHash("sha256");
let total = 0;
for await (const chunk of received.body) {
	digest.update(chunk);
	total += chunk.byteLength;
}
assert.equal(total, bytes.length);
assert.equal(digest.digest("hex"), hash);
const retry = await upload(bytes);
assert.equal(retry.status, 200);
assert.deepEqual(await retry.json(), attachment);
assert.deepEqual((await sync(token, uploadDelta.nextCursor)).entries, []);
assert.equal(
	(await syncPage(token, uploadDelta.nextCursor, true)).resetRequired,
	true,
);
const backfilled = await sync(token, undefined, true);
assert.deepEqual(backfilled.entries[0].note.attachments, [attachment]);
assert.deepEqual((await sync(token, backfilled.nextCursor, true)).entries, []);
assert.match(backfilled.nextCursor, /^n4:/);
assert.equal(
	(await syncPage(token, backfilled.nextCursor, undefined, true)).resetRequired,
	true,
);
const orderedSnapshot = await sync(token, undefined, undefined, true);
assert.match(orderedSnapshot.nextCursor, /^n5:/);
assert.deepEqual(orderedSnapshot.entries[0].note.attachments, [attachment]);
assert.deepEqual(
	(await sync(token, orderedSnapshot.nextCursor, undefined, true)).entries,
	[],
);
await share("viewer");
const readerSnapshot = await sync(reader);
assert.deepEqual(readerSnapshot.entries[0].note.attachments, [attachment]);
assert.equal((await upload(bytes.subarray(0, 1), reader)).status, 404);
for (const [range, start, end] of [
	["bytes=17-31", 17, 31],
	["bytes=-8", bytes.length - 8, bytes.length - 1],
	["bytes=52428799-", bytes.length - 1, bytes.length - 1],
]) {
	const partial = await download(reader, range);
	assert.equal(partial.status, 206);
	assert.equal(
		partial.headers.get("content-range"),
		`bytes ${start}-${end}/${bytes.length}`,
	);
	assert.deepEqual(
		Buffer.from(await partial.arrayBuffer()),
		bytes.subarray(start, end + 1),
	);
}
const outside = await download(reader, `bytes=${bytes.length}-`);
assert.equal(outside.status, 416);
assert.equal(outside.headers.get("content-range"), `bytes */${bytes.length}`);
await share(null);
assert.equal((await download(reader, "bytes=0-0")).status, 404);
const readerDelta = await sync(reader, readerSnapshot.nextCursor);
assert.ok(
	readerDelta.entries.some(
		(entry) => entry.entityId === id && entry.op === "remove",
	),
);
assert.equal((await sync(reader)).entries.length, 0);
console.log(
	"Passed: 50 MiB upload, SHA-256 readback, idempotent replay, size limit, ranges, metadata sync and share revocation.",
);

await share("viewer");
assert.equal((await remove(null)).status, 401);
assert.equal((await remove(outsider)).status, 404);
assert.equal((await remove(reader)).status, 404);
await share("editor");
assert.equal((await remove(reader)).status, 400);

const editorAttachmentId = randomUUID();
url.searchParams.set("attachmentId", editorAttachmentId);
assert.equal(
	(await upload(Buffer.from("editor attachment"), reader)).status,
	201,
);
const blobs = adminEnv
	? Object.fromEntries(
			readAttachmentRows().map(({ id, storageId }) => [id, storageId]),
		)
	: {};
if (adminEnv) {
	assert.equal(hasBlob(blobs[editorAttachmentId]), true);
	assert.equal(hasBlob(blobs[attachmentId]), true);
	assert.equal(
		readDeployment(
			`return (await ctx.db.system.get("_storage", ${JSON.stringify(blobs[attachmentId])})).contentType;`,
		),
		"application/vnd.anchor.attachment",
	);
	runDeployment([
		"attachments:collectOrphanUploads",
		JSON.stringify({ cutoff: Date.now() }),
	]);
	assert.equal(hasBlob(blobs[attachmentId]), true);
	assert.equal(hasBlob(blobs[editorAttachmentId]), true);
}
assert.equal((await remove(reader)).status, 200);
assert.equal((await download(reader, "bytes=0-0")).status, 404);
assert.equal((await upload(Buffer.from("stale retry"), reader)).status, 410);
if (adminEnv) assert.equal(hasBlob(blobs[editorAttachmentId]), false);

url.searchParams.set("attachmentId", attachmentId);
const beforeDelete = await sync(reader);
assert.deepEqual(beforeDelete.entries[0].note.attachments, [attachment]);
assert.deepEqual(await (await remove(token)).json(), { success: true });
if (adminEnv) assert.equal(hasBlob(blobs[attachmentId]), false);
assert.equal((await download(token, "bytes=0-0")).status, 404);
assert.equal((await remove(token)).status, 200);
const afterDelete = await sync(reader, beforeDelete.nextCursor);
assert.equal(afterDelete.entries.length, 1);
assert.equal(afterDelete.entries[0].note.version, 1);
assert.equal(afterDelete.entries[0].note.attachments, undefined);
assert.equal((await upload(Buffer.from("stale retry"))).status, 410);
assert.deepEqual((await sync(reader, afterDelete.nextCursor)).entries, []);

const purgeId = randomUUID();
url.searchParams.set("attachmentId", purgeId);
assert.equal((await upload(Buffer.from(`purge-${purgeId}`))).status, 201);
let purgeBlobs;
if (adminEnv) {
	for (let remaining = 32; remaining > 0; remaining--) {
		url.searchParams.set("attachmentId", randomUUID());
		assert.equal(
			(await upload(Buffer.from(`purge-batch-${remaining}`))).status,
			201,
		);
	}
	purgeBlobs = readAttachmentRows()
		.filter(({ deletedAt }) => deletedAt === null)
		.map(({ storageId }) => storageId);
	assert.equal(purgeBlobs.length, 33);
	assert.equal(hasBlob(purgeBlobs[0]), true);
}
const lifecycle = await fetch(new URL("/api/compose/sync", origin), {
	method: "POST",
	headers: {
		authorization: `Bearer ${token}`,
		"content-type": "application/json",
	},
	body: JSON.stringify({
		changes: [
			{
				type: "note",
				id,
				baseVersion: 1,
				title: "Attachment fixture",
				state: "deleted",
			},
		],
	}),
});
assert.equal(lifecycle.status, 200);
assert.equal((await lifecycle.json()).results[0].status, "applied");
assert.equal((await download(token, "bytes=0-0")).status, 404);
assert.equal((await upload(Buffer.from("deleted note"))).status, 404);
if (adminEnv) {
	for (
		let attempt = 0;
		attempt < 12 && readAttachmentRows().length;
		attempt++
	) {
		await setTimeout(250);
	}
	assert.deepEqual(readAttachmentRows(), []);
	assert.equal(
		readDeployment(
			`const blobs = await Promise.all(${JSON.stringify(purgeBlobs)}.map(id => ctx.db.system.get("_storage", id))); return blobs.filter(Boolean).length;`,
		),
		0,
	);
	console.log(
		"Passed: Convex storage readback confirmed individual deletions and a 33-blob note purge across batches.",
	);
}
console.log(
	JSON.stringify({ noteId: id, attachmentId, editorAttachmentId, purgeId }),
);
console.log(
	"Passed: attachment deletion roles, retry, feed removal and permanent note deletion.",
);
