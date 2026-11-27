import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const origin = `http://127.0.0.1:${process.env.ANCHOR_CONVEX_SITE_PORT}`;
async function call(path, status, { method = "POST", body, token } = {}) {
	const response = await fetch(origin + "/api/" + path, {
		method,
		headers: {
			...(body instanceof FormData
				? {}
				: { "Content-Type": "application/json" }),
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body:
			body instanceof FormData
				? body
				: body === undefined
					? undefined
					: JSON.stringify(body),
	});
	assert.equal(
		response.status,
		status,
		`${method} ${path}: ${await response.clone().text()}`,
	);
	return response;
}

const register = async (name) =>
	(
		await (
			await call("auth/register", 201, {
				body: {
					name,
					email: `${name}@example.test`,
					password: "ImportFixture2026",
				},
			})
		).json()
	).access_token;
const token = await register("importer");
const outsider = await register("outsider");
const foreign = await (
	await call("notes", 201, { body: { title: "Foreign note" }, token: outsider })
).json();
const original = randomUUID();
const trash = randomUUID();
const content = JSON.stringify({
	ops: [{ insert: "Backup text\n", attributes: { bold: true } }],
});
const body = {
	skipExisting: true,
	tags: [{ name: "Work", color: "#abcdef" }, { name: "work" }],
	notes: [
		{
			ref: "active",
			id: original,
			title: "Restored",
			content,
			isPinned: true,
			isArchived: true,
			background: "color_teal",
			tagNames: ["Work", "work"],
			reminder: { remindAt: "2030-02-03T15:45", recurrence: "daily" },
			createdAt: "2024-01-02T03:04:05.500Z",
			updatedAt: "2024-03-02T03:04:05.500Z",
		},
		{ ref: "trash", id: trash, title: "Trashed", isTrashed: true },
		{
			ref: "foreign",
			id: foreign.id,
			title: "Remapped",
			content: "invalid JSON",
			background: "unknown",
		},
	],
};
await call("import/notes", 401, { body });
await call("import/notes", 400, {
	body: { notes: [body.notes[0], { ref: "bad" }] },
	token,
});
const empty = await (await call("notes", 200, { method: "GET", token })).json();
assert.deepEqual(empty, []);
const { results, tags } = await (
	await call("import/notes", 201, { body, token })
).json();
assert.deepEqual(tags, { created: 2, reused: 0 });
assert.deepEqual(results.slice(0, 2), [
	{ ref: "active", status: "created", noteId: original },
	{ ref: "trash", status: "created", noteId: trash },
]);
assert.equal(results[2].status, "remapped");
assert.notEqual(results[2].noteId, foreign.id);
assert.match(results[2].warning, /Content was not valid.*Unknown background/);
const repeat = await (
	await call("import/notes", 201, {
		body: { ...body, notes: body.notes.slice(0, 2) },
		token,
	})
).json();
assert.deepEqual(repeat.tags, { created: 0, reused: 2 });
assert.deepEqual(
	repeat.results.map((note) => note.status),
	["skipped", "skipped"],
);

function upload(position, bytes = Buffer.alloc(1024, 42)) {
	const form = new FormData();
	form.set(
		"file",
		new Blob([bytes], { type: "audio/wav" }),
		`part-${position}.wav`,
	);
	form.set("position", String(position));
	return form;
}
const attachmentPath = `import/notes/${trash}/attachments`;
await call(attachmentPath, 403, { body: upload(0), token: outsider });
await call(attachmentPath, 400, { body: upload(-1), token });
const appended = await (
	await call(attachmentPath, 201, { body: upload(2), token })
).json();
const first = await (
	await call(attachmentPath, 201, { body: upload(0), token })
).json();
assert.equal(appended.position, 2);
assert.equal(first.position, 0);
const list = await (
	await call(`notes/${trash}/attachments`, 200, { method: "GET", token })
).json();
assert.deepEqual(
	list.map((row) => row.id),
	[first.id, appended.id],
);
const attachment = await call(`notes/${trash}/attachments/${first.id}`, 200, {
	method: "GET",
	token,
});
assert.deepEqual(
	Buffer.from(await attachment.arrayBuffer()),
	Buffer.alloc(1024, 42),
);
const stored = await (
	await call(`notes/${original}`, 200, { method: "GET", token })
).json();
assert.equal(stored.content, content);
assert.equal(stored.createdAt, "2024-01-02T03:04:05.000Z");
assert.equal(stored.updatedAt, "2024-03-02T03:04:05.000Z");
assert.equal(stored.isArchived, true);
assert.equal(stored.isPinned, true);
assert.equal(stored.reminder.remindAt, "2030-02-03T15:45");
assert.equal(stored.tagIds.length, 2);
console.log(
	JSON.stringify(
		{
			notes: results.length,
			reusableIds: true,
			retainedMetadata: true,
			orderedAttachmentBytes: true,
		},
		null,
		2,
	),
);
