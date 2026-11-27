import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";

const [origin, config] = process.argv.slice(2);
assert.match(origin ?? "", /^http:\/\/127\.0\.0\.1:376[24]$/);
assert.ok(config);
const cli = (...args) =>
	JSON.parse(
		execFileSync(
			process.execPath,
			[
				`--env-file=${config}`,
				"node_modules/convex/bin/main.js",
				"run",
				...args,
			],
			{ cwd: new URL("../", import.meta.url), encoding: "utf8" },
		),
	);
const run = (name, args = {}) => {
	// Internal mutations that return void can print no value.
	const output = execFileSync(
		process.execPath,
		[
			`--env-file=${config}`,
			"node_modules/convex/bin/main.js",
			"run",
			name,
			JSON.stringify(args),
		],
		{ cwd: new URL("../", import.meta.url), encoding: "utf8" },
	);
	return output.trim() ? JSON.parse(output) : null;
};

const issuer = "https://anchor-retention-import.invalid";
const bundle = createHash("sha256").update(randomUUID()).digest("hex");
const expectedCounts = {
	notes: 2,
	tags: 1,
	noteRevisions: 1,
	noteAttachments: 1,
};
const owner = randomUUID();
const trashed = randomUUID();
const deleted = randomUUID();
const tag = randomUUID();
const stale = Date.now() - 100 * 24 * 60 * 60 * 1000;
const begin = () =>
	run("migrations:begin", {
		bundle,
		issuer,
		totalBatches: 4,
		expectedCounts,
	});
const apply = (batch, table, rows) =>
	run("migrations:apply", {
		bundle,
		batch,
		table,
		rows,
	});
begin();
apply(0, "notes", [
	{
		data: {
			id: trashed,
			owner,
			state: "trashed",
			stateChangedAt: stale,
			title: "Trashed",
			content: null,
			version: 1,
			updatedAt: stale,
		},
	},
	{
		data: {
			id: deleted,
			owner,
			state: "deleted",
			stateChangedAt: stale,
			title: "Deleted",
			content: null,
			version: 1,
			updatedAt: stale,
		},
	},
]);
apply(1, "tags", [
	{
		data: {
			id: tag,
			owner,
			name: "Deleted tag",
			color: null,
			position: null,
			version: 1,
			isDeleted: true,
			updatedAt: stale,
		},
	},
]);
apply(2, "noteRevisions", [
	{
		note: trashed,
		data: {
			reportedAt: stale,
			version: 1,
			title: "Aged edit",
			content: null,
			authorSubject: owner,
			cause: "edit",
		},
	},
]);
const payload = "Attachment waiting for its import batch";
const url = await run("migrations:upload", { bundle, batch: 3 });
const uploaded = await fetch(url, {
	method: "POST",
	headers: { "Content-Type": "application/vnd.anchor.attachment" },
	body: payload,
});
assert.equal(uploaded.status, 200);
const { storageId } = await uploaded.json();
const inspect = () =>
	cli(
		"--inline-query",
		`
	const [trashed, deleted, tag, blob, revisions, files] = await Promise.all([
		ctx.db.query("notes").withIndex("by_note_id", q => q.eq("id", ${JSON.stringify(trashed)})).unique(),
		ctx.db.query("notes").withIndex("by_note_id", q => q.eq("id", ${JSON.stringify(deleted)})).unique(),
		ctx.db.query("tags").withIndex("by_tag_id", q => q.eq("id", ${JSON.stringify(tag)})).unique(),
		ctx.db.system.get("_storage", ${JSON.stringify(storageId)}),
		ctx.db.query("noteRevisions").first(),
		ctx.db.query("noteAttachments").first(),
	]);
	return { trashed: trashed?.state ?? null, deleted: deleted?.state ?? null, tag: !!tag, blob: !!blob, revisions: !!revisions, files: !!files };
`,
	);
const before = {
	trashed: "trashed",
	deleted: "deleted",
	tag: true,
	blob: true,
	revisions: true,
	files: false,
};
assert.deepEqual(inspect(), before);
run("notes:expireTrashBatch");
run("tombstones:purgeExpired");
run("notes:pruneSyncRemovals");
run("revisionRetention:prune");
run("attachments:collectOrphanUploads", { cutoff: Date.now() });
assert.deepEqual(inspect(), before);
assert.equal(begin().nextBatch, 3);
apply(3, "noteAttachments", [
	{
		note: trashed,
		data: {
			id: randomUUID(),
			uploadedByUserId: owner,
			originalFilename: "fixture.wav",
			mimeType: "audio/wav",
			fileSize: Buffer.byteLength(payload),
		},
		blob: {
			id: storageId,
			sha256: createHash("sha256").update(payload).digest("hex"),
		},
	},
]);
assert.equal(run("migrations:finish", { bundle }).complete, true);
assert.deepEqual(inspect(), { ...before, files: true });

run("tombstones:purgeExpired");
run("revisionRetention:prune");
for (let attempt = 0; attempt < 20; attempt++) {
	const result = inspect();
	if (!result.deleted && !result.tag && !result.revisions) {
		assert.deepEqual(result, {
			...before,
			deleted: null,
			tag: false,
			revisions: false,
			files: true,
		});
		break;
	}
	if (attempt === 19) assert.fail("Maintenance did not resume after import");
	await setTimeout(200);
}
console.log(
	JSON.stringify({
		pausedImportPreserved: true,
		pendingUploadImported: true,
		completedImportPruned: true,
	}),
);
