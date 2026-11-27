import type { QueryCtx } from "./_generated/server";

export async function legacyImportInProgress(ctx: QueryCtx) {
	const run = await ctx.db.query("legacyImport").unique();
	return run !== null && !run.complete;
}
