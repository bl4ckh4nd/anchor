import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cliEnv = process.env.ANCHOR_TEST_CONVEX_ENV;
assert.ok(cliEnv, "Run inside the disposable native Convex fixture");
const origin = "http://127.0.0.1:" + process.env.ANCHOR_CONVEX_SITE_PORT;
assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
const cli = (args, input) =>
	execFileSync(
		process.execPath,
		["node_modules/convex/bin/main.js", ...args, "--env-file", cliEnv],
		{ input, encoding: "utf8", timeout: 60_000 },
	).trim();
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const signingSettings = [
	"ANCHOR_AUTH_ISSUER",
	"ANCHOR_AUTH_JWKS",
	"ANCHOR_CONVEX_SIGNING_KEY",
	"ANCHOR_SESSION_SECRET",
];
const baseBytes = Buffer.from("Anchor attachment from before cutover");
const currentBytes = Buffer.alloc(65_537, 0xab);
const richText = JSON.stringify({
	ops: [
		{ insert: "Acknowledged after cutover", attributes: { bold: true } },
		{ insert: "\n" },
	],
});

async function call(path, status, { method = "GET", body, token, scope } = {}) {
	const multipart = body instanceof FormData;
	const response = await fetch(origin + "/api/" + path, {
		method,
		headers: {
			...(body !== undefined && !multipart
				? { "Content-Type": "application/json" }
				: {}),
			...(token ? { Authorization: "Bearer " + token } : {}),
			...(scope ? { "X-Anchor-Outbox-Scope": scope } : {}),
		},
		body: body === undefined || multipart ? body : JSON.stringify(body),
		signal: AbortSignal.timeout(15_000),
	});
	assert.equal(response.status, status, method + " " + path);
	return response;
}

async function json(path, status, options) {
	return (await call(path, status, options)).json();
}

const register = (name) =>
	json("auth/register", 201, {
		method: "POST",
		body: {
			name,
			email: name + "@example.test",
			password: "RestoreFixture2026!",
		},
	});
const refresh = (refresh_token) =>
	json("auth/refresh", 200, {
		method: "POST",
		body: { refresh_token },
	});

const sync = (token, body = {}, scope) =>
	json("compose/sync", 200, { method: "POST", token, body, scope });

async function readScope(token, expected) {
	const response = await call("compose/sync", 200, { method: "POST", token, body: { limit: 1 }, scope: expected });
	const scope = response.headers.get("X-Anchor-Sync-Scope");
	assert.match(scope, /^[0-9a-f]{64}$/);
	return scope;
}

async function upload(path, token, filename, bytes) {
	const body = new FormData();
	body.set("file", new Blob([bytes], { type: "audio/wav" }), filename);
	return (
		await json(path + "/attachments", 201, { method: "POST", token, body })
	).id;
}

async function download(path, id, token, bytes) {
	const data = await call(path + "/attachments/" + id, 200, { token });
	assert.equal(hash(Buffer.from(await data.arrayBuffer())), hash(bytes));
}

function backup(path) {
	cli(["export", "--include-file-storage", "--path", path]);
	return hash(readFileSync(path));
}

const [mode = "source", directory] = process.argv.slice(2);
if (mode === "source") {
	const scratch = mkdtempSync(join(tmpdir(), "anchor-restore-data."));
	try {
		const settings = Object.fromEntries(
			signingSettings.map((key) => [key, cli(["env", "get", key])]),
		);
		assert.ok(settings.ANCHOR_CONVEX_SIGNING_KEY.includes("BEGIN PRIVATE KEY"));
		assert.match(settings.ANCHOR_SESSION_SECRET, /^[0-9a-f]{64}$/);
		writeFileSync(join(scratch, "signing.json"), JSON.stringify(settings), {
			mode: 0o600,
		});
		const owner = await register("restore-owner");
		const guest = await register("restore-guest");
		const token = owner.access_token;
		const scope = await readScope(token);
		const note = await json("notes", 201, {
			method: "POST",
			token,
			body: { title: "Before cutover" },
		});
		const path = "notes/" + note.id;
		const firstFile = await upload(path, token, "before.wav", baseBytes);
		const share = await json(path + "/shares", 201, {
			method: "POST",
			token,
			body: { sharedWithUserId: guest.user.id, permission: "viewer" },
		});
		let snapshot = await sync(token);
		for (let page = 0; snapshot.hasMore && page < 16; page++) {
			assert.ok(snapshot.nextCursor);
			snapshot = await sync(token, { cursor: snapshot.nextCursor });
		}
		assert.equal(snapshot.hasMore, false);
		assert.ok(snapshot.nextCursor);
		const baselineHash = backup(join(scratch, "baseline.zip"));
		const edit = await json(path, 200, {
			method: "PATCH",
			token,
			body: { title: "After cutover", content: richText },
		});
		const finalFile = await upload(path, token, "after.wav", currentBytes);
		const fresh = await json("notes", 201, {
			method: "POST",
			token,
			body: { title: "New after cutover" },
		});
		await call(path + "/shares/" + share.id, 200, { method: "DELETE", token });
		const rotated = await refresh(owner.refresh_token);
		const delta = await sync(token, { cursor: snapshot.nextCursor });
		assert.equal(delta.hasMore, false);
		assert.ok(
			delta.entries.some(
				(entry) =>
					entry.note?.id === note.id && entry.note?.version === edit.version,
			),
		);
		const finalHash = backup(join(scratch, "latest.zip"));
		assert.notEqual(baselineHash, finalHash);
		writeFileSync(
			join(scratch, "fixture.json"),
			JSON.stringify({
				owner,
				guest,
				path,
				firstFile,
				finalFile,
				fresh: fresh.id,
				oldVersion: note.version,
				newVersion: edit.version,
				noteId: note.id,
				cursor: snapshot.nextCursor,
				scope,
				delta,
				rotated: rotated.refresh_token,
			}),
			{ mode: 0o600 },
		);

		const targets = {};
		for (const [state, apiPort, sitePort] of [
			["baseline", "3996", "3997"],
			["latest", "3998", "3999"],
		]) {
			const output = execFileSync(
				"bash",
				[
					"e2e/self-hosted-contracts.sh",
					"--native-command",
					process.execPath,
					"e2e/restore-current.mjs",
					state,
					scratch,
				],
				{
					encoding: "utf8",
					env: {
						...process.env,
						ANCHOR_TEST_RELEASE_ARTIFACT: "",
						ANCHOR_CONVEX_API_PORT: apiPort,
						ANCHOR_CONVEX_SITE_PORT: sitePort,
					},
					timeout: 150_000,
				},
			);
			targets[state] = JSON.parse(output.trim().split("\n").at(-1));
		}
		console.log(
			JSON.stringify({
				baseline: targets.baseline,
				latest: targets.latest,
				snapshotSha256: { baseline: baselineHash, latest: finalHash },
			}),
		);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
} else {
	assert.ok(["baseline", "latest"].includes(mode) && directory);
	const latest = mode === "latest";
	const settings = JSON.parse(
		readFileSync(join(directory, "signing.json"), "utf8"),
	);
	for (const key of signingSettings) cli(["env", "set", key], settings[key]);
	cli(["deploy", "--yes", "--codegen", "disable"]);
	cli(["import", "--yes", join(directory, mode + ".zip")]);
	const {
		owner,
		guest,
		path,
		firstFile,
		finalFile,
		fresh,
		oldVersion,
		newVersion,
		noteId,
		cursor,
		scope,
		delta,
		rotated,
	} = JSON.parse(readFileSync(join(directory, "fixture.json"), "utf8"));
	const token = owner.access_token;
	assert.equal((await json("auth/me", 200, { token })).id, owner.user.id);
	const restored = await json(path, 200, { token });
	assert.equal(restored.version, latest ? newVersion : oldVersion);
	assert.equal(restored.title, latest ? "After cutover" : "Before cutover");
	if (latest) assert.equal(restored.content, richText);
	await download(path, firstFile, token, baseBytes);
	if (latest) {
		await download(path, finalFile, token, currentBytes);
		await call(path + "/attachments/" + finalFile, 404, {
			token: guest.access_token,
		});
		assert.equal(
			(await json("notes/" + fresh, 200, { token })).title,
			"New after cutover",
		);
		const replay = await refresh(owner.refresh_token);
		assert.equal(replay.refresh_token, rotated);
		assert.equal(
			(await json("auth/me", 200, { token: replay.access_token })).id,
			owner.user.id,
		);
		assert.deepEqual(await sync(token, { cursor }), delta);
		assert.equal(await readScope(replay.access_token, scope), scope);
		const applied = await sync(replay.access_token, {
			cursor: delta.nextCursor,
			changes: [
				{
					type: "note",
					id: noteId,
					baseVersion: newVersion,
					title: "Written after restore",
				},
			],
		}, scope);
		assert.deepEqual(applied.results, [
			{ type: "note", id: noteId, status: "applied", version: newVersion + 1 },
		]);
		assert.equal(
			(await json(path, 200, { token })).title,
			"Written after restore",
		);
		console.log(
			JSON.stringify({
				acknowledgedEdit: true,
				newNoteAndAttachment: true,
				bothAttachmentsByteIdentical: true,
				revocationRetained: true,
				refreshRotationResumed: true,
				composeCursorResumed: true,
				outboxScopeResumed: true,
				acceptedNewWriteAfterRestore: true,
			}),
		);
	} else {
		await download(path, firstFile, guest.access_token, baseBytes);
		await call("notes/" + fresh, 404, { token });
		await call(path + "/attachments/" + finalFile, 404, { token });
		assert.deepEqual((await sync(token, { cursor })).entries, []);
		console.log(
			JSON.stringify({ baselineRestored: true, postCutoverWritesAbsent: true }),
		);
	}
}
