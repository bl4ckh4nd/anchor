import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";

const [origin, config] = process.argv.slice(2);
assert.equal(origin, "http://127.0.0.1:3735");
assert.ok(config);

async function call(path, method, status, token, data) {
	const response = await fetch(origin + "/api/" + path, {
		method,
		headers: {
			"Content-Type": "application/json",
			...(token ? { Authorization: "Bearer " + token } : {}),
		},
		body: data === undefined ? undefined : JSON.stringify(data),
	});
	assert.equal(response.status, status, method + " " + path);
	return response.json();
}
const register = () =>
	call("auth/register", "POST", 201, null, {
		name: "Tombstone fixture",
		email: `tombstone-${randomUUID()}@example.test`,
		password: "SyntheticTombstone2026!",
	});
const [owner, recipient] = await Promise.all([register(), register()]);
const writer = owner.access_token;
const create = (title) => call("notes", "POST", 201, writer, { title });
const expire = (note) =>
	call("notes/" + note.id + "/permanent", "DELETE", 200, writer);
const [doomed, fresh, live] = await Promise.all([
	create("Purge expired"),
	create("Retain recent"),
	create("Retain active"),
]);
const share = (note) =>
	call("notes/" + note.id + "/shares", "POST", 201, writer, {
		sharedWithUserId: recipient.user.id,
		permission: "viewer",
	});
await share(doomed);
await call("notes/" + doomed.id, "PATCH", 200, writer, {
	title: "Revision prior to deletion",
	baseVersion: 1,
});
const revoked = await share(live);
await call("notes/" + live.id + "/shares/" + revoked.id, "DELETE", 200, writer);
const tag = await call("tags", "POST", 201, writer, { name: "Expired tag" });
await call("tags/" + tag.id, "DELETE", 200, writer);
await expire(doomed);
const cutoff = Date.now() + 1;
await setTimeout(25);
await expire(fresh);

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
const inspect = () =>
	JSON.parse(
		cli(
			"--inline-query",
			`
	const ids = ${JSON.stringify([doomed.id, fresh.id, live.id, tag.id, recipient.user.id])};
	const [expired, fresh, live] = await Promise.all(ids.slice(0, 3).map(id => ctx.db.query("notes").withIndex("by_note_id", q => q.eq("id", id)).unique()));
	const tag = await ctx.db.query("tags").withIndex("by_tag_id", q => q.eq("id", ids[3])).unique();
	const share = await ctx.db.query("noteShares").withIndex("by_note_subject", q => q.eq("noteId", live._id).eq("subject", ids[4])).unique();
	const feed = await ctx.db.query("noteFeed").withIndex("by_recipient_seq", q => q.eq("issuer", live.issuer).eq("subject", live.owner)).collect();
	return { expiredId: expired?._id ?? null, fresh: fresh?.state, live: live?.state, tag: tag?.isDeleted ?? null, share: share?.isRevoked ?? null, noteRemove: feed.some(row => row.entityId === ids[0] && row.op === "remove") };
`,
		),
	);
const before = inspect();
assert.ok(before.expiredId);
assert.equal(before.tag, true);
assert.equal(before.share, true);
cli("tombstones:purgeExpired", "{}");
assert.deepEqual(inspect(), before);
cli("tombstones:purgeExpired", JSON.stringify({ cutoff }));
const expected = {
	expiredId: null,
	fresh: "deleted",
	live: "active",
	tag: null,
	share: null,
	noteRemove: true,
};
for (let attempt = 0; attempt < 30; attempt++) {
	const state = inspect();
	if (state.expiredId === null && state.tag === null && state.share === null) {
		assert.deepEqual(state, expected);
		break;
	}
	if (attempt === 29) assert.deepEqual(state, expected);
	await setTimeout(200);
}
const children = JSON.parse(
	cli(
		"--inline-query",
		`
	const noteId = ${JSON.stringify(before.expiredId)};
	const shares = await ctx.db.query("noteShares").withIndex("by_note_subject", q => q.eq("noteId", noteId)).first();
	const revisions = await ctx.db.query("noteRevisions").withIndex("by_note", q => q.eq("noteId", noteId)).first();
	return { shares, revisions };
`,
	),
);
assert.deepEqual(children, { shares: null, revisions: null });
console.log(
	JSON.stringify({
		purgedOnlyExpired: true,
		purgedDependents: true,
		keptRemovalFeed: true,
	}),
);
