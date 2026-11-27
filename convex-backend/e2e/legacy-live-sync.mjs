import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertFixtureOrigin } from "./release-origin.mjs";

const origin = process.argv[2];
assertFixtureOrigin(origin, 3735, 3757);
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
const register = () =>
	request("auth/register", "POST", 201, null, {
		name: "Live sync fixture",
		email: `sse-${randomUUID()}@example.test`,
		password: "SyntheticLiveSync2026!",
	});
const url = origin + "/api/sync/events";
assert.equal((await fetch(url)).status, 401);

const [owner, stranger] = await Promise.all([register(), register()]);
const active = [];
async function open(token) {
	const controller = new AbortController();
	active.push(controller);
	const response = await fetch(url, {
		headers: { Authorization: "Bearer " + token, Accept: "text/event-stream" },
		signal: controller.signal,
	});
	assert.equal(response.status, 200);
	assert.match(response.headers.get("content-type"), /^text\/event-stream/);
	assert.equal(response.headers.get("x-accel-buffering"), "no");
	assert.match(response.headers.get("cache-control"), /no-store/);
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const next = async () => {
		while (!buffer.includes("\n\n")) {
			const { value, done } = await reader.read();
			assert.equal(done, false, "Unexpected end of SSE stream");
			buffer += decoder.decode(value, { stream: true });
		}
		const end = buffer.indexOf("\n\n");
		const event = buffer.slice(0, end);
		buffer = buffer.slice(end + 2);
		return event;
	};
	return { next, close: () => controller.abort() };
}
function withDeadline(promise, ms) {
	let timer;
	return Promise.race([
		promise,
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error("SSE deadline exceeded")), ms);
		}),
	]).finally(() => clearTimeout(timer));
}
const frame = (stream, kind, ms) =>
	withDeadline(
		(async () => {
			for (;;) {
				const event = await stream.next();
				if (event.startsWith("event: " + kind + "\n")) return event;
			}
		})(),
		ms,
	);
const timeout = setTimeout(
	() => active.forEach((controller) => controller.abort()),
	140_000,
);
try {
	const stream = await withDeadline(open(owner.access_token), 5000);
	const unrelated = await withDeadline(open(stranger.access_token), 5000);
	await withDeadline(Promise.all([stream.next(), unrelated.next()]), 5000);
	const nextOwnerEvent = frame(stream, "sync", 7000);
	const note = await request("notes", "POST", 201, owner.access_token, {
		title: "Changed while connected",
	});
	const event = await nextOwnerEvent;
	assert.deepEqual(JSON.parse(event.split("\ndata: ")[1]), { seq: "1" });
	const reader = await request(
		"notes/" + note.id,
		"GET",
		200,
		owner.access_token,
	);
	assert.equal(reader.title, note.title);

	const firstOutsideFrame = await withDeadline(unrelated.next(), 30_000);
	assert.match(firstOutsideFrame, /^event: ping\n/);
	unrelated.close();

	stream.close();
	const reconnected = await withDeadline(open(owner.access_token), 5000);
	await withDeadline(reconnected.next(), 5000);
	const resumed = frame(reconnected, "sync", 7000);
	await request("notes/" + note.id, "PATCH", 200, owner.access_token, {
		title: "Changed after a reconnect",
	});
	assert.deepEqual(JSON.parse((await resumed).split("\ndata: ")[1]), {
		seq: "2",
	});
	const logout = await fetch(origin + "/api/auth/logout", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ refreshToken: owner.refresh_token }),
	});
	assert.equal(logout.status, 200);
	assert.match(
		await frame(reconnected, "reconnect", 7000),
		/^event: reconnect\n/,
	);
	assert.equal(
		(
			await fetch(url, {
				headers: { Authorization: "Bearer " + owner.access_token },
			})
		).status,
		401,
	);
	const capped = [];
	for (let i = 0; i < 9; i++) {
		const candidate = await withDeadline(open(stranger.access_token), 5000);
		await withDeadline(candidate.next(), 5000);
		capped.push(candidate);
	}
	assert.match(
		await frame(capped[0], "reconnect", 7000),
		/^event: reconnect\n/,
	);
	for (const candidate of capped) candidate.close();
	console.log(
		JSON.stringify({
			incremental: true,
			isolated: true,
			heartbeat: true,
			reconnect: true,
			revoked: true,
			connectionCap: true,
		}),
	);
} finally {
	clearTimeout(timeout);
	active.forEach((controller) => controller.abort());
}
