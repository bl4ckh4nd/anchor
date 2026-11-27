import { Schema } from "effect";
import {
	IMPORT_ALLOWED_BACKGROUNDS,
	IMPORT_MAX_CONTENT_LENGTH,
	IMPORT_MAX_NOTES_PER_BATCH,
	IMPORT_MAX_TAG_NAME_LENGTH,
	IMPORT_MAX_TAGS_PER_BATCH,
	IMPORT_MAX_TAGS_PER_NOTE,
	IMPORT_MAX_TITLE_LENGTH,
} from "../../server/src/import-export/constants/import.constants";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { legacyReadCredential } from "./apiTokenHttp";
import { legacyAttachmentRequest } from "./attachments";
import { reminderWallClock } from "./notes";
import { reminderRecurrences } from "./schema";
import { input, reply } from "./sessionHttp";

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const tagName = Schema.String.check(
	Schema.isMaxLength(IMPORT_MAX_TAG_NAME_LENGTH),
);
const date = Schema.String.check(
	Schema.isPattern(/^\d{4}-\d{2}-\d{2}(?:T.+)?$/),
);
const optional = <T extends Schema.Top>(value: T) =>
	Schema.optionalKey(Schema.NullOr(value));
const note = Schema.Struct({
	ref: Schema.String.check(Schema.isBetweenLength(1, 256)),
	id: optional(Schema.String.check(Schema.isPattern(uuid))),
	title: Schema.String.check(Schema.isMaxLength(IMPORT_MAX_TITLE_LENGTH)),
	content: optional(
		Schema.String.check(Schema.isMaxLength(IMPORT_MAX_CONTENT_LENGTH)),
	),
	isPinned: optional(Schema.Boolean),
	isArchived: optional(Schema.Boolean),
	isTrashed: optional(Schema.Boolean),
	background: optional(Schema.String.check(Schema.isMaxLength(64))),
	tagNames: optional(
		Schema.Array(tagName).check(Schema.isMaxLength(IMPORT_MAX_TAGS_PER_NOTE)),
	),
	createdAt: optional(date),
	updatedAt: optional(date),
	reminder: optional(
		Schema.Struct({
			remindAt: Schema.String.check(Schema.isPattern(reminderWallClock)),
			recurrence: optional(Schema.Literals(reminderRecurrences)),
		}),
	),
});
const importInput = Schema.Struct({
	notes: Schema.Array(note).check(
		Schema.isMinLength(1),
		Schema.isMaxLength(IMPORT_MAX_NOTES_PER_BATCH),
	),
	tags: optional(
		Schema.Array(
			Schema.Struct({
				name: tagName.check(Schema.isMinLength(1)),
				color: optional(Schema.String.check(Schema.isMaxLength(32))),
			}),
		).check(Schema.isMaxLength(IMPORT_MAX_TAGS_PER_BATCH)),
	),
	skipExisting: optional(Schema.Boolean),
});

function prepare(item: typeof note.Type) {
	const warnings = [];
	let content: string | undefined;
	if (item.content) {
		try {
			if (Array.isArray(JSON.parse(item.content)?.ops)) content = item.content;
		} catch {
			// Invalid Delta content is reported with the imported note.
		}
		if (content === undefined)
			warnings.push("Content was not valid note data and was dropped");
	}
	const background =
		item.background && IMPORT_ALLOWED_BACKGROUNDS.has(item.background)
			? item.background
			: undefined;
	if (item.background && !background)
		warnings.push(`Unknown background "${item.background}" was ignored`);
	return { content, background, warning: warnings.join("; ") };
}

const seconds = (date: string | null | undefined) =>
	date == null ? undefined : Math.floor(Date.parse(date) / 1000) * 1000;

export const importNotes = httpAction(async (ctx, request) => {
	const { apiTokenHash } = await legacyReadCredential(request);
	if (!apiTokenHash) return reply({ code: "UNAUTHENTICATED" }, 401);
	const body = await input(request, importInput, false, 16 * 1024 * 1024);
	if (
		!body ||
		body.notes.some((item) =>
			[seconds(item.createdAt), seconds(item.updatedAt)].some(Number.isNaN),
		)
	)
		return reply({ code: "INVALID_REQUEST" }, 400);

	const palette = body.tags ?? [];
	const colors = new Map(
		palette.filter((tag) => tag.color).map((tag) => [tag.name, tag.color!]),
	);
	const names = [
		...new Set([
			...body.notes.flatMap((item) => item.tagNames ?? []),
			...palette.map((tag) => tag.name),
		]),
	];
	const ids = new Map<string, string>();
	let created = 0;
	for (let index = 0; index < Math.max(1, names.length); index += 32) {
		const tags = await ctx.runMutation(internal.notes.importTagPalette, {
			apiTokenHash,
			tags: names.slice(index, index + 32).map((name) => ({
				id: crypto.randomUUID(),
				name,
				color: colors.get(name),
			})),
		});
		if (!tags) return reply({ code: "UNAUTHENTICATED" }, 401);
		for (const tag of tags) {
			ids.set(tag.name, tag.id);
			if (tag.created) created++;
		}
	}

	const results = [];
	for (const item of body.notes) {
		const data = prepare(item);
		let result;
		try {
			result = await ctx.runMutation(internal.notes.importLibraryNote, {
				apiTokenHash,
				preferredId: body.skipExisting ? (item.id ?? undefined) : undefined,
				newId: crypto.randomUUID(),
				title: item.title,
				content: data.content,
				background: data.background,
				isArchived: item.isArchived ?? undefined,
				isPinned: item.isPinned ?? undefined,
				isTrashed: item.isTrashed ?? undefined,
				tagIds: (item.tagNames ?? []).map((name) => ids.get(name)!),
				createdAt: seconds(item.createdAt),
				updatedAt: seconds(item.updatedAt),
				reminder: item.reminder
					? {
							remindAt: item.reminder.remindAt,
							recurrence: item.reminder.recurrence ?? undefined,
						}
					: undefined,
			});
		} catch (error) {
			console.error(
				"Note import mutation failed",
				error instanceof Error ? error.name : "Error",
			);
			results.push({
				ref: item.ref,
				status: "failed",
				error: "Failed to create note",
			});
			continue;
		}
		if (!result) return reply({ code: "UNAUTHENTICATED" }, 401);
		results.push({
			ref: item.ref,
			...result,
			...(data.warning && result.status !== "skipped"
				? { warning: data.warning }
				: {}),
		});
	}
	return reply({ results, tags: { created, reused: ids.size - created } }, 201);
});

export const importAttachment = httpAction(async (ctx, request) => {
	const path = new URL(request.url).pathname;
	const noteId = /^\/api\/import\/notes\/([^/]+)\/attachments$/.exec(path)?.[1];
	if (!noteId || !uuid.test(noteId))
		return reply({ code: "NOTE_NOT_FOUND" }, 404);
	const { apiTokenHash } = await legacyReadCredential(request);
	return legacyAttachmentRequest(
		ctx,
		request,
		noteId,
		apiTokenHash,
		undefined,
		true,
	);
});
