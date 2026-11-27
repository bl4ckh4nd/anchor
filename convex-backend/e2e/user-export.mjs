import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";

const origin = `http://127.0.0.1:${process.env.ANCHOR_CONVEX_SITE_PORT}`;
async function call(path, status, { method = "GET", body, token, headers } = {}) {
	const response = await fetch(origin + "/api/" + path, {
		method,
		headers: {
			...headers,
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
	assert.equal(response.status, status, `${method} ${path}`);
	return response;
}

await call("export", 401);
async function register(name) {
	return await (
		await call("auth/register", 201, {
			method: "POST",
			body: {
				name,
				email: `${name}@example.test`,
				password: "ExportFixture2026",
			},
		})
	).json();
}
const owner = await register("owner");
const guest = await register("guest");
const token = owner.access_token;
const post = async (path, body, bearer = token) =>
	await (await call(path, 201, { method: "POST", body, token: bearer })).json();
const tag = await post("tags", { name: "Research", color: "#aabbcc" });
const content = JSON.stringify({ ops: [{ insert: "Export fixture\n" }] });
const kept = await post("notes", {
	title: "Kept",
	content,
	isPinned: true,
	isArchived: true,
	tagIds: [tag.id],
});
const trash = await post("notes", { title: "Trashed" });
await call("notes/" + trash.id, 200, { method: "DELETE", token });
const shared = await post(
	"notes",
	{ title: "Shared to owner" },
	guest.access_token,
);
await post(
	`notes/${shared.id}/shares`,
	{ sharedWithUserId: owner.user.id, permission: "viewer" },
	guest.access_token,
);
const revoked = await post(
	"notes",
	{ title: "Revoked from owner" },
	guest.access_token,
);
const revokedShare = await post(
	`notes/${revoked.id}/shares`,
	{ sharedWithUserId: owner.user.id, permission: "viewer" },
	guest.access_token,
);
await call(`notes/${revoked.id}/shares/${revokedShare.id}`, 200, {
	method: "DELETE",
	token: guest.access_token,
});
const secret = await post(
	"notes",
	{ title: "Never shared" },
	guest.access_token,
);
const bytes = Buffer.alloc(1024, 9);
const form = new FormData();
form.set("file", new Blob([bytes], { type: "audio/wav" }), "voice.wav");
const attachment = await post(`notes/${kept.id}/attachments`, form);
await call("export?format=unknown", 400, { token });

const directory = await mkdtemp(join(tmpdir(), "anchor-export-e2e-"));
try {
	for (const format of ["anchor", "markdown"]) {
		const response = await call(`export?format=${format}`, 200, { token });
		assert.equal(response.headers.get("content-type"), "application/zip");
		assert.match(
			response.headers.get("content-disposition"),
			/^attachment; filename="anchor-(export|markdown)-[\d-]+\.zip"$/,
		);
		const path = join(directory, `${format}.zip`);
		await pipeline(Readable.fromWeb(response.body), createWriteStream(path));
		const checked = spawnSync(
			"python3",
			[
				"-c",
				`
import json, sys, zipfile
path, fmt, kept, trash, shared, revoked, secret, tag, attachment, expected = sys.argv[1:]
with zipfile.ZipFile(path) as archive:
    assert archive.testzip() is None
    names = archive.namelist()
    if fmt == "anchor":
        manifest = json.loads(archive.read("manifest.json"))
        assert manifest["format"] == "anchor-export" and manifest["version"] == 1
        assert manifest["counts"] == {"notes": 3, "tags": 1, "attachments": 1}
        notes = {note["id"]: note for note in manifest["notes"]}
        assert set(notes) == {kept, trash, shared}
        assert notes[trash]["state"] == "trashed"
        assert notes[kept]["origin"] == "owned" and notes[kept]["content"] == expected
        assert notes[kept]["isArchived"] and notes[kept]["isPinned"] and notes[kept]["tagIds"] == [tag]
        assert notes[shared]["origin"] == "shared" and notes[shared]["sharedBy"]["email"] == "guest@example.test"
        [file] = notes[kept]["attachments"]
        assert file["id"] == attachment and archive.read(file["archivePath"]) == bytes([9]) * 1024
        print(json.dumps(notes[kept]))
    else:
        markdown = "\\n".join(archive.read(name).decode() for name in names if name.endswith(".md"))
        assert "Export fixture" in markdown and "Never shared" not in markdown and "Revoked from owner" not in markdown
        [media] = [name for name in names if name.endswith(".wav")]
        assert archive.read(media) == bytes([9]) * 1024
`,
				path,
				format,
				kept.id,
				trash.id,
				shared.id,
				revoked.id,
				secret.id,
				tag.id,
				attachment.id,
				content,
			],
			{
				encoding: "utf8",
			},
		);
		assert.equal(checked.status, 0, checked.stderr);
		if (format === "anchor") {
			const exported = JSON.parse(checked.stdout);
			const restored = await post(
				"import/notes",
				{
					notes: [
						{
							ref: exported.id,
							title: exported.title,
							content: exported.content,
						},
					],
				},
				guest.access_token,
			);
			const note = await (
				await call("notes/" + restored.results[0].noteId, 200, {
					token: guest.access_token,
				})
			).json();
			assert.equal(note.content, content);
		}
	}
	const checkLarge = process.argv.includes("--large");
	if (checkLarge) {
		const size = 50 * 1024 * 1024;
		const big = Buffer.alloc(size, 17);
		async function uploadLarge(name) {
			const form = new FormData();
			form.set("file", new Blob([big], { type: "audio/wav" }), name);
			return post(`notes/${kept.id}/attachments`, form);
		}
		const uploaded = await uploadLarge("large-one.wav");
		const response = await call("export", 200, { token });
		const path = join(directory, "large.zip");
		await pipeline(Readable.fromWeb(response.body), createWriteStream(path));
		const checkMedia = (archivePath, attachmentId) => spawnSync(
			"python3",
			[
				"-c",
				`
import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    manifest = json.loads(archive.read("manifest.json"))
    [item] = [item for note in manifest["notes"] for item in note["attachments"] if item["id"] == sys.argv[2]]
    assert item["fileSize"] == 50 * 1024 * 1024
    expected = bytes([17]) * (1024 * 1024)
    with archive.open(item["archivePath"]) as media:
        for _ in range(50):
            assert media.read(len(expected)) == expected
        assert media.read(1) == b""
`,
				archivePath,
				attachmentId,
			],
			{ encoding: "utf8" },
		);
		const check = checkMedia(path, uploaded.id);
		assert.equal(check.status, 0, check.stderr);
		const second = await uploadLarge("large-two.wav");
		const rejected = await call("export", 413, { token });
		assert.equal((await rejected.json()).code, "EXPORT_TOO_LARGE");
		const descriptor = await call("export", 202, {
			token,
			headers: { "X-Anchor-Export-Parts": "1" },
		});
		assert.match(descriptor.headers.get("content-disposition"), /attachment; filename="anchor-export-/);
		const { id, size: total, chunkSize } = await descriptor.json();
		assert(total > size * 2);
		assert(chunkSize > 0 && chunkSize < size);
		const part = `export/${id}`;
		await call(`${part}?offset=0`, 401);
		await call(`${part}?offset=0`, 404, { token: guest.access_token });
		await call(`${part}?offset=-1`, 400, { token });
		await call(`${part}?offset=${total}`, 416, { token });
		const fullPath = join(directory, "segmented.zip");
		await pipeline(
			(async function* () {
				for (let offset = 0; offset < total; offset += chunkSize) {
					const end = Math.min(total, offset + chunkSize);
					const response = await call(`${part}?offset=${offset}`, 206, { token });
					assert.equal(response.headers.get("content-range"), `bytes ${offset}-${end - 1}/${total}`);
					assert.equal(response.headers.get("content-length"), String(end - offset));
					yield* Readable.fromWeb(response.body);
				}
			})(),
			createWriteStream(fullPath),
		);
		for (const item of [uploaded, second]) {
			const mediaCheck = checkMedia(fullPath, item.id);
			assert.equal(mediaCheck.status, 0, mediaCheck.stderr);
		}
		await call("auth/logout", 200, {
			method: "POST",
			body: { refreshToken: owner.refresh_token },
		});
		await call(`${part}?offset=0`, 401, { token });
	}
	console.log(
		JSON.stringify(
			{
				anchorZip: true,
				markdownZip: true,
				sharedAccess: true,
				originalMediaBytes: true,
				reimportedQuill: true,
				...(checkLarge
					? { fiftyMiBAttachment: true, oversizedArchiveRejected: true, segmentedArchiveVerified: true, revokedSessionDenied: true }
					: {}),
			},
			null,
			2,
		),
	);
} finally {
	await rm(directory, { recursive: true, force: true });
}
