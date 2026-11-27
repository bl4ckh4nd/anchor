import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";

const [origin, adminEnv] = process.argv.slice(2);
assert.equal(origin, "http://127.0.0.1:3735");
assert.ok(adminEnv);
const deployment = "http://127.0.0.1:3734";
const password = "SyntheticDeletion123!";
const headers = (token) => ({
	"Content-Type": "application/json",
	...(token ? { Authorization: `Bearer ${token}` } : {}),
});
const request = (path, body, token) =>
	fetch(origin + path, {
		method: body === undefined ? "GET" : "POST",
		headers: headers(token),
		body: body === undefined ? undefined : JSON.stringify(body),
	});
const inspect = (query) =>
	JSON.parse(
		execFileSync(
			process.execPath,
			[
				`--env-file=${adminEnv}`,
				"node_modules/convex/bin/main.js",
				"run",
				"--inline-query",
				query,
			],
			{
				cwd: new URL("../", import.meta.url),
				encoding: "utf8",
				timeout: 10000,
			},
		),
	);
async function register(name) {
	const email = `deletion-${randomUUID()}@example.test`;
	const result = await request("/api/auth/register", { name, email, password });
	assert.equal(result.status, 201);
	const session = await result.json();
	assert.ok(
		!session.user.isAdmin && session.access_token && session.refresh_token,
	);
	return session;
}
async function convex(kind, path, args, session) {
	const result = await fetch(`${deployment}/api/${kind}`, {
		method: "POST",
		headers: headers(session.access_token),
		body: JSON.stringify({ path, args }),
	});
	const payload = await result.json();
	assert.equal(payload.status, "success");
	return payload.value;
}

const [owner, peer] = await Promise.all([
	register("Delete fixture"),
	register("Keep fixture"),
]);
const remove = (body, session) =>
	request("/api/auth/delete-account", body, session?.access_token);
assert.equal((await remove({ password })).status, 401);
assert.equal((await remove({ password: "wrong" }, owner)).status, 403);
assert.equal((await remove({}, owner)).status, 403);
const targetId = owner.user.id;
const keptId = peer.user.id;
const adminPath = origin + "/api/admin/users/" + targetId;
assert.equal((await fetch(adminPath, { method: "DELETE" })).status, 401);
assert.equal(
	(
		await fetch(adminPath, {
			method: "DELETE",
			headers: headers(peer.access_token),
		})
	).status,
	403,
);
const [gone, kept] = [randomUUID(), randomUUID()];
for (const [id, session, recipient] of [
	[gone, owner, peer],
	[kept, peer, owner],
]) {
	await convex("mutation", "notes:create", { id, title: id }, session);
	await convex(
		"mutation",
		"notes:setShare",
		{ id, subject: recipient.user.id, permission: "editor" },
		session,
	);
}
const goneAttachments = Array.from({ length: 5 }, () => randomUUID());
const keptAttachment = randomUUID();
async function upload(noteId, attachmentId) {
	const response = await fetch(
		origin +
			"/api/compose/attachments?" +
			new URLSearchParams({ noteId, attachmentId }),
		{
			method: "POST",
			headers: {
				...headers(owner.access_token),
				"Content-Type": "audio/wav",
				"x-anchor-filename-encoded": "fixture.wav",
			},
			body: Buffer.from("synthetic audio fixture"),
		},
	);
	assert.equal(response.status, 201);
}
for (const id of goneAttachments) await upload(gone, id);
await upload(kept, keptAttachment);

const sessionId = JSON.parse(
	Buffer.from(owner.access_token.split(".")[1], "base64url"),
).anchorSession;
const read = `const q = (name, id) => ctx.db.query(name).filter(q => q.eq(q.field("id"), id)).first();
	const account = await q("accounts", ${JSON.stringify(targetId)});
	const gone = await q("notes", ${JSON.stringify(gone)});
	const kept = await q("notes", ${JSON.stringify(kept)});
	const rows = await Promise.all(${JSON.stringify(goneAttachments)}.map(id => q("noteAttachments", id)));
	const keptAttachment = await q("noteAttachments", ${JSON.stringify(keptAttachment)});
	const share = await ctx.db.query("noteShares").withIndex("by_note_subject", q => q.eq("noteId", kept._id).eq("subject", ${JSON.stringify(targetId)})).first();
	const session = await ctx.db.get("sessions", ${JSON.stringify(sessionId)});
	const refresh = await ctx.db.query("refreshTokens").withIndex("by_session", q => q.eq("sessionId", ${JSON.stringify(sessionId)})).first();
	const feed = await ctx.db.query("noteFeedHeads").withIndex("by_recipient", q => q.eq("issuer", kept.issuer).eq("subject", ${JSON.stringify(targetId)})).first();
	return {account: !!account, gone: !!gone, ownedAttachments: rows.filter(Boolean).length, keptUploader: keptAttachment?.uploadedByUserId, share: !!share, session: !!session, refresh: !!refresh, feed: !!feed};`;
const get = (id, session) => convex("query", "notes:get", { id }, session);
assert.ok(await get(gone, peer));
const before = await convex("query", "notes:changes", { limit: 100 }, peer);
assert.deepEqual(inspect(read), {
	account: true,
	gone: true,
	ownedAttachments: goneAttachments.length,
	keptUploader: targetId,
	share: true,
	session: true,
	refresh: true,
	feed: true,
});
const goneBlobs = inspect(
	`return await Promise.all(${JSON.stringify(goneAttachments)}.map(async id => (await ctx.db.query("noteAttachments").filter(q => q.eq(q.field("id"), id)).first()).storageId));`,
);

const deleted = await remove({ password }, owner);
assert.equal(deleted.status, 200);
assert.deepEqual(await deleted.json(), { message: "Account deleted" });
assert.equal(
	(await request("/api/auth/me", undefined, owner.access_token)).status,
	401,
);
assert.equal(
	(await request("/api/auth/refresh", { refresh_token: owner.refresh_token }))
		.status,
	401,
);
assert.equal(
	(await request("/api/auth/login", { email: owner.user.email, password }))
		.status,
	401,
);
assert.equal(await get(gone, peer), null);
assert.ok(await get(kept, peer));
const expected = {
	account: false,
	gone: false,
	ownedAttachments: 0,
	keptUploader: keptId,
	share: false,
	session: false,
	refresh: false,
	feed: false,
};
for (let attempt = 0; attempt < 20; attempt++) {
	if (JSON.stringify(inspect(read)) === JSON.stringify(expected)) break;
	await setTimeout(250);
}
assert.deepEqual(inspect(read), expected);
assert.equal(
	inspect(
		`return (await Promise.all(${JSON.stringify(goneBlobs)}.map(id => ctx.db.system.get("_storage", id)))).some(Boolean);`,
	),
	false,
);
assert.equal(
	(
		await fetch(
			origin +
				"/api/compose/attachments?" +
				new URLSearchParams({ noteId: kept, attachmentId: keptAttachment }),
			{ headers: headers(peer.access_token) },
		)
	).status,
	200,
);
const after = await convex(
	"query",
	"notes:changes",
	{ limit: 100, after: before.nextCursor },
	peer,
);
assert.ok(
	after.entries.some(
		(entry) => entry.entityId === gone && entry.op === "remove",
	),
);
assert.ok(
	after.entries.some(
		(entry) => entry.entityId === kept && entry.op === "upsert",
	),
);
console.log(
	JSON.stringify({
		deleted: targetId,
		ownedBlobDeleted: true,
		foreignAttachmentReassigned: true,
		sharedNoteFeedUpdated: true,
	}),
);
