import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { purgeNoteBatch } from "./accountDeletion";
import { legacyImportInProgress } from "./importState";
import { notesInStateBefore, recordTagChange, trashRetentionMs } from "./notes";

export const purgeExpired = internalMutation({
	args: { cutoff: v.optional(v.number()) },
	handler: async (ctx, { cutoff }): Promise<void> => {
		if (await legacyImportInProgress(ctx)) return;
		const now = Date.now();
		const before = Math.min(cutoff ?? now - trashRetentionMs, now);
		const [note] = await notesInStateBefore(ctx, "deleted", before, 1);
		if (note) await purgeNoteBatch(ctx, note, false);

		const limit = 16;
		const tags = await ctx.db
			.query("tags")
			.withIndex("by_deletion_age", (q) =>
				q.eq("isDeleted", true).lt("updatedAt", before),
			)
			.take(limit);
		for (const tag of tags) {
			await recordTagChange(
				ctx,
				{ issuer: tag.issuer, subject: tag.owner },
				tag.id,
				"remove",
			);
			await ctx.db.delete("tags", tag._id);
		}
		const shares = await ctx.db
			.query("noteShares")
			.withIndex("by_revocation_age", (q) =>
				q
					.eq("isRevoked", true)
					.gt("updatedAt", undefined)
					.lt("updatedAt", before),
			)
			.take(limit);
		for (const share of shares) await ctx.db.delete("noteShares", share._id);
		if (note || tags.length === limit || shares.length === limit)
			await ctx.scheduler.runAfter(0, internal.tombstones.purgeExpired, {
				cutoff: before,
			});
	},
});
