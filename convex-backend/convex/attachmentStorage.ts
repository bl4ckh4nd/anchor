import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

export async function releaseAttachmentBlob(
	ctx: MutationCtx,
	attachment: Doc<"noteAttachments">,
) {
	if (attachment.deletedAt !== undefined) return;
	const other = await ctx.db
		.query("noteAttachments")
		.withIndex("by_storage_id", (q) => q.eq("storageId", attachment.storageId))
		.filter((q) =>
			q.and(
				q.neq(q.field("_id"), attachment._id),
				q.eq(q.field("deletedAt"), undefined),
			),
		)
		.first();
	if (!other && (await ctx.db.system.get("_storage", attachment.storageId)))
		await ctx.storage.delete(attachment.storageId);
}
