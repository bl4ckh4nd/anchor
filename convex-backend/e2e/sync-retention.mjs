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
			"X-Anchor-Protocol": "4",
			...(token ? { Authorization: "Bearer " + token } : {}),
		},
		body: data === undefined ? undefined : JSON.stringify(data),
	});
	assert.equal(response.status, status, method + " " + path);
	return response.json();
}
const register = () =>
	call("auth/register", "POST", 201, null, {
		name: "Sync retention fixture",
		email: `sync-retention-${randomUUID()}@example.test`,
		password: "SyntheticRetention2026!",
	});
const [owner, other] = await Promise.all([register(), register()]);
const writer = owner.access_token;
const reader = other.access_token;
const create = (title, token = writer) =>
	call("notes", "POST", 201, token, { title });
const remove = (id) =>
	call("notes/" + id + "/permanent", "DELETE", 200, writer);
const pull = (path, token, cursor) =>
	call(path, "POST", 200, token, { cursor, limit: 1 });
async function drain(path, token, page = null) {
	const entries = [];
	do {
		page = await pull(path, token, page?.nextCursor);
		assert.equal(page.resetRequired ?? false, false);
		entries.push(...page.entries);
	} while (page.hasMore);
	return { cursor: page.nextCursor, entries };
}

const old = await create("Removal eligible for pruning");
const fresh = await create("Removal still in retention");
const unaffected = await create("Unrelated active note", reader);
const before = await drain("compose/sync", writer);
const legacyBefore = await drain("sync", writer);
const otherBefore = await drain("compose/sync", reader);
const midSnapshot = await pull("compose/sync", writer);
assert.ok(midSnapshot.hasMore);
await remove(old.id);
const observed = await drain("compose/sync", writer, {
	nextCursor: before.cursor,
});
assert.ok(
	observed.entries.some(
		(row) => row.entityId === old.id && row.op === "remove",
	),
);
const cutoff = Date.now() + 1;
await setTimeout(25);
await remove(fresh.id);

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
cli("notes:pruneSyncRemovals", "{}");
assert.equal(
	(await pull("compose/sync", writer, before.cursor)).resetRequired ?? false,
	false,
);
cli("notes:pruneSyncRemovals", JSON.stringify({ cutoff }));
let rows;
for (let attempt = 0; attempt < 20; attempt++) {
	rows = JSON.parse(
		cli(
			"--inline-query",
			`const note = await ctx.db.query("notes").withIndex("by_note_id", q => q.eq("id", ${JSON.stringify(old.id)})).unique(); const rows = await ctx.db.query("noteFeed").withIndex("by_recipient_seq", q => q.eq("issuer", note.issuer).eq("subject", note.owner)).collect(); return rows.map(row => [row.entityId, row.op]);`,
		),
	);
	if (!rows.some(([id, op]) => id === old.id && op === "remove")) break;
	if (attempt === 19) assert.fail("Eligible removal survived maintenance");
	await setTimeout(200);
}
assert.ok(rows.some(([id, op]) => id === old.id && op === "upsert"));
assert.ok(rows.some(([id, op]) => id === fresh.id && op === "remove"));
assert.equal(
	(await pull("compose/sync", writer, before.cursor)).resetRequired,
	true,
);
assert.equal(
	(await pull("sync", writer, legacyBefore.cursor)).resetRequired,
	true,
);
assert.equal(
	(await pull("compose/sync", writer, midSnapshot.nextCursor)).resetRequired,
	true,
);
assert.ok(
	(
		await drain("compose/sync", writer, { nextCursor: observed.cursor })
	).entries.some((row) => row.entityId === fresh.id && row.op === "remove"),
);
assert.deepEqual((await drain("compose/sync", writer)).entries, []);
assert.ok(otherBefore.entries.some((row) => row.entityId === unaffected.id));
assert.deepEqual(
	(await drain("compose/sync", reader, { nextCursor: otherBefore.cursor }))
		.entries,
	[],
);
console.log(
	JSON.stringify({
		removedOnlyExpired: true,
		resetStaleLegacyAndCompose: true,
		retainedOtherCursors: true,
	}),
);
