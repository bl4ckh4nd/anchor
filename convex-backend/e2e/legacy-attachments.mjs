import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { setTimeout } from "node:timers/promises";

const [legacy, convex, convexApi, stagingDirectory] = process.argv.slice(2);
for (const origin of [legacy, convex, convexApi])
	assert.match(origin ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
const max = 50 * 1024 * 1024;

function headers(token) {
	return token ? { authorization: `Bearer ${token}` } : {};
}
async function json(origin, path, method, token, body, expected = 200) {
	const response = await fetch(origin + path, {
		method,
		headers: {
			...headers(token),
			...(body === undefined ? {} : { "content-type": "application/json" }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	assert.equal(response.status, expected, `${method} ${path}`);
	return response.json();
}
async function account() {
	const email = `attachment-${randomUUID()}@example.test`;
	const password = randomUUID();
	const info = await json(
		legacy,
		"/api/auth/register",
		"POST",
		null,
		{ name: "Attachment fixture", email, password },
		201,
	);
	const session = await json(legacy, "/api/auth/login", "POST", null, {
		email,
		password,
	});
	const access = session.access_token;
	const { token } = await json(
		legacy,
		"/api/auth/convex-token",
		"POST",
		access,
		undefined,
	);
	return { id: info.user.id, access, token };
}
const owner = await account();
const reader = await account();
const { apiToken } = await json(
	legacy,
	"/api/auth/api-token/regenerate",
	"POST",
	owner.access,
	undefined,
);
assert.ok(apiToken);
const noteId = randomUUID();
await json(convex, "/api/compose/notes", "POST", owner.token, {
	id: noteId,
	title: "Legacy multipart fixture",
});
const path = `/api/notes/${noteId}/attachments`;
assert.deepEqual(await json(legacy, path, "GET", owner.access), []);

if (stagingDirectory) {
	assert.deepEqual(await readdir(stagingDirectory), []);
	const boundary = "anchor-" + randomUUID();
	const aborted = httpRequest(new URL(path, legacy), {
		method: "POST",
		headers: {
			...headers(owner.access),
			"content-type": `multipart/form-data; boundary=${boundary}`,
			"content-length": max,
		},
	});
	aborted.on("error", () => {});
	aborted.write(
		`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="aborted.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
	);
	aborted.write(Buffer.alloc(512 * 1024, 98));
	try {
		for (
			let attempt = 0;
			attempt < 30 && !(await readdir(stagingDirectory)).length;
			attempt++
		) {
			await setTimeout(50);
		}
		assert.equal((await readdir(stagingDirectory)).length, 1);
	} finally {
		aborted.destroy();
	}
	for (
		let attempt = 0;
		attempt < 30 && (await readdir(stagingDirectory)).length;
		attempt++
	) {
		await setTimeout(50);
	}
	assert.deepEqual(await readdir(stagingDirectory), []);
	assert.deepEqual(await json(legacy, path, "GET", owner.access), []);
	console.log(
		"Passed: an interrupted multipart request left no staged file or attachment.",
	);
}

function multipart(bytes, filename = "Aufnahme ä.wav", type = "audio/wav") {
	const data = new FormData();
	data.append("file", new Blob([bytes], { type }), filename);
	return data;
}
async function upload(bytes, token = owner.access, filename, type) {
	return fetch(legacy + path, {
		method: "POST",
		headers: headers(token),
		body: multipart(bytes, filename, type),
	});
}
assert.equal((await upload(Buffer.from("sample"), null)).status, 401);
assert.equal((await upload(Buffer.from("sample"), reader.access)).status, 404);
assert.equal(
	(
		await upload(
			Buffer.from("sample"),
			owner.access,
			"not-audio.txt",
			"text/plain",
		)
	).status,
	400,
);
assert.equal((await upload(Buffer.alloc(max + 1))).status, 413);
const bytes = Buffer.alloc(max, 71);
const response = await upload(bytes, apiToken);
assert.equal(response.status, 201, await response.clone().text());
const first = await response.json();
assert.equal(first.originalFilename, "Aufnahme ä.wav");
assert.equal(first.fileSize, max);
assert.equal(first.position, 0);
assert.equal(first.uploadedByUserId, owner.id);
assert.equal(first.storageId, undefined);

const additional = await upload(
	Buffer.from("second"),
	owner.access,
	"second.wav",
);
assert.equal(additional.status, 201, await additional.clone().text());
const second = await additional.json();
const listed = await json(legacy, path, "GET", owner.access);
assert.deepEqual(
	listed.map(({ id, position }) => [id, position]),
	[
		[second.id, 0],
		[first.id, 1],
	],
);
const reorder = await json(legacy, path + "/reorder", "PATCH", owner.access, {
	orderedIds: [first.id, second.id],
});
const syncPage = await json(
	convex,
	"/api/compose/sync",
	"POST",
	owner.token,
	{},
);
const syncedNote = syncPage.entries.find(
	(entry) => entry.entityId === noteId,
)?.note;
assert.deepEqual(
	syncedNote?.attachments.map(({ id }) => id),
	[first.id, second.id],
);
assert.deepEqual(
	reorder.map(({ id, position }) => [id, position]),
	[
		[first.id, 0],
		[second.id, 1],
	],
);
assert.equal(
	(
		await fetch(legacy + path + "/reorder", {
			method: "PATCH",
			headers: { ...headers(owner.access), "content-type": "application/json" },
			body: JSON.stringify({ orderedIds: [first.id, first.id] }),
		})
	).status,
	400,
);

async function share(permission) {
	const result = await json(convexApi, "/api/mutation", "POST", owner.token, {
		path: "notes:setShare",
		args: { id: noteId, subject: reader.id, permission },
	});
	assert.equal(result.status, "success");
}
await share("viewer");
assert.equal(
	(
		await fetch(legacy + path + "/reorder", {
			method: "PATCH",
			headers: {
				...headers(reader.access),
				"content-type": "application/json",
			},
			body: JSON.stringify({ orderedIds: [second.id, first.id] }),
		})
	).status,
	404,
);
assert.deepEqual(
	(await json(legacy, path, "GET", reader.access)).map(({ id }) => id),
	[first.id, second.id],
);
const blobPath = path + "/" + first.id;
assert.equal((await upload(Buffer.from("viewer"), reader.access)).status, 404);
const partial = await fetch(legacy + blobPath, {
	headers: { ...headers(reader.access), range: "bytes=8-11" },
});
assert.equal(partial.status, 206);
assert.equal(partial.headers.get("content-range"), `bytes 8-11/${max}`);
assert.deepEqual(
	Buffer.from(await partial.arrayBuffer()),
	bytes.subarray(8, 12),
);
const received = await fetch(legacy + blobPath, {
	headers: headers(reader.access),
});
assert.equal(received.status, 200);
assert.equal(received.headers.get("cache-control"), "private, no-store");
assert.equal(received.headers.get("content-type"), "audio/wav");
const digest = createHash("sha256");
for await (const chunk of received.body) digest.update(chunk);
const sha256 = createHash("sha256").update(bytes).digest("hex");
assert.equal(digest.digest("hex"), sha256);
await share(null);
assert.equal(
	(await fetch(legacy + blobPath, { headers: headers(reader.access) })).status,
	404,
);
assert.deepEqual(await json(legacy, blobPath, "DELETE", apiToken), {
	success: true,
});
assert.equal(
	(await fetch(legacy + blobPath, { headers: headers(owner.access) })).status,
	404,
);
if (stagingDirectory) assert.deepEqual(await readdir(stagingDirectory), []);
console.log(
	JSON.stringify({
		noteId,
		attachmentId: first.id,
		fileSize: max,
		sha256,
		apiTokenUpload: true,
		revokedDownload: 404,
	}),
);
console.log(
	"Passed: legacy multipart limit, Convex readback, attachment ordering, access revocation and deletion.",
);
