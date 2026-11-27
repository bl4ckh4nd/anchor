import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { legacyImportInProgress } from "./importState";

const retentionMs = 90 * 24 * 60 * 60 * 1000;
const revisionCap = 200;

export const prune = internalMutation({
	args: {
		cutoff: v.optional(v.number()),
		phase: v.optional(
			v.union(v.literal("normalize"), v.literal("age"), v.literal("cap")),
		),
		cursor: v.optional(v.string()),
		noteId: v.optional(v.id("notes")),
		rank: v.optional(v.number()),
	},
	handler: async (
		ctx,
		{
			cutoff = Date.now() - retentionMs,
			phase = "normalize",
			cursor,
			noteId,
			rank = 0,
		},
	): Promise<void> => {
		if (await legacyImportInProgress(ctx)) return;

		const batch = 8;
		if (phase === "normalize") {
			const rows = await ctx.db
				.query("noteRevisions")
				.withIndex("by_reported_at", (q) => q.eq("reportedAt", undefined))
				.take(batch);
			for (const row of rows) {
				await ctx.db.patch("noteRevisions", row._id, {
					reportedAt: row._creationTime,
				});
			}
			await ctx.scheduler.runAfter(0, internal.revisionRetention.prune, {
				cutoff,
				phase: rows.length === batch ? "normalize" : "age",
			});
			return;
		}

		if (phase === "age") {
			const rows = await ctx.db
				.query("noteRevisions")
				.withIndex("by_cause_date", (q) =>
					q
						.eq("cause", "edit")
						.gt("reportedAt", undefined)
						.lt("reportedAt", cutoff),
				)
				.take(batch);
			for (const row of rows) await ctx.db.delete("noteRevisions", row._id);
			await ctx.scheduler.runAfter(0, internal.revisionRetention.prune, {
				cutoff,
				phase: rows.length === batch ? "age" : "cap",
			});
			return;
		}

		const page = await ctx.db
			.query("noteRevisions")
			.withIndex("by_note_date")
			.order("desc")
			.paginate({
				cursor: cursor ?? null,
				numItems: 64,
				maximumBytesRead: 2_000_000,
			});
		for (const row of page.page) {
			if (row.noteId !== noteId) {
				noteId = row.noteId;
				rank = 0;
			}
			rank++;
			const recentConflict =
				row.cause === "conflict" &&
				(row.reportedAt ?? row._creationTime) >= cutoff;
			if (rank > revisionCap && !recentConflict)
				await ctx.db.delete("noteRevisions", row._id);
		}
		if (!page.isDone) {
			await ctx.scheduler.runAfter(0, internal.revisionRetention.prune, {
				cutoff,
				phase: "cap",
				cursor: page.continueCursor,
				noteId,
				rank,
			});
		}
	},
});
