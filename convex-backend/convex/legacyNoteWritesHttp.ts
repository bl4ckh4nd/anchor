import { Schema } from "effect";
import type { FunctionArgs } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { legacyReadCredential, noteSharesRequest } from "./apiTokenHttp";
import { legacyAttachmentRequest } from "./attachments";
import { outboxScopeChanged, reminderWallClock } from "./notes";
import { reminderRecurrences } from "./schema";
import { reply } from "./sessionHttp";
import { authorizedIdentity } from "./sessions";

const uuid = Schema.String.check(
	Schema.isPattern(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i),
);
const stringOrNull = Schema.NullOr(Schema.String);
const fields = {
	content: Schema.optionalKey(stringOrNull),
	background: Schema.optionalKey(stringOrNull),
	isPinned: Schema.optionalKey(Schema.Boolean),
	isArchived: Schema.optionalKey(Schema.Boolean),
	tagIds: Schema.optionalKey(Schema.Array(Schema.String)),
	reminder: Schema.optionalKey(
		Schema.NullOr(
			Schema.Struct({
				remindAt: Schema.String.check(Schema.isPattern(reminderWallClock)),
				recurrence: Schema.optionalKey(Schema.Literals(reminderRecurrences)),
			}),
		),
	),
};
const decodeCreate = Schema.decodeUnknownSync(
	Schema.Struct({
		...fields,
		id: Schema.optionalKey(uuid),
		title: Schema.String,
	}),
);
const decodePatch = Schema.decodeUnknownSync(
	Schema.Struct({
		...fields,
		title: Schema.optionalKey(Schema.String),
		baseVersion: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
		replacesOtherEdit: Schema.optionalKey(Schema.Boolean),
		tagAssignment: Schema.optionalKey(
			Schema.Struct({
				id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
				assigned: Schema.Boolean,
			}),
		),
	}),
);

async function readBody<T>(request: Request, decode: (input: unknown) => T) {
	try {
		return decode(await request.json());
	} catch {
		return null;
	}
}

export const createNote = httpAction(async (ctx, request) => {
	const credentials = await legacyReadCredential(request);
	if (!credentials.apiTokenHash) return reply({ code: "UNAUTHENTICATED" }, 401);
	const input = await readBody(request, decodeCreate);
	if (!input) return reply({ code: "INVALID_NOTE" }, 400);
	const result = await ctx.runMutation(internal.notes.legacyCreate, {
		...input,
		id: input.id ?? crypto.randomUUID(),
		tagIds: input.tagIds && [...input.tagIds],
		...credentials,
	});
	return reply(result.body, result.status);
});

export const writeNote = httpAction(async (ctx, request) => {
	const url = new URL(request.url);
	const [encodedId, suffix, ...rest] = url.pathname
		.slice("/api/notes/".length)
		.split("/");
	let id: string;
	try {
		id = decodeURIComponent(encodedId);
	} catch {
		return reply({ code: "NOTE_NOT_FOUND" }, 404);
	}
	if (!id || id.length > 128 || id.includes("/"))
		return reply({ code: "NOTE_NOT_FOUND" }, 404);
	if ((suffix === "shares" || suffix === "attachments") && rest.length === 1) {
		const code =
			suffix === "shares" ? "SHARE_NOT_FOUND" : "ATTACHMENT_NOT_FOUND";
		let resourceId: string;
		try {
			resourceId = decodeURIComponent(rest[0]);
		} catch {
			return reply({ code }, 404);
		}
		if (!resourceId || resourceId.length > 128 || resourceId.includes("/"))
			return reply({ code }, 404);
		if (suffix === "attachments") {
			const { apiTokenHash } = await legacyReadCredential(request);
			return legacyAttachmentRequest(
				ctx,
				request,
				id,
				apiTokenHash,
				resourceId,
			);
		}
		return noteSharesRequest(ctx, request, id, resourceId);
	}
	if (rest.length) return reply({ code: "NOTE_NOT_FOUND" }, 404);
	const credentials = await legacyReadCredential(request);
	if (!credentials.apiTokenHash) return reply({ code: "UNAUTHENTICATED" }, 401);
	if (request.method === "PATCH" && suffix === undefined) {
		if (request.headers.has("X-Anchor-Outbox-Scope")) {
			if (!(await authorizedIdentity(ctx)))
				return reply({ code: "UNAUTHENTICATED" }, 401);
			if (await outboxScopeChanged(ctx, request))
				return reply({ code: "OUTBOX_SCOPE_CHANGED" }, 409);
		}
		const input = await readBody(request, decodePatch);
		if (!input || (input.tagAssignment && input.tagIds !== undefined))
			return reply({ code: "INVALID_NOTE" }, 400);
		const result = await ctx.runMutation(internal.notes.legacyPatch, {
			...input,
			tagIds: input.tagIds && [...input.tagIds],
			id,
			...credentials,
		});
		return reply(result.body, result.status);
	}
	const action =
		request.method === "PATCH"
			? suffix === "restore"
				? "restore"
				: null
			: suffix === undefined
				? "trash"
				: suffix === "permanent"
					? "permanent"
					: null;
	if (!action) return reply({ code: "NOTE_NOT_FOUND" }, 404);
	const trashedAt =
		action === "trash"
			? Date.parse(url.searchParams.get("trashedAt") ?? "")
			: NaN;
	const result = await ctx.runMutation(internal.notes.legacyChangeState, {
		id,
		action,
		trashedAt: Number.isFinite(trashedAt) ? trashedAt : undefined,
		...credentials,
	});
	return reply(result.body, result.status);
});

const idString = Schema.String.check(Schema.isMinLength(1));
const noteIdsField = Schema.Array(idString).check(Schema.isMaxLength(200));
const decodeSelection = Schema.decodeUnknownSync(
	Schema.Struct({ noteIds: noteIdsField }),
);
const decodePinSelection = Schema.decodeUnknownSync(
	Schema.Struct({
		noteIds: noteIdsField,
		isPinned: Schema.Boolean,
	}),
);
const decodeTagSelection = Schema.decodeUnknownSync(
	Schema.Struct({
		noteIds: noteIdsField,
		tagIds: Schema.Array(idString).check(Schema.isMaxLength(50)),
	}),
);

export const bulkNotes = httpAction(async (ctx, request) => {
	const action = new URL(request.url).pathname.slice("/api/notes/bulk/".length);
	const credential = await legacyReadCredential(request);
	if (!credential.apiTokenHash) return reply({ code: "UNAUTHENTICATED" }, 401);
	let change: FunctionArgs<typeof internal.notes.legacyBulkNotes>["change"];
	let selection: readonly string[];
	if (action === "pin") {
		const input = await readBody(request, decodePinSelection);
		if (!input) return reply({ code: "INVALID_NOTE_SELECTION" }, 400);
		selection = input.noteIds;
		change = { action, isPinned: input.isPinned };
	} else if (action === "tags") {
		const input = await readBody(request, decodeTagSelection);
		if (!input) return reply({ code: "INVALID_NOTE_SELECTION" }, 400);
		selection = input.noteIds;
		change = { action, tagIds: [...input.tagIds] };
	} else if (action === "archive" || action === "delete") {
		const input = await readBody(request, decodeSelection);
		if (!input) return reply({ code: "INVALID_NOTE_SELECTION" }, 400);
		selection = input.noteIds;
		change = { action };
	} else {
		return reply({ code: "NOT_FOUND" }, 404);
	}
	const ids = [...new Set(selection)];
	let count = 0;
	// Each Convex transaction loads full note documents, including their bodies.
	const batchSize = 8;
	for (let index = 0; index < Math.max(1, ids.length); index += batchSize) {
		const result = await ctx.runMutation(internal.notes.legacyBulkNotes, {
			...credential,
			change,
			noteIds: ids.slice(index, index + batchSize),
		});
		if (!result) return reply({ code: "UNAUTHENTICATED" }, 401);
		count += result.count;
	}
	return reply({ count }, 201);
});
