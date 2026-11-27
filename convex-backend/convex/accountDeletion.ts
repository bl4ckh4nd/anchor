import { v } from "convex/values";
import { releaseAttachmentBlob } from "./attachmentStorage";
import { internal } from "./_generated/api";
import type { Doc, Id, TableNames } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { recordChange, recordNoteUpdate } from "./notes";
import { accountFor } from "./sessions";

const batch = 4;
const phases = [
	"ownedNotes",
	"shares",
	"authoredShares",
	"reminders",
	"pins",
	"positions",
	"archives",
	"noteTags",
	"revisions",
	"attachments",
	"tags",
	"sessions",
	"challenges",
	"recoveryCodes",
	"passkeys",
	"passwordAttempts",
	"feed",
] as const;
type Phase = (typeof phases)[number];

async function deleteRows(ctx: MutationCtx, rows: { _id: Id<TableNames> }[]) {
	for (const row of rows) await ctx.db.delete(row._id);
	return rows.length > 0;
}

export async function purgeNoteBatch(
	ctx: MutationCtx,
	note: Doc<"notes">,
	notifyRecipients: boolean,
) {
	const shares = await ctx.db
		.query("noteShares")
		.withIndex("by_note_subject", (q) => q.eq("noteId", note._id))
		.take(batch);
	for (const share of shares) {
		if (notifyRecipients && (await accountFor(ctx, note.issuer, share.subject)))
			await recordChange(ctx, note, share.subject, "remove");
		await ctx.db.delete("noteShares", share._id);
	}
	if (shares.length) return;

	const attachments = await ctx.db
		.query("noteAttachments")
		.withIndex("by_note_id", (q) => q.eq("noteId", note._id))
		.take(batch);
	for (const attachment of attachments) {
		await releaseAttachmentBlob(ctx, attachment);
		await ctx.db.delete("noteAttachments", attachment._id);
	}
	if (attachments.length) return;

	if (
		await deleteRows(
			ctx,
			await ctx.db
				.query("noteRevisions")
				.withIndex("by_note", (q) => q.eq("noteId", note._id))
				.take(batch),
		)
	)
		return;
	// Remove dependents before the note so each batch can resume by owner.
	for (const table of [
		"noteArchives",
		"notePins",
		"noteReminders",
		"notePositions",
		"noteTags",
	] as const) {
		const rows = await ctx.db
			.query(table)
			.withIndex("by_note_subject", (q) => q.eq("noteId", note._id))
			.take(batch);
		await deleteRows(ctx, rows);
		if (rows.length === batch) return;
	}
	await ctx.db.delete("notes", note._id);
}

async function purgeForeign(
	ctx: MutationCtx,
	issuer: string,
	userId: string,
	phase: Phase,
	cursor: string | null,
): Promise<string | null> {
	const options = { cursor, numItems: batch };
	switch (phase) {
		case "shares":
		case "authoredShares": {
			const rows =
				phase === "shares"
					? await ctx.db
							.query("noteShares")
							.withIndex("by_subject", (q) => q.eq("subject", userId))
							.paginate(options)
					: await ctx.db
							.query("noteShares")
							.withIndex("by_sharer", (q) => q.eq("sharedByUserId", userId))
							.paginate(options);
			for (const row of rows.page) {
				const note = await ctx.db.get("notes", row.noteId);
				if (note?.issuer !== issuer) continue;
				await ctx.db.delete("noteShares", row._id);
				if (row.subject !== userId)
					await recordChange(ctx, note, row.subject, "remove");
				await recordNoteUpdate(ctx, note);
			}
			return rows.isDone ? null : rows.continueCursor;
		}
		case "revisions": {
			const rows = await ctx.db
				.query("noteRevisions")
				.withIndex("by_author", (q) => q.eq("authorSubject", userId))
				.paginate(options);
			for (const row of rows.page) {
				const note = await ctx.db.get("notes", row.noteId);
				if (note?.issuer === issuer)
					await ctx.db.patch("noteRevisions", row._id, { authorSubject: null });
			}
			return rows.isDone ? null : rows.continueCursor;
		}
		case "attachments": {
			const rows = await ctx.db
				.query("noteAttachments")
				.withIndex("by_uploader", (q) => q.eq("uploadedByUserId", userId))
				.paginate(options);
			for (const row of rows.page) {
				const note = await ctx.db.get("notes", row.noteId);
				if (note?.issuer === issuer) {
					await ctx.db.patch("noteAttachments", row._id, {
						uploadedByUserId: note.owner,
					});
					if (row.deletedAt === undefined && note.state !== "deleted")
						await recordNoteUpdate(ctx, note);
				}
			}
			return rows.isDone ? null : rows.continueCursor;
		}
		case "reminders":
		case "pins":
		case "positions":
		case "archives":
		case "noteTags": {
			const table =
				phase === "noteTags"
					? phase
					: ({
							reminders: "noteReminders",
							pins: "notePins",
							positions: "notePositions",
							archives: "noteArchives",
						}[phase] as
							| "noteReminders"
							| "notePins"
							| "notePositions"
							| "noteArchives");
			const rows = await ctx.db
				.query(table)
				.withIndex("by_subject", (q) => q.eq("subject", userId))
				.paginate(options);
			for (const row of rows.page) {
				const note = await ctx.db.get("notes", row.noteId);
				if (note?.issuer === issuer) await ctx.db.delete(row._id);
			}
			return rows.isDone ? null : rows.continueCursor;
		}
		default:
			throw new Error("Unexpected account deletion phase");
	}
}

const phaseValidator = v.union(...phases.map((phase) => v.literal(phase)));

export const purge = internalMutation({
	args: {
		issuer: v.string(),
		userId: v.string(),
		accountId: v.id("accounts"),
		phase: v.optional(phaseValidator),
		cursor: v.optional(v.string()),
	},
	handler: async (
		ctx,
		{ issuer, userId, accountId, phase = "ownedNotes", cursor },
	): Promise<void> => {
		const schedule = (next: Phase, cursor?: string) =>
			ctx.scheduler.runAfter(0, internal.accountDeletion.purge, {
				issuer,
				userId,
				accountId,
				phase: next,
				...(cursor === undefined ? {} : { cursor }),
			});
		let repeat = false;
		switch (phase) {
			case "ownedNotes": {
				const note = await ctx.db
					.query("notes")
					.withIndex("by_owner_id", (q) =>
						q.eq("issuer", issuer).eq("owner", userId),
					)
					.first();
				if (note) {
					await purgeNoteBatch(ctx, note, true);
					repeat = true;
				}
				break;
			}
			case "tags":
				repeat = await deleteRows(
					ctx,
					await ctx.db
						.query("tags")
						.withIndex("by_owner_id", (q) =>
							q.eq("issuer", issuer).eq("owner", userId),
						)
						.take(batch),
				);
				break;
			case "sessions": {
				const session = await ctx.db
					.query("sessions")
					.withIndex("by_account", (q) =>
						q.eq("issuer", issuer).eq("userId", userId),
					)
					.first();
				if (!session) break;
				const tokens = await ctx.db
					.query("refreshTokens")
					.withIndex("by_session", (q) => q.eq("sessionId", session._id))
					.take(batch);
				await deleteRows(ctx, tokens);
				if (tokens.length < batch) await ctx.db.delete("sessions", session._id);
				repeat = true;
				break;
			}
			case "challenges":
				repeat = await deleteRows(
					ctx,
					await ctx.db
						.query("loginChallenges")
						.withIndex("by_account", (q) => q.eq("accountId", accountId))
						.take(batch),
				);
				break;
			case "recoveryCodes":
				repeat = await deleteRows(
					ctx,
					await ctx.db
						.query("recoveryCodes")
						.withIndex("by_user", (q) => q.eq("userId", userId))
						.take(batch),
				);
				break;
			case "passkeys":
				repeat = await deleteRows(
					ctx,
					await ctx.db
						.query("passkeys")
						.withIndex("by_user", (q) => q.eq("userId", userId))
						.take(batch),
				);
				break;
			case "passwordAttempts": {
				const attempt = await ctx.db
					.query("passwordAttempts")
					.withIndex("by_key", (q) => q.eq("key", userId))
					.unique();
				if (attempt) await ctx.db.delete("passwordAttempts", attempt._id);
				break;
			}
			case "feed":
				repeat = await deleteRows(
					ctx,
					await ctx.db
						.query("noteFeed")
						.withIndex("by_recipient_seq", (q) =>
							q.eq("issuer", issuer).eq("subject", userId),
						)
						.take(batch),
				);
				if (!repeat) {
					const head = await ctx.db
						.query("noteFeedHeads")
						.withIndex("by_recipient", (q) =>
							q.eq("issuer", issuer).eq("subject", userId),
						)
						.unique();
					if (head) await ctx.db.delete("noteFeedHeads", head._id);
				}
				break;
			default: {
				const next = await purgeForeign(
					ctx,
					issuer,
					userId,
					phase,
					cursor ?? null,
				);
				if (next !== null) {
					await schedule(phase, next);
					return;
				}
			}
		}
		const next = repeat ? phase : phases[phases.indexOf(phase) + 1];
		if (next) await schedule(next);
	},
});
