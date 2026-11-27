import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";

const [origin, config] = process.argv.slice(2);
assert.equal(origin, "http://127.0.0.1:3735");
assert.ok(config);

async function request(path, method, status, token, body) {
	const response = await fetch(origin + "/api/" + path, {
		method,
		headers: {
			"Content-Type": "application/json",
			...(token ? { Authorization: "Bearer " + token } : {}),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	assert.equal(response.status, status, method + " " + path);
	return response.json();
}

const { access_token: token } = await request(
	"auth/register",
	"POST",
	201,
	null,
	{
		name: "Revision retention fixture",
		email: `revision-retention-${randomUUID()}@example.test`,
		password: "SyntheticRevision2026!",
	},
);
const create = (title) => request("notes", "POST", 201, token, { title });
const long = await create("Long history");
const short = await create("Short history");
const notePath = "notes/" + long.id;
await request(notePath, "PATCH", 200, token, {
	title: "Current",
	baseVersion: 1,
});
await request(notePath, "PATCH", 409, token, {
	title: "Recoverable conflict",
	content: "Preserved draft",
	baseVersion: 1,
});
const initial = await request(notePath + "/revisions", "GET", 200, token);
const conflict = initial.revisions.find(
	(revision) => revision.cause === "conflict",
);
assert.ok(conflict);
const stale = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString();
const revision = (title, cause, createdAt) => ({
	id: randomUUID(),
	title,
	cause,
	createdAt,
});
async function push(note, revisions) {
	const { results } = await request("compose/sync", "POST", 200, token, {
		changes: [
			{
				type: "note",
				id: note.id,
				title: note.title,
				revisionsOnly: true,
				revisions,
			},
		],
	});
	assert.equal(results[0].status, "applied");
}
await push(short, [
	revision("Aged edit", "edit", stale),
	revision("Aged restore", "restore", stale),
]);
const when = Math.max(Date.now(), Date.parse(conflict.createdAt) + 2);
await setTimeout(25);
const newest = Array.from({ length: 200 }, (_, i) =>
	revision("Restore " + i, "restore", new Date(when).toISOString()),
);
for (let i = 0; i < newest.length; i += 20) {
	await push(long, newest.slice(i, i + 20));
}
// The oldest restore arrives last, after 200 rows sharing a timestamp.
await push(long, [
	revision("Restore 200", "restore", new Date(when - 1).toISOString()),
]);
const cli = (...args) =>
	execFileSync(
		process.execPath,
		[`--env-file=${config}`, "node_modules/convex/bin/main.js", "run", ...args],
		{ cwd: new URL("../", import.meta.url), encoding: "utf8" },
	);
const inspect = () =>
	JSON.parse(
		cli(
			"--inline-query",
			`
	const ids = ${JSON.stringify([long.id, short.id])};
	return await Promise.all(ids.map(async id => {
		const note = await ctx.db.query("notes").withIndex("by_note_id", q => q.eq("id", id)).unique();
		const rows = await ctx.db.query("noteRevisions").withIndex("by_note", q => q.eq("noteId", note._id)).collect();
		return rows.map(row => row.title);
	}));
`,
		),
	);
const before = inspect();
assert.equal(before[0].length, 203);
assert.deepEqual(before[1], ["Aged edit", "Aged restore"]);
cli("revisionRetention:prune", "{}");
for (let attempt = 0; attempt < 30; attempt++) {
	const [longHistory, shortHistory] = inspect();
	if (longHistory.length === 201 && shortHistory.length === 1) {
		assert.ok(longHistory.includes("Recoverable conflict"));
		assert.ok(longHistory.includes("Restore 0"));
		assert.ok(!longHistory.includes("Restore 200"));
		assert.deepEqual(shortHistory, ["Aged restore"]);
		break;
	}
	if (attempt === 29) assert.fail("Revision retention did not converge");
	await setTimeout(300);
}
const restored = await request(
	notePath + "/revisions/" + conflict.id + "/restore",
	"POST",
	200,
	token,
);
assert.equal(restored.content, "Preserved draft");
console.log(
	JSON.stringify({
		agedEditsPruned: true,
		chronologicalCap: true,
		recentConflictRestored: true,
	}),
);
