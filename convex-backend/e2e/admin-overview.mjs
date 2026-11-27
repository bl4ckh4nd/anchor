import assert from "node:assert/strict";

const origin = `http://127.0.0.1:${process.env.ANCHOR_CONVEX_SITE_PORT}`;
async function call(method, path, status, body, token) {
	const response = await fetch(origin + "/api/" + path, {
		method,
		headers: {
			"Content-Type": "application/json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	assert.equal(response.status, status, `${method} /${path}`);
	return response.status === 204 ? null : response.json();
}

const password = "AdminOverviewFixture2026";
const register = (name) => call("POST", "auth/register", 201, {
	name, email: `${name}@example.test`, password,
});
const admin = (await register("admin")).access_token;
const member = (await register("member")).access_token;
const createdInput = { name: " Added Member ", email: "added@example.test", password };

await call("POST", "admin/users", 401, createdInput);
await call("POST", "admin/users", 403, createdInput, member);
await call("GET", "admin/stats", 401);
await call("GET", "admin/stats", 403, undefined, member);
assert.deepEqual(await call("GET", "admin/stats", 200, undefined, admin), {
	totalUsers: 2, totalNotes: 0, totalTags: 0,
});
await call("PATCH", "admin/settings/registration", 200, { mode: "disabled" }, admin);
await call("POST", "auth/register", 403, createdInput);
await call("POST", "admin/users", 400, { ...createdInput, isAdmin: true }, admin);
const created = await call("POST", "admin/users", 201, createdInput, admin);
assert.equal(created.name, "Added Member");
assert.equal(created.isAdmin, false);
assert.equal(created.status, "active");
assert.equal(created.passwordHash, undefined);
await call("POST", "admin/users", 409, createdInput, admin);
const joined = await call("POST", "auth/login", 200, { email: createdInput.email, password });
assert.equal(joined.user.id, created.id);

const token = joined.access_token;
await call("POST", "notes", 201, { title: "Active" }, token);
const { id: trashed } = await call("POST", "notes", 201, { title: "Trashed" }, token);
await call("DELETE", "notes/" + trashed, 200, undefined, token);
const { id: deleted } = await call("POST", "notes", 201, { title: "Deleted" }, token);
await call("DELETE", "notes/" + deleted, 200, undefined, token);
await call("DELETE", "notes/" + deleted + "/permanent", 200, undefined, token);
await call("POST", "tags", 201, { name: "Active tag" }, token);
const { id: oldTag } = await call("POST", "tags", 201, { name: "Deleted tag" }, token);
await call("DELETE", "tags/" + oldTag, 200, undefined, token);
const stats = await call("GET", "admin/stats", 200, undefined, admin);
assert.deepEqual(stats, { totalUsers: 3, totalNotes: 2, totalTags: 1 });
console.log(JSON.stringify({ adminOnly: true, createdDuringClosedSignup: true, stats }, null, 2));
