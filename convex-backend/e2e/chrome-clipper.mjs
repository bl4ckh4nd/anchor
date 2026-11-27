import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const base =
	process.argv[2] ?? `http://127.0.0.1:${process.env.ANCHOR_CONVEX_SITE_PORT}`;
assert.equal(new URL(base).hostname, "127.0.0.1");
const call = (path, method, token, data) =>
	fetch(`${base}/api/${path}`, {
		method,
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			...(data && !(data instanceof FormData)
				? { "Content-Type": "application/json" }
				: {}),
		},
		body: data && (data instanceof FormData ? data : JSON.stringify(data)),
	});
const email = `clipper-${randomUUID()}@example.test`;
const account = await call("auth/register", "POST", null, {
	email,
	name: "Clipper fixture",
	password: "SyntheticClipper2026!",
});
assert.equal(account.status, 201);
const web = await account.json();
assert.equal((await call("auth/clipper/session", "POST")).status, 401);
const granted = await call("auth/clipper/session", "POST", web.access_token);
assert.equal(granted.status, 200);
const clipper = await granted.json();
assert.notEqual(clipper.access_token, web.access_token);
assert.notEqual(clipper.refresh_token, web.refresh_token);
const tok = clipper.access_token;
const tag = await call("tags", "POST", tok, { name: "Clippings" });
assert.equal(tag.status, 201);
const { id: tagId } = await tag.json();
const note = {
	id: randomUUID(),
	title: "Clipped note",
	content: JSON.stringify({
		ops: [
			{ insert: "Selected text" },
			{ insert: "\n", attributes: { blockquote: true } },
			{
				insert: "Source",
				attributes: { link: "https://example.test/article" },
			},
			{ insert: "\n" },
		],
	}),
	tagIds: [tagId],
};
for (let retry = 0; retry < 2; retry++) {
	const saved = await call("notes", "POST", tok, note);
	assert.equal(saved.status, 201);
	assert.equal((await saved.json()).id, note.id);
}
const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2xoAAAAASUVORK5CYII=",
	"base64",
);
const files = new FormData();
files.set("file", new Blob([png], { type: "image/png" }), "clip.png");
files.set("position", "0");
const uploaded = await call(
	`import/notes/${note.id}/attachments`,
	"POST",
	tok,
	files,
);
assert.equal(uploaded.status, 201, await uploaded.clone().text());
const attachment = await uploaded.json();
const download = await call(
	`notes/${note.id}/attachments/${attachment.id}`,
	"GET",
	tok,
);
assert.equal(download.status, 200);
assert.deepEqual(Buffer.from(await download.arrayBuffer()), png);
const detail = await (await call(`notes/${note.id}`, "GET", tok)).json();
assert.equal(detail.content, note.content);
assert.deepEqual(detail.tagIds, [tagId]);
const revoke = await call("auth/logout", "POST", tok, {
	refreshToken: clipper.refresh_token,
});
assert.equal(revoke.status, 200);
assert.equal((await call("auth/me", "GET", tok)).status, 401);
assert.equal((await call("auth/me", "GET", web.access_token)).status, 200);
console.log(
	JSON.stringify({
		separateRevocableSession: true,
		idempotentNoteCreation: true,
		tagAndRichText: true,
		attachmentBytes: true,
	}),
);
