import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { assertFixtureOrigin } from "./release-origin.mjs";

const origin = process.argv[2];
assertFixtureOrigin(origin, 3735, 3756);
const headers = (token) => (token ? { Authorization: "Bearer " + token } : {});
async function request(path, method, status, token, body) {
	const form = body instanceof FormData;
	const response = await fetch(origin + "/api/" + path, {
		method,
		headers: {
			...headers(token),
			...(form ? {} : { "Content-Type": "application/json" }),
		},
		body: form ? body : body === undefined ? undefined : JSON.stringify(body),
	});
	assert.equal(response.status, status, method + " " + path);
	return response.json();
}
const register = (name) =>
	request("auth/register", "POST", 201, null, {
		name,
		email: `attachments-${randomUUID()}@example.test`,
		password: "SyntheticWebAttachment2026!",
	});
const [owner, viewer] = await Promise.all([
	register("Owner"),
	register("Viewer"),
]);
const writer = owner.access_token;
const reader = viewer.access_token;
const { apiToken } = await request(
	"auth/api-token/regenerate",
	"POST",
	200,
	writer,
);
const note = await request("notes", "POST", 201, writer, {
	title: "Web attachment note",
});
const notePath = "notes/" + note.id;
const path = notePath + "/attachments";
await request(path, "GET", 401);
assert.deepEqual(await request(path, "GET", 200, writer), []);
const form = (bytes, mime = "audio/wav", name = "Mikrofon ä.wav") => {
	const data = new FormData();
	data.set("file", new Blob([bytes], { type: mime }), name);
	return data;
};
await request(path, "POST", 400, writer, new FormData());
await request(path, "POST", 400, writer, form(Buffer.alloc(0)));
await request(
	path,
	"POST",
	415,
	writer,
	form(Buffer.from("fixture"), "text/html"),
);
const big = Buffer.alloc(50 * 1024 * 1024, 0x37);
const duplicate = form(Buffer.from("first"));
duplicate.append(
	"file",
	new Blob(["second"], { type: "audio/wav" }),
	"second.wav",
);
await request(path, "POST", 400, writer, duplicate);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const uploaded = await request(path, "POST", 201, apiToken, form(big));
assert.equal(uploaded.fileSize, big.length);
assert.equal(uploaded.originalFilename, "Mikrofon ä.wav");
assert.equal(uploaded.uploadedByUserId, owner.user.id);
const other = await request(
	path,
	"POST",
	201,
	writer,
	form(Buffer.from("small attachment")),
);
const list = await request(path, "GET", 200, writer);
assert.deepEqual(
	list.map((file) => file.id),
	[other.id, uploaded.id],
);
await request(path + "/reorder", "PATCH", 400, writer, {
	orderedIds: [uploaded.id, uploaded.id],
});
const reordered = await request(path + "/reorder", "PATCH", 200, apiToken, {
	orderedIds: [uploaded.id, other.id],
});
assert.deepEqual(
	reordered.map((file) => [file.id, file.position]),
	[
		[uploaded.id, 0],
		[other.id, 1],
	],
);
const grant = await request(notePath + "/shares", "POST", 201, writer, {
	sharedWithUserId: viewer.user.id,
	permission: "viewer",
});
assert.equal((await request(path, "GET", 200, reader)).length, 2);
await request(path, "POST", 403, reader, form(Buffer.from("viewer write")));

const url = origin + "/api/" + path + "/" + uploaded.id;
const response = await fetch(url, { headers: headers(reader) });
assert.equal(response.status, 200);
assert.match(response.headers.get("content-disposition"), /^inline;/);
assert.equal(hash(Buffer.from(await response.arrayBuffer())), hash(big));
const range = await fetch(url, {
	headers: { ...headers(apiToken), Range: "bytes=7-12" },
});
assert.equal(range.status, 206);
assert.equal(range.headers.get("content-range"), `bytes 7-12/${big.length}`);
assert.deepEqual(Buffer.from(await range.arrayBuffer()), big.subarray(7, 13));
await request(notePath + "/shares/" + grant.id, "DELETE", 200, writer);
assert.equal((await fetch(url, { headers: headers(reader) })).status, 404);
await request(path, "POST", 413, writer, form(Buffer.alloc(big.length + 1)));
await request(path + "/" + uploaded.id, "DELETE", 200, apiToken);
assert.equal((await fetch(url, { headers: headers(writer) })).status, 404);
const compose = await request(
	"compose/attachments/list?noteId=" + note.id,
	"GET",
	200,
	writer,
);
assert.deepEqual(
	compose.map((file) => file.id),
	[other.id],
);
console.log(
	JSON.stringify({
		multipart50MiB: true,
		sha256: hash(big),
		range: true,
		viewerAndRevocation: true,
		order: true,
		composeReadback: true,
	}),
);
