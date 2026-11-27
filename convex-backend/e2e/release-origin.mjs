import assert from "node:assert/strict";

export function assertFixtureOrigin(origin, ...ports) {
	const releasePort = process.env.ANCHOR_CONVEX_WEB_PORT ?? "";
	if (
		process.env.ANCHOR_TEST_RELEASE_ARTIFACT &&
		/^[1-9][0-9]{0,4}$/.test(releasePort) &&
		Number(releasePort) <= 65535
	) {
		ports.push(Number(releasePort));
	}
	assert.ok(
		ports.some((port) => origin === `http://127.0.0.1:${port}`),
		"Expected a loopback fixture origin",
	);
}
