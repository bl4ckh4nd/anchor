import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const [origin, database, userId] = process.argv.slice(2);
assert.equal(origin, "http://127.0.0.1:3731");
assert.match(database, /^anchor_bundle_fixture_[a-f0-9]+$/);
assert.match(userId, /^[a-f0-9-]{36}$/);
const read = execFileSync(
	"podman",
	[
		"exec",
		"anchor-bundle-source",
		"psql",
		"-U",
		"postgres",
		"-d",
		database,
		"-X",
		"-A",
		"-t",
		"-c",
		`select json_build_object('token', u."apiToken", 'note', n.id) from "User" u join "Note" n on n."userId" = u.id where u.id = '${userId}' order by n.id limit 1`,
	],
	{ encoding: "utf8", timeout: 10000 },
);
const { token, note } = JSON.parse(read);
assert.match(token, /^[a-f0-9]+$/);
assert.equal(token.length, 32); // The original PostgreSQL fixture intentionally uses a shorter token.
const response = await fetch(
	origin + "/api/notes/" + encodeURIComponent(note),
	{
		headers: { Authorization: `Bearer ${token}` },
	},
);
assert.equal(response.status, 200);
const detail = await response.json();
assert.equal(detail.id, note);
assert.equal(detail.userId, userId);
assert.equal(detail.permission, "owner");
console.log(
	JSON.stringify({
		legacyPostgresTokenAccepted: true,
		importedOwnerPreserved: true,
		importedNoteId: note,
	}),
);
