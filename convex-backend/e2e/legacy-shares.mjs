import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const origin = process.argv[2];
assert.match(origin ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
async function request(path, method, status, token, body) {
	const response = await fetch(origin + "/api/" + path, {
		method,
		headers: {
			...(token ? { Authorization: "Bearer " + token } : {}),
			"Content-Type": "application/json",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	assert.equal(response.status, status, method + " " + path);
	return response.json();
}
const marker = randomUUID().slice(0, 10);
const register = (name) =>
	request("auth/register", "POST", 201, null, {
		name: name + " " + marker,
		email: `${name}-${marker}@example.test`,
		password: "SyntheticShareNotes2026!",
	});
const [owner, recipient, outsider] = await Promise.all([
	register("Owner"),
	register("Reader"),
	register("Outsider"),
]);
const writer = owner.access_token;
const reader = recipient.access_token;
const { apiToken } = await request(
	"auth/api-token/regenerate",
	"POST",
	200,
	writer,
);
await request("users/search?q=" + marker, "GET", 401);
const found = await request(
	"users/search?q=" + marker.toUpperCase(),
	"GET",
	200,
	apiToken,
);
assert.deepEqual(
	found.map((user) => user.id),
	[outsider.user.id, recipient.user.id],
);
assert.ok(
	found.every(
		(user) =>
			Object.keys(user).sort().join(",") === "email,id,name,profileImage",
	),
);
assert.deepEqual(
	await request("users/recent-contacts", "GET", 200, writer),
	[],
);
const note = await request("notes", "POST", 201, writer, {
	title: "Share fixture",
});
const other = await request("notes", "POST", 201, writer, {
	title: "Other note",
});
const path = "notes/" + note.id;
const shares = path + "/shares";
const share = (user, permission, status = 201) =>
	request(shares, "POST", status, apiToken, {
		sharedWithUserId: user,
		permission,
	});
assert.deepEqual(await request(shares, "GET", 200, writer), []);
await request(shares, "GET", 403, reader);
await share(owner.user.id, "viewer", 400);
await share(randomUUID(), "viewer", 404);
const granted = await share(recipient.user.id, "viewer");
assert.equal(granted.sharedWithUser.id, recipient.user.id);
assert.equal(granted.permission, "viewer");
assert.deepEqual(await request(shares, "GET", 200, writer), [granted]);
assert.deepEqual((await request(path, "GET", 200, writer)).shareIds, [
	granted.id,
]);
assert.equal(
	(await request(path, "GET", 200, reader)).sharedBy.id,
	owner.user.id,
);
await request(path, "PATCH", 403, reader, { title: "Denied" });
await request(
	"notes/" + other.id + "/shares/" + granted.id,
	"PATCH",
	404,
	writer,
	{ permission: "editor" },
);
const updated = await request(
	shares + "/" + granted.id,
	"PATCH",
	200,
	apiToken,
	{ permission: "editor" },
);
assert.equal(updated.id, granted.id);
assert.equal(updated.permission, "editor");
assert.equal(
	(
		await request(path, "PATCH", 200, reader, {
			title: "Shared edit",
			isArchived: true,
		})
	).title,
	"Shared edit",
);

const pull = (cursor) =>
	request("compose/sync", "POST", 200, reader, { cursor });
let page = await pull();
while (page.hasMore) page = await pull(page.nextCursor);
await request(shares + "/" + granted.id, "DELETE", 200, writer);
await request(path, "GET", 404, reader);
assert.deepEqual(await request(shares, "GET", 200, writer), []);
assert.deepEqual((await request(path, "GET", 200, writer)).shareIds, []);
const delta = await pull(page.nextCursor);
assert.deepEqual(
	delta.entries.map(({ entityId, op }) => [entityId, op]),
	[[note.id, "remove"]],
);
assert.deepEqual(
	(await request("users/recent-contacts", "GET", 200, writer)).map(
		(user) => user.id,
	),
	[recipient.user.id],
);
const regranted = await share(recipient.user.id, "viewer");
assert.equal(regranted.id, granted.id);
assert.equal(regranted.createdAt, granted.createdAt);
assert.equal((await request(path, "GET", 200, reader)).isArchived, false);
console.log(
	JSON.stringify({
		contactPrivacy: true,
		ownerOnly: true,
		stableShareId: true,
		editorAccess: true,
		composeRevocation: true,
	}),
);
