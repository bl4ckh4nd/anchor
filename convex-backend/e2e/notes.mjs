import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

const [mode, keyFile, url] = process.argv.slice(2);
const issuer = process.env.ANCHOR_TEST_ISSUER ?? "https://anchor-fixture.invalid";
const kid = process.env.ANCHOR_TEST_KEY_ID ?? "anchor-fixture";

if (mode === "keys") {
	const { privateKey, publicKey } = generateKeyPairSync("rsa", {
		modulusLength: 2048,
	});
	writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }), {
		mode: 0o600,
		flag: "wx",
	});
	const jwks = {
		keys: [
			{
				...publicKey.export({ format: "jwk" }),
				kid,
				alg: "RS256",
			},
		],
	};
	process.stdout.write(
		`data:application/json;base64,${Buffer.from(JSON.stringify(jwks)).toString("base64")}`,
	);
	process.exit(0);
}

assert.equal(mode, "check");
assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
const privateKey = readFileSync(keyFile);
const noteId = randomUUID();
const subject = (role) => `${role}-${noteId}`;

function client(role, audience = "anchor") {
	const client = new ConvexHttpClient(url, { logger: false });
	if (!role) return client;
	const encode = (value) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	const now = Math.floor(Date.now() / 1000);
	const payload = [
		encode({ kid, typ: "JWT", alg: "RS256" }),
		encode({
			iss: issuer,
			aud: audience,
			sub: subject(role),
			iat: now,
			exp: now + 120,
		}),
	].join(".");
	client.setAuth(
		`${payload}.${sign("RSA-SHA256", Buffer.from(payload), privateKey).toString("base64url")}`,
	);
	return client;
}

const owner = client("owner");
const reader = client("reader");
const editor = client("editor");
const outsider = client("outsider");
const create = makeFunctionReference("notes:create");
const get = makeFunctionReference("notes:get");
const setShare = makeFunctionReference("notes:setShare");
const update = makeFunctionReference("notes:update");
const args = { id: noteId };

await assert.rejects(
	client().mutation(create, { ...args, title: "Anonymous" }),
);
await assert.rejects(
	client("owner", "wrong-audience").mutation(create, {
		...args,
		title: "Invalid token",
	}),
);

const created = await owner.mutation(create, { ...args, title: "Shared note" });
assert.equal(created.version, 1);
assert.deepEqual(
	await owner.mutation(create, { ...args, title: "Retried create" }),
	created,
);
assert.equal(await outsider.query(get, args), null);
await assert.rejects(
	outsider.mutation(create, { ...args, title: "Collision" }),
);
await assert.rejects(
	outsider.mutation(setShare, {
		...args,
		subject: subject("outsider"),
		permission: "editor",
	}),
);

await owner.mutation(setShare, {
	...args,
	subject: subject("reader"),
	permission: "viewer",
});
await owner.mutation(setShare, {
	...args,
	subject: subject("editor"),
	permission: "editor",
});
assert.equal((await reader.query(get, args)).permission, "viewer");
await assert.rejects(
	reader.mutation(update, {
		...args,
		baseVersion: 1,
		title: "Unauthorized edit",
	}),
);
await assert.rejects(
	editor.mutation(setShare, {
		...args,
		subject: subject("outsider"),
		permission: "editor",
	}),
);

const offline = await editor.query(get, args);
const results = await Promise.all([
	owner.mutation(update, {
		...args,
		baseVersion: offline.version,
		title: "Owner's edit",
	}),
	editor.mutation(update, {
		...args,
		baseVersion: offline.version,
		title: "Editor's edit",
	}),
]);
const [saved] = results.filter((result) => result.ok);
const [conflict] = results.filter((result) => !result.ok);
assert.equal(results.filter((result) => result.ok).length, 1);
assert.equal(saved.note.version, 2);
assert.equal(conflict.serverNote.title, saved.note.title);
assert.equal(conflict.serverNote.version, 2);
assert.equal((await reader.query(get, args)).title, saved.note.title);
const unchanged = await editor.mutation(update, {
	...args,
	baseVersion: 2,
	title: saved.note.title,
});
assert.equal(unchanged.note.version, 2);

await owner.mutation(setShare, {
	...args,
	subject: subject("editor"),
	permission: null,
});
assert.equal(await editor.query(get, args), null);
await assert.rejects(
	editor.mutation(update, { ...args, baseVersion: 2, title: "Revoked edit" }),
);
console.log(
	"Passed: JWT audience, ownership, retry, viewer/editor access, concurrent stale edit and revocation.",
);

const feed = makeFunctionReference("notes:changes");
await assert.rejects(client().query(feed, {}));
assert.deepEqual(await outsider.query(feed, {}), {
	entries: [],
	nextCursor: "0",
	hasMore: false,
});

const first = await owner.query(feed, { limit: 1 });
assert.equal(first.hasMore, true);
assert.equal(first.nextCursor, "1");
assert.equal(first.entries.length, 1);
assert.deepEqual(first.entries[0], {
	seq: "1",
	entityId: noteId,
	entityType: "note",
	op: "upsert",
	note: { ...saved.note, permission: "owner" },
});
const next = await owner.query(feed, { after: first.nextCursor, limit: 1 });
assert.equal(next.nextCursor, "2");
assert.equal(next.hasMore, false);
assert.equal(next.entries[0].seq, "2");
assert.deepEqual(
	(await owner.query(feed, { after: next.nextCursor })).entries,
	[],
);

const readerFeed = await reader.query(feed, {});
assert.deepEqual(
	readerFeed.entries.map((entry) => [entry.seq, entry.note.permission]),
	[
		["1", "viewer"],
		["2", "viewer"],
	],
);
const revoked = await editor.query(feed, {});
assert.equal(revoked.nextCursor, "3");
assert.equal(revoked.entries.length, 3);
for (const entry of revoked.entries) {
	assert.deepEqual(entry, {
		seq: entry.seq,
		entityId: noteId,
		entityType: "note",
		op: "remove",
	});
}
assert.equal((await owner.query(feed, { after: "100" })).resetRequired, true);
await assert.rejects(owner.query(feed, { after: "-1" }));
await assert.rejects(owner.query(feed, { limit: 0 }));
console.log(
	"Passed: ordered viewer-specific feed, pagination, conflict deduplication and revocation.",
);

const concurrentIds = [randomUUID(), randomUUID()];
await Promise.all(
	concurrentIds.map((id) =>
		owner.mutation(create, { id, title: "Concurrent note" }),
	),
);
const concurrent = await owner.query(feed, { after: next.nextCursor });
assert.deepEqual(
	concurrent.entries.map((entry) => entry.seq),
	["3", "4"],
);
assert.deepEqual(
	concurrent.entries.map((entry) => entry.entityId).sort(),
	concurrentIds.sort(),
);
assert.deepEqual(
	(await reader.query(feed, { after: readerFeed.nextCursor })).entries,
	[],
);
console.log(
	"Passed: concurrent writes use distinct contiguous recipient sequences.",
);

const sync = makeFunctionReference("notes:syncPage");
const snapshotStart = await owner.query(sync, { limit: 1 });
assert.equal(snapshotStart.hasMore, true);
assert.equal(snapshotStart.entries.length, 1);
assert.equal(snapshotStart.entries[0].seq, "0");
assert.equal(
	(await reader.query(sync, { limit: 1 })).entries[0].note.permission,
	"viewer",
);

const snapshotNote = snapshotStart.entries[0].note;
await owner.mutation(update, {
	id: snapshotNote.id,
	baseVersion: snapshotNote.version,
	title: "Changed during snapshot",
});
const duringSnapshot = randomUUID();
await owner.mutation(create, {
	id: duringSnapshot,
	title: "Created during snapshot",
});

async function drain(client, initialPage, limit) {
	const entries = [...initialPage.entries];
	let page = initialPage;
	for (let i = 0; page.hasMore && i < 12; i++) {
		assert.equal(typeof page.nextCursor, "string");
		page = await client.query(sync, { cursor: page.nextCursor, limit });
		entries.push(...page.entries);
	}
	assert.equal(page.hasMore, false);
	return { entries, nextCursor: page.nextCursor };
}

const synced = await drain(owner, snapshotStart, 1);
const baseline = synced.entries.filter((entry) => entry.seq === "0");
assert.equal(
	new Set(baseline.map((entry) => entry.entityId)).size,
	baseline.length,
);
for (const id of [noteId, ...concurrentIds])
	assert.ok(baseline.some((entry) => entry.entityId === id));
const deltas = synced.entries.filter((entry) => entry.seq !== "0");
assert.deepEqual(
	deltas.map((entry) => [entry.seq, entry.entityId, entry.note.title]),
	[
		["5", snapshotNote.id, "Changed during snapshot"],
		["6", duringSnapshot, "Created during snapshot"],
	],
);
assert.deepEqual(
	(await owner.query(sync, { cursor: synced.nextCursor })).entries,
	[],
);
assert.deepEqual((await editor.query(sync, {})).entries, []);
assert.deepEqual((await outsider.query(sync, {})).entries, []);
await assert.rejects(owner.query(sync, { cursor: "0" }));
await assert.rejects(owner.query(sync, { cursor: "not-a-cursor" }));
console.log(
	"Passed: authorized snapshot, versioned cursor and no lost writes across the snapshot boundary.",
);

await owner.mutation(setShare, {
	id: duringSnapshot,
	subject: subject("reader"),
	permission: "viewer",
});
const sharedStart = await reader.query(sync, { limit: 1 });
assert.equal(sharedStart.entries.length, 1);
const revokedId = sharedStart.entries[0].entityId;
await owner.mutation(setShare, {
	id: revokedId,
	subject: subject("reader"),
	permission: null,
});
const sharedSync = await drain(reader, sharedStart, 1);
assert.deepEqual(
	sharedSync.entries
		.filter((entry) => entry.seq === "0")
		.map((entry) => entry.entityId)
		.sort(),
	[noteId, duringSnapshot].sort(),
);
assert.deepEqual(sharedSync.entries.at(-1), {
	seq: sharedSync.entries.at(-1).seq,
	entityType: "note",
	entityId: revokedId,
	op: "remove",
});
console.log(
	"Passed: shared snapshot pagination converges after an in-flight access revocation.",
);

const push = makeFunctionReference("notes:push");
const pushedId = randomUUID();
const missingId = randomUUID();
const changes = [
	{ type: "note", id: pushedId, title: "Old local title" },
	{ type: "note", id: missingId, title: "Purged", baseVersion: 1 },
	{ type: "note", id: pushedId, title: "Final local title" },
];
await assert.rejects(client().action(push, { changes }));
assert.deepEqual(await owner.action(push, { changes }), [
	{ type: "note", id: pushedId, status: "applied", version: 1 },
	{ type: "note", id: missingId, status: "denied" },
]);
const pushed = await owner.query(get, { id: pushedId });
assert.equal(pushed.title, "Final local title");
assert.equal(await owner.query(get, { id: missingId }), null);
const pushedChange = {
	type: "note",
	id: pushedId,
	title: "Next version",
	baseVersion: 1,
};
assert.deepEqual(await outsider.action(push, { changes: [pushedChange] }), [
	{ type: "note", id: pushedId, status: "denied" },
]);
await owner.mutation(setShare, {
	id: pushedId,
	subject: subject("reader"),
	permission: "viewer",
});
assert.deepEqual(await reader.action(push, { changes: [pushedChange] }), [
	{
		type: "note",
		id: pushedId,
		status: "conflict",
		serverCopy: { ...pushed, permission: "viewer" },
	},
]);
assert.deepEqual(
	await reader.action(push, {
		changes: [{
			...pushedChange,
			revisionsOnly: true,
			requireRevisionWrite: true,
			revisions: [{
				id: randomUUID(),
				title: "Viewer's local revision",
				cause: "edit",
				createdAt: new Date().toISOString(),
			}],
		}],
	}),
	[{ type: "note", id: pushedId, status: "denied" }],
);
assert.deepEqual(await owner.action(push, { changes: [pushedChange] }), [
	{ type: "note", id: pushedId, status: "applied", version: 2 },
]);
const savedPush = await owner.query(get, { id: pushedId });
assert.deepEqual(await owner.action(push, { changes: [pushedChange] }), [
	{ type: "note", id: pushedId, status: "applied", version: 2 },
]);
assert.equal(savedPush.title, "Next version");
const pushedFeed = await owner.query(sync, { cursor: synced.nextCursor });
assert.deepEqual(
	pushedFeed.entries.map((entry) => [entry.entityId, entry.note.version]),
	[
		[pushedId, 2],
		[pushedId, 2],
	],
);
console.log(
	"Passed: note push coalescing, stale conflicts, viewer and outsider access, and feed writes.",
);

const oversizedId = randomUUID();
const validId = randomUUID();
assert.deepEqual(
	await owner.action(push, {
		changes: [
			{
				type: "note",
				id: oversizedId,
				title: "Oversized",
				content: "x".repeat(1024 * 1024),
			},
			{ type: "note", id: validId, title: "Independent write" },
		],
	}),
	[
		{ type: "note", id: oversizedId, status: "failed" },
		{ type: "note", id: validId, status: "applied", version: 1 },
	],
);
assert.equal(await owner.query(get, { id: oversizedId }), null);
assert.equal(
	(await owner.query(get, { id: validId })).title,
	"Independent write",
);
console.log(
	"Passed: a rejected document rolls back independently and the following write commits.",
);

const history = makeFunctionReference("notes:history");
const restore = makeFunctionReference("notes:restore");
const revision = makeFunctionReference("notes:revision");
const historyArgs = { id: pushedId };
const originalHistory = await owner.query(history, historyArgs);
assert.equal(originalHistory.revisions.length, 1);
const originalRevision = originalHistory.revisions[0];
assert.equal(originalRevision.title, "Final local title");
assert.equal(originalRevision.version, 1);
assert.equal(originalRevision.authorSubject, subject("owner"));
assert.equal(originalRevision.cause, "edit");
await assert.rejects(reader.query(history, historyArgs));
await assert.rejects(outsider.query(history, historyArgs));
await assert.rejects(
	reader.mutation(restore, { id: pushedId, revisionId: originalRevision.id }),
);

await owner.mutation(update, {
	id: pushedId,
	title: "Collapsed",
	baseVersion: 2,
});
const conflictAgain = await owner.mutation(update, {
	id: pushedId,
	title: "Stale",
	baseVersion: 2,
});
assert.equal(conflictAgain.ok, false);
assert.deepEqual(await owner.query(history, historyArgs), originalHistory);

await owner.mutation(setShare, {
	id: pushedId,
	subject: subject("editor"),
	permission: "editor",
});
assert.deepEqual(await editor.query(history, historyArgs), originalHistory);
await assert.rejects(
	editor.mutation(restore, {
		id: pushedId,
		revisionId: (await owner.query(history, { id: noteId })).revisions[0].id,
	}),
);
assert.deepEqual(
	await editor.query(revision, {
		...historyArgs,
		revisionId: originalRevision.id,
	}),
	originalRevision,
);
await assert.rejects(
	reader.query(revision, { ...historyArgs, revisionId: originalRevision.id }),
);
const beforeRestore = await owner.query(feed, {});
const restored = await editor.mutation(restore, {
	id: pushedId,
	revisionId: originalRevision.id,
});
assert.equal(restored.title, "Final local title");
assert.equal(restored.version, 4);
assert.deepEqual(
	await editor.mutation(restore, {
		id: pushedId,
		revisionId: originalRevision.id,
	}),
	restored,
);
const restoreEvents = await owner.query(feed, {
	after: beforeRestore.nextCursor,
});
assert.equal(restoreEvents.entries.length, 1);
assert.deepEqual(restoreEvents.entries[0].note, {
	...restored,
	permission: "owner",
});
const latestHistory = await owner.query(history, { id: pushedId, limit: 1 });
assert.equal(latestHistory.revisions[0].title, "Collapsed");
assert.equal(latestHistory.revisions[0].cause, "restore");
assert.equal(latestHistory.revisions[0].authorSubject, subject("editor"));
assert.deepEqual(
	(
		await owner.query(history, {
			id: pushedId,
			limit: 1,
			cursor: latestHistory.nextCursor,
		})
	).revisions,
	[originalRevision],
);
await owner.mutation(setShare, {
	id: pushedId,
	subject: subject("editor"),
	permission: null,
});
await assert.rejects(editor.query(history, historyArgs));
console.log(
	"Passed: atomic history, edit collapse, access checks, paginated history and restore.",
);

const checkedHistory = await owner.query(history, historyArgs);
await assert.rejects(
	owner.mutation(update, {
		id: pushedId,
		baseVersion: restored.version,
		content: "x".repeat(1024 * 1024),
	}),
);
assert.deepEqual(await owner.query(history, historyArgs), checkedHistory);
assert.deepEqual(
	(await owner.query(feed, { after: restoreEvents.nextCursor })).entries,
	[],
);
assert.deepEqual(await owner.query(get, historyArgs), {
	...restored,
	permission: "owner",
});
console.log(
	"Passed: a failed content write leaves the note, revision list and journal unchanged.",
);

const rejected = {
	...pushedChange,
	title: "Offline draft",
	content: '{"ops":[{"insert":"Recovery text"}]}',
};
for (let retry = 0; retry < 2; retry++) {
	assert.deepEqual(await owner.action(push, { changes: [rejected] }), [
		{
			type: "note",
			id: pushedId,
			status: "conflict",
			serverCopy: { ...restored, permission: "owner" },
		},
	]);
}
const recovery = await owner.query(history, historyArgs);
assert.equal(recovery.revisions.length, checkedHistory.revisions.length + 1);
const rejectedRevision = recovery.revisions[0];
assert.equal(rejectedRevision.cause, "conflict");
assert.equal(rejectedRevision.title, rejected.title);
assert.equal(rejectedRevision.content, rejected.content);
assert.equal(rejectedRevision.version, rejected.baseVersion);
assert.equal(rejectedRevision.authorSubject, subject("owner"));
assert.equal(
	(
		await reader.action(push, {
			changes: [{ ...rejected, title: "Viewer injection" }],
		})
	)[0].status,
	"conflict",
);
assert.deepEqual(await owner.query(history, historyArgs), recovery);
assert.deepEqual(
	(await owner.query(feed, { after: restoreEvents.nextCursor })).entries,
	[],
);
const recovered = await owner.mutation(restore, {
	...historyArgs,
	revisionId: rejectedRevision.id,
});
assert.equal(recovered.title, rejected.title);
assert.equal(recovered.content, rejected.content);
assert.equal(recovered.version, 5);
console.log(
	"Passed: identical replay acknowledged and rejected writer draft preserved once for restore.",
);

const titleOnly = { ...pushedChange, title: "Only the title changed" };
assert.equal(
	(await owner.action(push, { changes: [titleOnly] }))[0].status,
	"conflict",
);
const titleOnlyRevision = (await owner.query(history, historyArgs))
	.revisions[0];
assert.equal(titleOnlyRevision.title, titleOnly.title);
assert.equal(titleOnlyRevision.content, recovered.content);
console.log("Passed: a title-only conflict preserves the existing Quill body.");

const deviceId = randomUUID();
const clientRevision = {
	id: randomUUID(),
	version: 1,
	title: "Device snapshot",
	content: '{"ops":[{"insert":"Device text"}]}',
	cause: "edit",
	createdAt: "2099-01-01T00:00:00.000Z",
};
const deviceChange = {
	type: "note",
	id: deviceId,
	title: "Current device note",
	revisions: [clientRevision],
};
const firstDevicePush = await owner.action(push, { changes: [deviceChange] });
assert.deepEqual(firstDevicePush, [
	{ type: "note", id: deviceId, status: "applied", version: 1 },
]);
const deviceHistoryArgs = { id: deviceId };
const deviceHistory = await owner.query(history, deviceHistoryArgs);
assert.equal(deviceHistory.revisions.length, 1);
assert.equal(deviceHistory.revisions[0].clientId, clientRevision.id);
assert.equal(deviceHistory.revisions[0].authorSubject, subject("owner"));
assert.equal(deviceHistory.revisions[0].content, clientRevision.content);
assert.ok(deviceHistory.revisions[0].createdAt <= Date.now());
const beforeHistoryOnly = await owner.query(feed, {});
assert.deepEqual(
	await owner.action(push, { changes: [deviceChange] }),
	firstDevicePush,
);
assert.deepEqual(
	(await owner.query(feed, { after: beforeHistoryOnly.nextCursor })).entries,
	[],
);
const recordedOffline = {
	...clientRevision,
	id: randomUUID(),
	title: "History only",
	createdAt: "2026-10-15T10:00:00.000Z",
};
const historyOnly = {
	...deviceChange,
	title: "Do not overwrite",
	revisionsOnly: true,
	revisions: [recordedOffline],
};
await owner.mutation(setShare, {
	id: deviceId,
	subject: subject("reader"),
	permission: "viewer",
});
assert.deepEqual(
	await reader.action(push, { changes: [historyOnly] }),
	firstDevicePush,
);
assert.deepEqual(await owner.query(history, deviceHistoryArgs), deviceHistory);
assert.deepEqual(
	await owner.action(push, { changes: [historyOnly] }),
	firstDevicePush,
);
const currentDeviceNote = await owner.query(get, deviceHistoryArgs);
assert.equal(currentDeviceNote.title, deviceChange.title);
assert.equal(currentDeviceNote.version, 1);
const uploaded = await owner.query(history, deviceHistoryArgs);
assert.equal(uploaded.revisions.length, 2);
assert.equal(
	uploaded.revisions.find((item) => item.clientId === recordedOffline.id)
		.createdAt,
	Date.parse(recordedOffline.createdAt),
);
const historyEvent = await owner.query(feed, {
	after: beforeHistoryOnly.nextCursor,
});
assert.equal(historyEvent.entries.length, 1);
assert.equal(historyEvent.entries[0].note.version, 1);
assert.deepEqual(
	await owner.action(push, { changes: [historyOnly] }),
	firstDevicePush,
);
assert.deepEqual(
	(await owner.query(feed, { after: historyEvent.nextCursor })).entries,
	[],
);
const missingHistoryId = randomUUID();
assert.deepEqual(
	await owner.action(push, {
		changes: [{ ...historyOnly, id: missingHistoryId }],
	}),
	[{ type: "note", id: missingHistoryId, status: "denied" }],
);
console.log(
	"Passed: client history upload, deduplication, time clamp, viewer acknowledgement and no content overwrite.",
);

const coveredId = randomUUID();
await owner.mutation(create, {
	id: coveredId,
	title: "Already captured",
	content: clientRevision.content,
});
const captured = {
	...clientRevision,
	id: randomUUID(),
	title: "Already captured",
};
assert.deepEqual(
	await owner.action(push, {
		changes: [
			{
				type: "note",
				id: coveredId,
				title: "After capture",
				baseVersion: 1,
				revisions: [captured],
			},
		],
	}),
	[{ type: "note", id: coveredId, status: "applied", version: 2 }],
);
const coveredHistory = await owner.query(history, { id: coveredId });
assert.equal(coveredHistory.revisions.length, 1);
assert.equal(coveredHistory.revisions[0].clientId, captured.id);
console.log(
	"Passed: a client revision covering the prior text replaces the redundant server revision.",
);

const lifecycleId = randomUUID();
const lifecycleArgs = { id: lifecycleId };
await owner.mutation(create, { ...lifecycleArgs, title: "Lifecycle note" });
await owner.mutation(setShare, {
	...lifecycleArgs,
	subject: subject("reader"),
	permission: "viewer",
});
await owner.mutation(setShare, {
	...lifecycleArgs,
	subject: subject("editor"),
	permission: "editor",
});

const trash = {
	type: "note",
	...lifecycleArgs,
	title: "Lifecycle note",
	baseVersion: 1,
	state: "trashed",
	background: "#f4e9d7",
};
assert.deepEqual(await owner.action(push, { changes: [trash] }), [
	{ type: "note", ...lifecycleArgs, status: "applied", version: 2 },
]);
const trashed = await reader.query(get, lifecycleArgs);
assert.equal(trashed.state, "trashed");
assert.equal(trashed.background, trash.background);
assert.deepEqual((await owner.query(history, lifecycleArgs)).revisions, []);
const stillTrashed = {
	...trash,
	state: "active",
	background: null,
	baseVersion: 2,
};
assert.deepEqual(await editor.action(push, { changes: [stillTrashed] }), [
	{ type: "note", ...lifecycleArgs, status: "applied", version: 3 },
]);
assert.equal((await owner.query(get, lifecycleArgs)).state, "trashed");
assert.equal((await reader.query(get, lifecycleArgs)).background, null);
assert.deepEqual((await owner.query(history, lifecycleArgs)).revisions, []);

const readerBeforeDelete = await reader.query(feed, {});
const ownerBeforeDelete = await owner.query(feed, {});
const deleted = {
	...trash,
	baseVersion: 3,
	state: "deleted",
	background: null,
};
assert.deepEqual(await owner.action(push, { changes: [deleted] }), [
	{ type: "note", ...lifecycleArgs, status: "applied", version: 4 },
]);
assert.equal(await reader.query(get, lifecycleArgs), null);
assert.equal(await owner.query(get, lifecycleArgs), null);
await assert.rejects(owner.query(history, lifecycleArgs));
await assert.rejects(
	owner.mutation(create, { ...lifecycleArgs, title: "Replayed create" }),
);
assert.deepEqual(await owner.action(push, { changes: [deleted] }), [
	{ type: "note", ...lifecycleArgs, status: "applied", version: 4 },
]);
assert.deepEqual(
	await owner.action(push, {
		changes: [{ ...deleted, state: "active", baseVersion: 4 }],
	}),
	[{ type: "note", ...lifecycleArgs, status: "denied" }],
);
for (const [actor, cursorBeforeDelete] of [
	[owner, ownerBeforeDelete],
	[reader, readerBeforeDelete],
]) {
	const page = await actor.query(feed, {
		after: cursorBeforeDelete.nextCursor,
	});
	assert.equal(page.entries.length, 1);
	assert.equal(page.entries[0].op, "remove");
	assert.equal(page.entries[0].entityId, lifecycleId);
	assert.equal(page.entries[0].note, undefined);
	const snapshot = await drain(actor, await actor.query(sync, {}), 20);
	assert.ok(snapshot.entries.every((entry) => entry.entityId !== lifecycleId));
}
console.log(
	"Passed: trash, background, ownership, tombstone replay and recipient removals.",
);

const leaveId = randomUUID();
await owner.mutation(create, { id: leaveId, title: "Shared lifecycle" });
await owner.mutation(setShare, {
	id: leaveId,
	subject: subject("reader"),
	permission: "viewer",
});
const leaveCursor = (await reader.query(feed, {})).nextCursor;
assert.deepEqual(
	await reader.action(push, {
		changes: [
			{
				type: "note",
				id: leaveId,
				title: "Shared lifecycle",
				baseVersion: 1,
				state: "trashed",
			},
		],
	}),
	[{ type: "note", id: leaveId, status: "denied" }],
);
assert.equal(await reader.query(get, { id: leaveId }), null);
assert.equal((await owner.query(get, { id: leaveId })).state, "active");
assert.deepEqual(
	(await reader.query(feed, { after: leaveCursor })).entries.map((entry) => [
		entry.entityId,
		entry.op,
	]),
	[[leaveId, "remove"]],
);
console.log(
	"Passed: trashing an active shared note leaves that share without changing the owner's note.",
);

const archiveId = randomUUID();
const archiveArgs = { id: archiveId };
await owner.mutation(create, { ...archiveArgs, title: "Archive locally" });
for (const role of ["reader", "editor"]) {
	await owner.mutation(setShare, {
		...archiveArgs,
		subject: subject(role),
		permission: role === "reader" ? "viewer" : "editor",
	});
}
const beforeArchive = await Promise.all(
	[owner, reader, editor].map((actor) => actor.query(feed, {})),
);
const archive = {
	type: "note",
	...archiveArgs,
	title: "Archive locally",
	isArchived: true,
};
assert.deepEqual(await reader.action(push, { changes: [archive] }), [
	{ type: "note", ...archiveArgs, status: "applied", version: 1 },
]);
for (const [actor, archived] of [
	[owner, false],
	[reader, true],
	[editor, false],
]) {
	const note = await actor.query(get, archiveArgs);
	assert.equal(note.isArchived, archived);
	assert.equal(note.version, 1);
}
const afterArchive = await Promise.all(
	[owner, reader, editor].map((actor, i) =>
		actor.query(feed, { after: beforeArchive[i].nextCursor }),
	),
);
assert.deepEqual(
	afterArchive.map((page) => page.entries.length),
	[0, 1, 0],
);
assert.equal(afterArchive[1].entries[0].note.isArchived, true);
const archiveSnapshot = await drain(reader, await reader.query(sync, {}), 20);
assert.equal(
	archiveSnapshot.entries.find((entry) => entry.entityId === archiveId).note
		.isArchived,
	true,
);
await reader.action(push, { changes: [archive] });
assert.deepEqual(
	(await reader.query(feed, { after: afterArchive[1].nextCursor })).entries,
	[],
);

await owner.mutation(update, {
	...archiveArgs,
	title: "Owner edit",
	baseVersion: 1,
});
const unarchive = {
	...archive,
	baseVersion: 1,
	title: "Viewer edit",
	isArchived: false,
};
const outcome = (await reader.action(push, { changes: [unarchive] }))[0];
assert.equal(outcome.status, "conflict");
assert.equal(outcome.serverCopy.isArchived, false);
assert.equal(outcome.serverCopy.title, "Owner edit");
assert.equal(outcome.serverCopy.version, 2);
assert.equal((await reader.query(get, archiveArgs)).isArchived, false);
console.log(
	"Passed: per-user archive, no version bump, targeted feed and independent stale-content conflict.",
);

await reader.action(push, { changes: [{ ...archive, title: "Owner edit" }] });
assert.equal((await reader.query(get, archiveArgs)).isArchived, true);
await owner.mutation(setShare, {
	...archiveArgs,
	subject: subject("reader"),
	permission: null,
});
await owner.mutation(setShare, {
	...archiveArgs,
	subject: subject("reader"),
	permission: "viewer",
});
assert.equal((await reader.query(get, archiveArgs)).isArchived, false);
console.log(
	"Passed: revoked shares do not retain a stale personal archive when granted again.",
);

const pin = { type: "pin", id: archiveId, isPinned: true };
const pinBefore = await Promise.all(
	[owner, reader, editor].map((actor) => actor.query(feed, {})),
);
assert.deepEqual(await outsider.action(push, { changes: [pin] }), [
	{ type: "pin", id: archiveId, status: "denied" },
]);
assert.deepEqual(await reader.action(push, { changes: [pin] }), [
	{ type: "pin", id: archiveId, status: "applied" },
]);
assert.deepEqual(await reader.action(push, { changes: [pin] }), [
	{ type: "pin", id: archiveId, status: "applied" },
]);
const pinAfter = await Promise.all(
	[owner, reader, editor].map((actor, i) =>
		actor.query(feed, { after: pinBefore[i].nextCursor }),
	),
);
assert.deepEqual(
	pinAfter.map((page) => page.entries.length),
	[0, 1, 0],
);
assert.equal(pinAfter[1].entries[0].entityType, "pin");
assert.equal(pinAfter[1].entries[0].op, "upsert");
assert.equal(pinAfter[1].entries[0].note, undefined);
for (const [actor, isPinned] of [
	[owner, false],
	[reader, true],
	[editor, false],
]) {
	const note = await actor.query(get, archiveArgs);
	assert.equal(note.isPinned, isPinned);
	assert.equal(note.version, 2);
}
const pinnedSnapshot = await drain(reader, await reader.query(sync, {}), 20);
assert.deepEqual(
	pinnedSnapshot.entries.filter((entry) => entry.entityType === "pin"),
	[{ seq: "0", entityType: "pin", entityId: archiveId, op: "upsert" }],
);
await reader.action(push, { changes: [{ ...pin, isPinned: false }] });
const unpinned = await reader.query(feed, { after: pinAfter[1].nextCursor });
assert.deepEqual(
	unpinned.entries.map((entry) => [entry.entityType, entry.entityId, entry.op]),
	[["pin", archiveId, "remove"]],
);
await reader.action(push, { changes: [pin] });
await owner.mutation(setShare, {
	...archiveArgs,
	subject: subject("reader"),
	permission: null,
});
await owner.mutation(setShare, {
	...archiveArgs,
	subject: subject("reader"),
	permission: "viewer",
});
assert.equal((await reader.query(get, archiveArgs)).isPinned, false);
console.log(
	"Passed: private pins, idempotency, independent feed, snapshot and share cleanup.",
);

const reminder = {
	type: "reminder",
	id: archiveId,
	remindAt: "2027-02-03T12:30",
	recurrence: "weekly",
};
const reminderBefore = await Promise.all(
	[owner, reader].map((actor) => actor.query(feed, {})),
);
assert.deepEqual(await outsider.action(push, { changes: [reminder] }), [
	{ type: "reminder", id: archiveId, status: "denied" },
]);
assert.deepEqual(await reader.action(push, { changes: [reminder] }), [
	{ type: "reminder", id: archiveId, status: "applied", version: 1 },
]);
assert.deepEqual(await reader.action(push, { changes: [reminder] }), [
	{ type: "reminder", id: archiveId, status: "applied", version: 1 },
]);
const reminderAfter = await Promise.all(
	[owner, reader].map((actor, i) =>
		actor.query(feed, { after: reminderBefore[i].nextCursor }),
	),
);
assert.deepEqual(
	reminderAfter.map((page) => page.entries.length),
	[0, 1],
);
const reminderV1 = {
	remindAt: reminder.remindAt,
	recurrence: "weekly",
	version: 1,
};
assert.deepEqual(reminderAfter[1].entries[0].reminder, reminderV1);
assert.equal(reminderAfter[1].entries[0].entityType, "reminder");
assert.equal((await owner.query(get, archiveArgs)).reminder, null);
assert.deepEqual((await reader.query(get, archiveArgs)).reminder, reminderV1);
assert.equal((await reader.query(get, archiveArgs)).version, 2);

const changedReminder = {
	...reminder,
	remindAt: "2027-02-03T14:15",
	baseVersion: 1,
};
assert.deepEqual(await reader.action(push, { changes: [changedReminder] }), [
	{ type: "reminder", id: archiveId, status: "applied", version: 2 },
]);
const reminderV2 = {
	...reminderV1,
	remindAt: changedReminder.remindAt,
	version: 2,
};
const clear = {
	type: "reminder",
	id: archiveId,
	remindAt: null,
	baseVersion: 1,
};
assert.deepEqual(await reader.action(push, { changes: [clear] }), [
	{
		type: "reminder",
		id: archiveId,
		status: "conflict",
		version: 2,
		serverCopy: reminderV2,
	},
]);
const reminderSnapshot = await drain(reader, await reader.query(sync, {}), 20);
assert.deepEqual(
	reminderSnapshot.entries.find(
		(entry) => entry.entityId === archiveId && entry.entityType === "note",
	).note.reminder,
	reminderV2,
);
const beforeClear = await reader.query(feed, {});
assert.deepEqual(
	await reader.action(push, { changes: [{ ...clear, baseVersion: 2 }] }),
	[{ type: "reminder", id: archiveId, status: "applied" }],
);
assert.deepEqual(
	(await reader.query(feed, { after: beforeClear.nextCursor })).entries.map(
		(entry) => [entry.entityId, entry.entityType, entry.op],
	),
	[[archiveId, "reminder", "remove"]],
);
assert.equal((await reader.query(get, archiveArgs)).reminder, null);
assert.deepEqual(await reader.action(push, { changes: [changedReminder] }), [
	{ type: "reminder", id: archiveId, status: "conflict", serverCopy: null },
]);
const recreated = { ...reminder, remindAt: "2027-02-04T16:30" };
assert.deepEqual(await reader.action(push, { changes: [recreated] }), [
	{ type: "reminder", id: archiveId, status: "applied", version: 4 },
]);
const reminderV4 = { ...reminderV1, remindAt: recreated.remindAt, version: 4 };
assert.deepEqual(await reader.action(push, { changes: [{ ...clear, baseVersion: 2 }] }), [
	{ type: "reminder", id: archiveId, status: "conflict", version: 4, serverCopy: reminderV4 },
]);
assert.deepEqual((await reader.query(get, archiveArgs)).reminder, reminderV4);
await owner.mutation(setShare, {
	...archiveArgs,
	subject: subject("reader"),
	permission: null,
});
await owner.mutation(setShare, {
	...archiveArgs,
	subject: subject("reader"),
	permission: "viewer",
});
assert.equal((await reader.query(get, archiveArgs)).reminder, null);
assert.deepEqual(await reader.action(push, { changes: [recreated] }), [
	{ type: "reminder", id: archiveId, status: "applied", version: 6 },
]);
const staleAfterRegrant = await reader.action(push, { changes: [{ ...clear, baseVersion: 4 }] });
assert.equal(staleAfterRegrant[0].status, "conflict");
assert.deepEqual((await reader.query(get, archiveArgs)).reminder, { ...reminderV4, version: 6 });
await assert.rejects(
	reader.action(push, {
		changes: [{ ...reminder, remindAt: "2027-02-03T12:30Z" }],
	}),
);
console.log(
	"Passed: personal reminder, stale clear, replay, clear/recreate, snapshot and share cleanup.",
);

const tagId = randomUUID();
const tag = { type: "tag", id: tagId, name: "Project", color: "#119966" };
const beforeTag = await owner.query(feed, {});
assert.deepEqual(await owner.action(push, { changes: [tag] }), [
	{ type: "tag", id: tagId, status: "applied", version: 1 },
]);
const addedTag = await owner.query(feed, { after: beforeTag.nextCursor });
assert.equal(addedTag.entries[0].entityType, "tag");
assert.equal(addedTag.entries[0].tag.name, tag.name);
assert.equal(addedTag.entries[0].tag.color, tag.color);
assert.equal(addedTag.entries[0].tag.version, 1);
const alternateTag = { ...tag, id: randomUUID() };
assert.deepEqual(await owner.action(push, { changes: [alternateTag] }), [
	{
		type: "tag",
		id: alternateTag.id,
		status: "conflict",
		serverCopy: addedTag.entries[0].tag,
	},
]);
assert.deepEqual(await reader.action(push, { changes: [tag] }), [
	{ type: "tag", id: tagId, status: "denied" },
]);
assert.deepEqual(await reader.action(push, { changes: [alternateTag] }), [
	{ type: "tag", id: alternateTag.id, status: "applied", version: 1 },
]);
const ownerTags = await drain(owner, await owner.query(sync, { limit: 2 }), 2);
assert.deepEqual(
	ownerTags.entries
		.filter((entry) => entry.entityType === "tag")
		.map((entry) => entry.entityId),
	[tagId],
);
const readerTags = await drain(
	reader,
	await reader.query(sync, { limit: 2 }),
	2,
);
assert.deepEqual(
	readerTags.entries
		.filter((entry) => entry.entityType === "tag")
		.map((entry) => entry.entityId),
	[alternateTag.id],
);

const rename = { ...tag, name: "Renamed", baseVersion: 1 };
assert.deepEqual(await owner.action(push, { changes: [rename] }), [
	{ type: "tag", id: tagId, status: "applied", version: 2 },
]);
const afterRename = await owner.query(feed, { after: addedTag.nextCursor });
assert.equal(afterRename.entries[0].tag.name, rename.name);
assert.deepEqual(
	await owner.action(push, { changes: [{ ...rename, name: "Stale" }] }),
	[
		{
			type: "tag",
			id: tagId,
			status: "conflict",
			serverCopy: afterRename.entries[0].tag,
		},
	],
);
const deleteTag = { ...rename, isDeleted: true, baseVersion: 2 };
assert.deepEqual(await owner.action(push, { changes: [deleteTag] }), [
	{ type: "tag", id: tagId, status: "applied", version: 3 },
]);
const afterDeleteTag = await owner.query(feed, {
	after: afterRename.nextCursor,
});
assert.deepEqual(
	afterDeleteTag.entries.map((entry) => [
		entry.entityType,
		entry.op,
		entry.entityId,
		entry.tag,
	]),
	[["tag", "remove", tagId, undefined]],
);
assert.deepEqual(await owner.action(push, { changes: [deleteTag] }), [
	{ type: "tag", id: tagId, status: "applied", version: 3 },
]);
assert.deepEqual(await owner.action(push, { changes: [tag] }), [
	{ type: "tag", id: tagId, status: "denied" },
]);
console.log(
	"Passed: isolated tags, name merge target, snapshot, version conflict and tombstone.",
);

const pager = client("tag-pager");
const tagA = { ...tag, id: "zza-" + randomUUID(), name: "First tag" };
const tagB = { ...tag, id: "zzb-" + randomUUID(), name: "Second tag" };
const pagedNote = randomUUID();
await pager.action(push, { changes: [tagA, tagB] });
await pager.mutation(create, { id: pagedNote, title: "After tags" });
const tagPage = await pager.query(sync, { limit: 1 });
assert.equal(tagPage.entries[0].entityId, tagA.id);
await pager.action(push, {
	changes: [{ ...tagB, isDeleted: true, baseVersion: 1 }],
});
const afterTags = await drain(pager, tagPage, 1);
assert.ok(
	afterTags.entries.some(
		(entry) => entry.seq === "0" && entry.entityId === pagedNote,
	),
);
assert.ok(
	afterTags.entries.some(
		(entry) => entry.op === "remove" && entry.entityId === tagB.id,
	),
);
console.log(
	"Passed: deleting the remaining tag during snapshot does not skip the notes phase.",
);

const ownerTag = { ...tag, id: randomUUID(), name: "Owner private tag" };
const readerTag = { ...tag, id: randomUUID(), name: "Reader private tag" };
const assocId = randomUUID();
await owner.action(push, {
	changes: [
		ownerTag,
		{
			type: "note",
			id: assocId,
			title: "Tagged shared note",
			tagIds: [ownerTag.id, readerTag.id],
		},
	],
});
await reader.action(push, { changes: [readerTag] });
await owner.mutation(setShare, {
	id: assocId,
	subject: subject("reader"),
	permission: "viewer",
});
assert.deepEqual((await owner.query(get, { id: assocId })).tagIds, [
	ownerTag.id,
]);
assert.deepEqual((await reader.query(get, { id: assocId })).tagIds, []);
const ownerAssocHead = (await owner.query(feed, {})).nextCursor;
const readerAssocHead = (await reader.query(feed, {})).nextCursor;
const attach = {
	type: "note",
	id: assocId,
	title: "Tagged shared note",
	tagIds: [readerTag.id, readerTag.id, ownerTag.id],
};
assert.deepEqual(await reader.action(push, { changes: [attach] }), [
	{ type: "note", id: assocId, status: "applied", version: 1 },
]);
assert.equal(
	(await owner.query(feed, { after: ownerAssocHead })).entries.length,
	0,
);
const attached = await reader.query(feed, { after: readerAssocHead });
assert.equal(attached.entries.length, 1);
assert.deepEqual(attached.entries[0].note.tagIds, [readerTag.id]);
await reader.action(push, { changes: [attach] });
assert.deepEqual(
	(await reader.query(feed, { after: attached.nextCursor })).entries,
	[],
);

await owner.mutation(update, {
	id: assocId,
	baseVersion: 1,
	title: "Owner changed title",
});
const staleTagPush = (
	await reader.action(push, {
		changes: [{ ...attach, baseVersion: 1, tagIds: [] }],
	})
)[0];
assert.equal(staleTagPush.status, "conflict");
assert.equal(staleTagPush.serverCopy.version, 2);
assert.deepEqual(staleTagPush.serverCopy.tagIds, []);
assert.deepEqual((await owner.query(get, { id: assocId })).tagIds, [
	ownerTag.id,
]);

await reader.action(push, {
	changes: [{ ...attach, title: "Owner changed title" }],
});
await owner.mutation(setShare, {
	id: assocId,
	subject: subject("reader"),
	permission: null,
});
await owner.mutation(setShare, {
	id: assocId,
	subject: subject("reader"),
	permission: "viewer",
});
assert.deepEqual((await reader.query(get, { id: assocId })).tagIds, []);
await owner.action(push, {
	changes: [{ ...ownerTag, baseVersion: 1, isDeleted: true }],
});
assert.deepEqual((await owner.query(get, { id: assocId })).tagIds, []);
console.log(
	"Passed: private tag associations, no version bump, stale-content independence and cleanup.",
);

const place = makeFunctionReference("notes:place");
const placedTag = { ...tag, id: randomUUID(), name: "Placed tag" };
await owner.action(push, { changes: [placedTag] });
const beforePosition = await reader.query(get, { id: assocId });
const beforeOrder = await Promise.all(
	[owner, reader].map((actor) => actor.query(feed, {})),
);
assert.deepEqual(
	await reader.mutation(place, {
		kind: "note",
		positions: [
			{ id: assocId, position: "a0" },
			{ id: assocId, position: "a2" },
			{ id: pagedNote, position: "a1" },
		],
	}),
	{ updated: [assocId] },
);
assert.deepEqual(await reader.query(get, { id: assocId }), {
	...beforePosition,
	position: "a2",
});
assert.equal((await owner.query(get, { id: assocId })).position, null);
assert.deepEqual(
	await reader.mutation(place, {
		kind: "note",
		positions: [{ id: assocId, position: "a2" }],
	}),
	{ updated: [] },
);
const localOrder = await reader.query(feed, {
	after: beforeOrder[1].nextCursor,
});
assert.equal(localOrder.entries.length, 1);
assert.equal(localOrder.entries[0].note.position, "a2");
assert.deepEqual(
	(await owner.query(feed, { after: beforeOrder[0].nextCursor })).entries,
	[],
);
await assert.rejects(
	reader.mutation(place, {
		kind: "note",
		positions: [
			{ id: assocId, position: "a3" },
			{ id: pagedNote, position: "not valid" },
		],
	}),
);
assert.equal((await reader.query(get, { id: assocId })).position, "a2");
await owner.mutation(setShare, {
	id: assocId,
	subject: subject("reader"),
	permission: null,
});
await owner.mutation(setShare, {
	id: assocId,
	subject: subject("reader"),
	permission: "viewer",
});
assert.equal((await reader.query(get, { id: assocId })).position, null);

assert.deepEqual(
	await reader.mutation(place, {
		kind: "tag",
		positions: [{ id: placedTag.id, position: "a1" }],
	}),
	{ updated: [] },
);
assert.deepEqual(
	await owner.mutation(place, {
		kind: "tag",
		positions: [{ id: placedTag.id, position: "a1" }],
	}),
	{ updated: [placedTag.id] },
);
const reordered = (
	await owner.query(feed, { after: beforeOrder[0].nextCursor })
).entries.at(-1).tag;
assert.equal(reordered.position, "a1");
assert.equal(reordered.version, 1);
assert.equal(
	reordered.updatedAt,
	beforeOrder[0].entries.find((entry) => entry.entityId === placedTag.id).tag
		.updatedAt,
);
assert.deepEqual(
	await owner.action(push, {
		changes: [{ ...placedTag, name: "Renamed after reorder", baseVersion: 1 }],
	}),
	[{ type: "tag", id: placedTag.id, status: "applied", version: 2 }],
);
const renamedOrder = (
	await owner.query(feed, { after: beforeOrder[0].nextCursor })
).entries.at(-1).tag;
assert.equal(renamedOrder.position, "a1");
assert.equal(renamedOrder.name, "Renamed after reorder");
console.log(
	"Passed: private note and tag positions, deduplication, validation and version independence.",
);
