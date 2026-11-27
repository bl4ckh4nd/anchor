import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createSign, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const origin = "http://127.0.0.1:" + process.env.ANCHOR_CONVEX_SITE_PORT;
const cliEnv = process.env.ANCHOR_TEST_CONVEX_ENV;
assert.ok(cliEnv);
const cli = (args, input) => execFileSync(process.execPath,
	["node_modules/convex/bin/main.js", ...args, "--env-file", cliEnv],
	{ input, encoding: "utf8", timeout: 60_000 }).trim();
const paths = ["compose/sync", "sync"];
const targetStateFile = process.argv[2];

async function post(path, token, body, status = 200, scope) {
	const res = await fetch(origin + "/api/" + path, {
		method: "POST", signal: AbortSignal.timeout(10_000),
		headers: {
			Authorization: "Bearer " + token, "Content-Type": "application/json", "X-Anchor-Protocol": "4",
			...(scope === undefined ? {} : { "X-Anchor-Outbox-Scope": scope }),
		},
		body: JSON.stringify(body),
	});
	assert.equal(res.status, status, path);
	return res.json();
}

async function snapshot(path, token, cursor) {
	const entries = [];
	for (let page = 0; page < 12; page++) {
		const result = await post(path, token, cursor ? { cursor, limit: 1 } : { limit: 1 });
		assert.notEqual(result.resetRequired, true);
		entries.push(...result.entries);
		if (!result.hasMore) return { entries, cursor: result.nextCursor };
		assert.ok(result.nextCursor && result.nextCursor !== cursor);
		cursor = result.nextCursor;
	}
	assert.fail("Snapshot exceeded expected pages");
}

cli(["env", "set", "ANCHOR_NATIVE_PASSWORD_AUTH", "false"]);
if (targetStateFile) {
	const { token, jwks, cursors, source } = JSON.parse(readFileSync(targetStateFile, "utf8"));
	cli(["env", "set", "ANCHOR_AUTH_JWKS"], jwks);
	cli(["deploy", "--yes", "--codegen", "disable"]);
	const target = randomUUID();
	await post("compose/notes", token, { id: target, title: "Independent target note" }, 200);
	for (const path of paths) {
		const local = await snapshot(path, token);
		assert.ok(local.entries.some((entry) => entry.entityId === target));
		const unscoped = local.cursor.replace(/:@[0-9a-f]{64}:/, ":");
		assert.match(unscoped, /^[nl][1-5]:d:[1-9][0-9]*:$/);
		assert.equal(unscoped, cursors[path].replace(/:@[0-9a-f]{64}:/, ":"));
		assert.equal((await post(path, token, { cursor: unscoped })).resetRequired, true);
		const replaced = await post(path, token, { cursor: cursors[path] });
		assert.equal(replaced.resetRequired, true, path);
		assert.equal(replaced.nextCursor, null);
		assert.deepEqual(replaced.entries, []);
		const rebuilt = await snapshot(path, token);
		assert.ok(rebuilt.entries.some((entry) => entry.entityId === target));
		assert.ok(!rebuilt.entries.some((entry) => entry.entityId === source));
		assert.notEqual(rebuilt.cursor, cursors[path]);
		assert.equal((await post(path, token, { cursor: rebuilt.cursor })).resetRequired, undefined);
	}
	const queued = { type: "note", id: randomUUID(), title: "Queued on the previous instance" };
	const reset = await post("compose/sync", token, { cursor: cursors["compose/sync"], changes: [queued] });
	assert.equal(reset.resetRequired, true);
	assert.deepEqual(reset.results, []);
	assert.ok(!(await snapshot("compose/sync", token)).entries.some((entry) => entry.entityId === queued.id));
	const oldScope = cursors["compose/sync"].split(":")[1].slice(1);
	const expectedMismatch = { code: "OUTBOX_SCOPE_CHANGED" };
	assert.deepEqual(await post("compose/notes", token, { id: queued.id, title: queued.title }, 409, oldScope),
		expectedMismatch);
	assert.deepEqual(await post("compose/sync", token, { changes: [queued] }, 409, oldScope), expectedMismatch);
	for (const method of ["POST", "DELETE"]) {
		const response = await fetch(origin + "/api/compose/attachments?noteId=" + target + "&attachmentId=" + randomUUID(), {
			method,
			headers: { Authorization: "Bearer " + token, "X-Anchor-Outbox-Scope": oldScope },
		});
		assert.equal(response.status, 409, method);
		assert.deepEqual(await response.json(), expectedMismatch);
	}
	const read = await fetch(origin + "/api/compose/sync", {
		method: "POST",
		headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
		body: "{}",
	});
	const scope = read.headers.get("X-Anchor-Sync-Scope");
	assert.match(scope, /^[0-9a-f]{64}$/);
	assert.notEqual(scope, oldScope);
	assert.ok(!(await snapshot("compose/sync", token)).entries.some((entry) => entry.entityId === queued.id));
	const fresh = { id: randomUUID(), title: "Queued on the new instance" };
	assert.equal((await post("compose/notes", token, fresh, 200, scope)).id, fresh.id);
	const tagId = randomUUID();
	assert.equal((await post("compose/sync", token, {
		changes: [{ type: "tag", id: tagId, name: "Target personal tag" }],
	})).results[0].status, "applied");
	const patchTags = (expectedScope) => fetch(origin + "/api/notes/" + target, {
		method: "PATCH",
		headers: {
			Authorization: "Bearer " + token, "Content-Type": "application/json",
			"X-Anchor-Outbox-Scope": expectedScope,
		},
		body: JSON.stringify({ tagIds: [tagId] }),
	});
	const wrongScope = await patchTags(oldScope);
	assert.equal(wrongScope.status, 409);
	assert.deepEqual(await wrongScope.json(), expectedMismatch);
	const unchanged = await fetch(origin + "/api/notes/" + target, {
		headers: { Authorization: "Bearer " + token },
	});
	assert.equal(unchanged.status, 200);
	assert.deepEqual((await unchanged.json()).tagIds, []);
	const patched = await patchTags(scope);
	assert.equal(patched.status, 200);
	const tagged = await patched.json();
	assert.deepEqual(tagged.tagIds, [tagId]);
	assert.equal(tagged.title, "Independent target note");
	assert.equal(tagged.version, 1);
	console.log(JSON.stringify({ composeAndLegacyResetAcrossIndependentInstances: true,
		unscopedCursorResets: true, freshSnapshotContainsOnlyNewInstance: true,
		oldComposeCursorCannotApplyQueuedChange: true, outboxScopeGuardedOnWrites: true,
		scopedTagPatchPreservedTitleAndVersion: true }));
} else {
	const now = Math.floor(Date.now() / 1000);
	const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
	const claims = encode({ alg: "RS256", kid: "anchor-convex" }) + "." +
		encode({ iss: process.env.ANCHOR_TEST_ISSUER, sub: "cursor-instance-fixture", aud: "anchor", iat: now, exp: now + 360 });
	const token = claims + "." + createSign("RSA-SHA256").update(claims)
		.sign(readFileSync(join(dirname(cliEnv), "fixture.pem"))).toString("base64url");
	const source = randomUUID();
	await post("compose/notes", token, { id: source, title: "Independent source note" }, 200);
	const cursors = {};
	for (const path of paths) {
		const local = await snapshot(path, token);
		assert.ok(local.entries.some((entry) => entry.entityId === source));
		cursors[path] = local.cursor;
	}
	const directory = mkdtempSync(join(tmpdir(), "anchor-cursor-private."));
	try {
		const fixture = join(directory, "fixture.json");
		writeFileSync(fixture, JSON.stringify({ token, source, cursors, jwks: cli(["env", "get", "ANCHOR_AUTH_JWKS"]) }),
			{ mode: 0o600 });
		const output = execFileSync("bash", ["e2e/self-hosted-contracts.sh", "--native-command",
			process.execPath, "e2e/cursor-instance.mjs", fixture],
		{ encoding: "utf8", timeout: 150_000, env: { ...process.env, ANCHOR_TEST_RELEASE_ARTIFACT: "",
			ANCHOR_CONVEX_API_PORT: "3994", ANCHOR_CONVEX_SITE_PORT: "3995" } });
		console.log(JSON.stringify(JSON.parse(output.trim().split("\n").at(-1))));
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
