import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { assertFixtureOrigin } from "./release-origin.mjs";

const [origin, adminEnv] = process.argv.slice(2);
assertFixtureOrigin(origin, 3735);
assert.ok(adminEnv);
const picture = "/api/auth/profile/image";
const image = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5n0AAAAASUVORK5CYII=",
	"base64",
);
const password = "SyntheticAvatarTest2026!";
const call = (path, method, token, body) =>
	fetch(origin + path, {
		method,
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			...(typeof body === "string"
				? { "Content-Type": "application/json" }
				: {}),
		},
		body,
	});
async function register() {
	const res = await call(
		"/api/auth/register",
		"POST",
		null,
		JSON.stringify({
			email: `avatar-${randomUUID()}@example.test`,
			name: "Avatar fixture",
			password,
		}),
	);
	assert.equal(res.status, 201);
	return (await res.json()).access_token;
}
const form = (bytes, type = "image/png", field = "image") => {
	const value = new FormData();
	value.append(field, new Blob([bytes], { type }), "../../fixture.png");
	return value;
};
const [token, peer] = await Promise.all([register(), register()]);
assert.equal((await call(picture, "POST", null, form(image))).status, 401);
assert.equal((await call(picture, "DELETE")).status, 401);
assert.equal(
	(await call(picture, "POST", token, form(image, "image/png", "wrong")))
		.status,
	400,
);
assert.equal(
	(await call(picture, "POST", token, form(Buffer.from("<html>")))).status,
	400,
);
assert.equal(
	(await call(picture, "POST", token, form(image, "image/jpeg"))).status,
	400,
);
assert.equal(
	(
		await call(
			picture,
			"POST",
			token,
			form(Buffer.concat([image, Buffer.alloc(5 * 1024 * 1024)])),
		)
	).status,
	400,
);
async function upload(type) {
	const res = await call(picture, "POST", token, form(image, type));
	assert.equal(res.status, 201, await res.clone().text());
	const { profileImage } = await res.json();
	assert.match(profileImage, /^\/uploads\/profiles\/[a-f0-9-]+\.png$/);
	const download = await call(profileImage, "GET");
	assert.equal(download.status, 200);
	assert.equal(download.headers.get("Content-Type"), "image/png");
	assert.equal(download.headers.get("X-Content-Type-Options"), "nosniff");
	assert.deepEqual(Buffer.from(await download.arrayBuffer()), image);
	return profileImage;
}
const inspect = (expression) =>
	JSON.parse(
		execFileSync(
			process.execPath,
			[
				`--env-file=${adminEnv}`,
				"node_modules/convex/bin/main.js",
				"run",
				"--inline-query",
				expression,
			],
			{
				cwd: new URL("../", import.meta.url),
				encoding: "utf8",
				timeout: 10000,
			},
		),
	);
const blobFor = (path) =>
	inspect(
		`return (await ctx.db.query("profileImages").withIndex("by_path", q => q.eq("path", ${JSON.stringify(path)})).unique()).storageId;`,
	);
const blobExists = (id) =>
	inspect(
		`return !!(await ctx.db.system.get("_storage", ${JSON.stringify(id)}));`,
	);
const before = await upload("application/octet-stream");
const old = blobFor(before);
const after = await upload();
assert.notEqual(before, after);
assert.equal((await call(before, "GET")).status, 404);
assert.equal(blobExists(old), false);
assert.equal(
	(await (await call("/api/auth/me", "GET", peer)).json()).profileImage,
	null,
);
assert.equal(
	(await (await call("/api/auth/me", "GET", token)).json()).profileImage,
	after,
);
const current = blobFor(after);
const removed = await call(picture, "DELETE", token);
assert.equal(removed.status, 200);
assert.equal((await removed.json()).profileImage, null);
assert.equal((await call(after, "GET")).status, 404);
assert.equal(blobExists(current), false);
assert.equal((await call(picture, "DELETE", token)).status, 200);
const last = await upload();
const lastBlob = blobFor(last);
assert.equal(
	(
		await call(
			"/api/auth/delete-account",
			"POST",
			token,
			JSON.stringify({ password }),
		)
	).status,
	200,
);
assert.equal((await call(last, "GET")).status, 404);
assert.equal(blobExists(lastBlob), false);
console.log(
	JSON.stringify({
		invalidUploadsRejected: true,
		imageBytesMatched: true,
		replacementAndRemovalPurgedStorage: true,
		deletionPurgedAvatar: true,
	}),
);
