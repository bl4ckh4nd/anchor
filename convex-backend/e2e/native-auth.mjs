import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const [origin, adminEnv] = process.argv.slice(2);
assert.equal(origin, "http://127.0.0.1:3709");
const profiles = JSON.parse(
	execFileSync(
		process.execPath,
		[
			`--env-file=${adminEnv}`,
			"node_modules/convex/bin/main.js",
			"run",
			"--inline-query",
			'return (await ctx.db.query("accounts").collect()).map(({id, email, name}) => ({id, email, name}));',
		],
		{ encoding: "utf8" },
	),
);
const [reader, owner, outsider] = ["Reader", "Owner", "Outsider"].map((name) =>
	profiles.find((profile) => profile.name === name),
);
const password = "native-auth-fixture-password";
const api = (path, body, token) =>
	fetch(origin + path, {
		method: body === undefined ? "GET" : "POST",
		headers: {
			...(body === undefined ? {} : { "Content-Type": "application/json" }),
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
const login = (email, candidate = password) =>
	api("/api/auth/login", { email, password: candidate });
const refresh = (refresh_token) => api("/api/auth/refresh", { refresh_token });

assert.equal((await login(reader.email, "wrong-password")).status, 401);
assert.equal((await login("unknown@example.test")).status, 401);
assert.equal((await login(owner.email)).status, 403);
assert.equal((await login(outsider.email)).status, 403);

const response = await login(reader.email);
assert.equal(response.status, 200);
assert.equal(response.headers.get("cache-control"), "no-store");
const session = await response.json();
assert.equal(session.user.id, reader.id);
assert.equal(session.user.hasPassword, true);
assert.equal(session.user.passwordHash, undefined);
const me = await api("/api/auth/me", undefined, session.access_token);
assert.equal(me.status, 200);
assert.deepEqual(await me.json(), session.user);

const exchange = await api("/api/auth/convex-token", {}, session.access_token);
assert.equal(exchange.status, 200);
assert.equal((await exchange.json()).token, session.access_token);
const note = { id: randomUUID(), title: "Native session note" };
assert.equal(
	(await api("/api/compose/notes", note, session.access_token)).status,
	200,
);

const retries = await Promise.all(
	Array.from({ length: 4 }, () => refresh(session.refresh_token)),
);
assert.ok(retries.every((retry) => retry.status === 200));
const rotated = await Promise.all(retries.map((retry) => retry.json()));
assert.notEqual(rotated[0].refresh_token, session.refresh_token);
assert.ok(
	rotated.every((pair) => pair.refresh_token === rotated[0].refresh_token),
);
const directNote = (token) =>
	fetch("http://127.0.0.1:3708/api/query", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({ path: "notes:get", args: { id: note.id } }),
	});
assert.equal(
	(await (await directNote(rotated[0].access_token)).json()).value.id,
	note.id,
);
const digests = execFileSync(
	process.execPath,
	[
		`--env-file=${adminEnv}`,
		"node_modules/convex/bin/main.js",
		"run",
		"--inline-query",
		'return (await ctx.db.query("refreshTokens").collect()).map(({digest, successor}) => [digest, successor ?? null]);',
	],
	{ encoding: "utf8" },
);
assert.ok(
	!digests.includes(session.refresh_token) &&
		!digests.includes(rotated[0].refresh_token),
);

const other = await (await login(reader.email)).json();
assert.equal(
	(await api("/api/auth/logout", { refreshToken: session.refresh_token }))
		.status,
	200,
);
for (const retired of [session, rotated[0]]) {
	assert.equal((await refresh(retired.refresh_token)).status, 401);
	assert.equal(
		(await api("/api/auth/me", undefined, retired.access_token)).status,
		401,
	);
	assert.equal(
		(await api("/api/compose/sync", {}, retired.access_token)).status,
		401,
	);
	assert.equal(
		(await (await directNote(retired.access_token)).json()).status,
		"error",
	);
}
assert.equal(
	(await api("/api/auth/me", undefined, other.access_token)).status,
	200,
);
assert.equal(
	(await api("/api/auth/logout", { refreshToken: other.refresh_token })).status,
	200,
);
assert.equal((await login(reader.email, "x".repeat(9_000))).status, 400);
let limited = false;
for (let index = 0; index < 13; index++) {
	const response = await login(outsider.email, "wrong-password");
	if (response.status === 429) {
		limited = true;
		break;
	}
	assert.equal(response.status, 401);
}
assert.ok(limited);
console.log(
	JSON.stringify({
		password: true,
		protectedAccountsDenied: true,
		composeNote: true,
		parallelRefreshes: retries.length,
		revokedAccessAndRefresh: true,
		independentSession: true,
		accessDeniedOnDirectQuery: true,
		rateLimited: true,
	}),
);
