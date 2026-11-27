import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const origin = process.argv[2];
assert.ok(
	origin,
	"Usage: node e2e/account-profile.mjs <isolated-signup-origin>",
);

function request(path, method, body, token) {
	return fetch(new URL("/api/auth/" + path, origin), {
		method,
		body: body === undefined ? undefined : JSON.stringify(body),
		headers: {
			"Content-Type": "application/json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
	});
}

const email = `profile-${randomUUID()}@example.test`;
const password = "ProfileFixture2026!";
const created = await request("register", "POST", {
	email,
	password,
	name: "Before",
});
assert.equal(created.status, 201);
const {
	user,
	access_token: access,
	refresh_token: refresh,
} = await created.json();
assert.ok(
	user?.id && access && refresh,
	"Fixture must issue a password session",
);

const update = (body, token = access) =>
	request("profile", "PATCH", body, token);
const change = (currentPassword, newPassword, token = access) =>
	request("change-password", "POST", { currentPassword, newPassword }, token);
assert.equal((await update({ name: "Denied" }, null)).status, 401);
assert.equal((await change(password, "Unavailable123!", null)).status, 401);
assert.equal((await update({ name: 5 })).status, 400);

const renamed = await update({
	name: "  After  ",
	isAdmin: true,
	email: "wrong@example.test",
});
assert.equal(renamed.status, 200);
const profile = await renamed.json();
assert.equal(profile.id, user.id);
assert.equal(profile.name, "After");
assert.equal(profile.email, email);
assert.equal(profile.isAdmin, false);
assert.ok(!("passwordHash" in profile));
assert.deepEqual(
	await (await request("me", "GET", undefined, access)).json(),
	profile,
);

assert.equal((await change("wrong", "Unavailable123!")).status, 403);
assert.equal((await change(password, password)).status, 400);
assert.equal((await change(password, "ä".repeat(37))).status, 400);
const alternatives = ["ProfileChanged2026!", "ProfileAlternate2026!"];
const results = await Promise.all(
	alternatives.map((next) => change(password, next)),
);
assert.equal(results.filter(({ status }) => status === 200).length, 1);
const winner = results.findIndex(({ status }) => status === 200);
assert.deepEqual(await results[winner].json(), {
	message: "Password changed successfully",
});
assert.ok([403, 409].includes(results[1 - winner].status));
assert.equal((await request("login", "POST", { email, password })).status, 401);
assert.equal(
	(await request("login", "POST", { email, password: alternatives[winner] }))
		.status,
	200,
);
assert.equal((await request("me", "GET", undefined, access)).status, 200);

assert.equal(
	(await request("logout", "POST", { refreshToken: refresh })).status,
	200,
);
assert.equal((await update({ name: "Revoked" })).status, 401);
assert.equal(
	(await change(alternatives[winner], "RevokedChange123!")).status,
	401,
);
console.log(
	"Profile, password change, concurrent update and revoked-session checks passed.",
);
