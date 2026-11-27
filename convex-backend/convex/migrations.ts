import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { noteById } from "./notes";
import { tagById } from "./tags";

const tables = [
	"oidcSettings",
	"registrationPolicies",
	"authPolicies",
	"accounts",
	"recoveryCodes",
	"passkeys",
	"profileImages",
	"notes",
	"tags",
	"noteShares",
	"notePins",
	"noteArchives",
	"notePositions",
	"noteReminders",
	"noteRevisions",
	"noteTags",
	"noteAttachments",
] as const;
const tableName = v.union(...tables.map((table) => v.literal(table)));

function reject(code: string): never {
	throw new ConvexError(code);
}

function summary(
	run: Pick<Doc<"legacyImport">, "nextBatch" | "counts" | "complete">,
) {
	return {
		nextBatch: run.nextBatch,
		counts: run.counts,
		complete: run.complete,
	};
}

async function currentRun(ctx: MutationCtx, bundle: string) {
	const run = await ctx.db.query("legacyImport").unique();
	if (!run || run.bundle !== bundle) reject("IMPORT_BUNDLE_MISMATCH");
	return run;
}

export const begin = internalMutation({
	args: {
		bundle: v.string(),
		issuer: v.string(),
		totalBatches: v.number(),
		expectedCounts: v.record(v.string(), v.number()),
	},
	handler: async (ctx, { bundle, issuer, totalBatches, expectedCounts }) => {
		if (issuer !== process.env.ANCHOR_AUTH_ISSUER)
			reject("IMPORT_ISSUER_MISMATCH");
		if (
			!/^[a-f0-9]{64}$/.test(bundle) ||
			!Number.isSafeInteger(totalBatches) ||
			totalBatches < 0 ||
			Object.keys(expectedCounts).some(
				(key) => !tables.some((table) => table === key),
			) ||
			Object.values(expectedCounts).some(
				(count) => !Number.isSafeInteger(count) || count < 1,
			)
		)
			reject("IMPORT_PLAN_INVALID");
		const current = await ctx.db.query("legacyImport").unique();
		if (current) {
			if (
				current.bundle !== bundle ||
				current.issuer !== issuer ||
				current.totalBatches !== totalBatches ||
				Object.keys(expectedCounts).length !==
					Object.keys(current.expectedCounts).length ||
				Object.entries(expectedCounts).some(
					([table, count]) => current.expectedCounts[table] !== count,
				)
			)
				reject("IMPORT_BUNDLE_MISMATCH");
			return summary(current);
		}
		for (const table of [...tables, "noteFeed", "noteFeedHeads"] as const) {
			if (await ctx.db.query(table).first()) reject("IMPORT_TARGET_NOT_EMPTY");
		}
		if (await ctx.db.system.query("_storage").first())
			reject("IMPORT_TARGET_NOT_EMPTY");
		const run = {
			bundle,
			issuer,
			totalBatches,
			expectedCounts,
			nextBatch: 0,
			counts: {},
			complete: false,
		};
		await ctx.db.insert("legacyImport", run);
		return summary(run);
	},
});

export const upload = internalMutation({
	args: { bundle: v.string(), batch: v.number() },
	handler: async (ctx, { bundle, batch }) => {
		const run = await currentRun(ctx, bundle);
		if (batch < run.nextBatch) return null;
		if (run.complete || batch !== run.nextBatch || batch >= run.totalBatches)
			reject("IMPORT_BATCH_OUT_OF_ORDER");
		return ctx.storage.generateUploadUrl();
	},
});

export const apply = internalMutation({
	args: {
		bundle: v.string(),
		batch: v.number(),
		table: tableName,
		rows: v.array(
			v.object({
				data: v.record(v.string(), v.any()),
				note: v.optional(v.string()),
				tags: v.optional(v.array(v.string())),
				blob: v.optional(
					v.object({ id: v.id("_storage"), sha256: v.string() }),
				),
			}),
		),
	},
	handler: async (ctx, { bundle, batch, table, rows }) => {
		const run = await currentRun(ctx, bundle);
		if (batch < run.nextBatch) return summary(run);
		if (
			run.complete ||
			batch !== run.nextBatch ||
			batch >= run.totalBatches ||
			!rows.length ||
			rows.length > 32
		)
			reject("IMPORT_BATCH_OUT_OF_ORDER");
		const count = (run.counts[table] ?? 0) + rows.length;
		if (count > (run.expectedCounts[table] ?? 0))
			reject("IMPORT_UNEXPECTED_ROWS");

		for (const { data, note, tags, blob } of rows) {
			// The table schema validates the resolved document at insertion.
			const doc: Record<string, unknown> = { ...data };
			if (
				table === "notes" ||
				table === "tags" ||
				table === "accounts" ||
				table === "authPolicies" ||
				table === "oidcSettings" ||
				table === "registrationPolicies"
			) {
				doc.issuer = run.issuer;
			} else if (table === "recoveryCodes" || table === "passkeys") {
				const userId = doc.userId;
				if (
					typeof userId !== "string" ||
					!(await ctx.db
						.query("accounts")
						.withIndex("by_issuer_id", (q) =>
							q.eq("issuer", run.issuer).eq("id", userId),
						)
						.unique())
				)
					reject("IMPORT_ACCOUNT_REFERENCE_INVALID");
			} else if (table !== "profileImages") {
				const ownerNote = note && (await noteById(ctx, note));
				if (!ownerNote || ownerNote.issuer !== run.issuer)
					reject("IMPORT_NOTE_REFERENCE_INVALID");
				doc.noteId = ownerNote._id;
			}
			if (table === "noteTags") {
				if (!tags?.length) reject("IMPORT_TAG_REFERENCE_INVALID");
				const ids = [];
				for (const id of tags) {
					const tag = await tagById(ctx, id);
					if (!tag || tag.owner !== doc.subject || tag.issuer !== run.issuer)
						reject("IMPORT_TAG_REFERENCE_INVALID");
					ids.push(tag._id);
				}
				doc.tagIds = ids;
			}
			if (table === "noteAttachments" || table === "profileImages") {
				if (!blob) reject("IMPORT_ATTACHMENT_MISSING");
				const info = await ctx.db.system.get("_storage", blob.id);
				if (
					!info ||
					!/^[a-f0-9]{64}$/.test(blob.sha256) ||
					info.size !== doc.fileSize
				)
					reject("IMPORT_ATTACHMENT_MISMATCH");
				const digestBytes = blob.sha256.match(/../g) ?? [];
				const base64 = btoa(
					String.fromCharCode(
						...digestBytes.map((byte) => Number.parseInt(byte, 16)),
					),
				);
				if (info.sha256 !== blob.sha256 && info.sha256 !== base64)
					reject("IMPORT_ATTACHMENT_MISMATCH");
				doc.storageId = blob.id;
			}
			await ctx.db.insert(table, doc as never);
		}

		const next = {
			nextBatch: batch + 1,
			counts: { ...run.counts, [table]: count },
		};
		await ctx.db.patch("legacyImport", run._id, next);
		return summary({ ...next, complete: false });
	},
});

export const finish = internalMutation({
	args: { bundle: v.string() },
	handler: async (ctx, { bundle }) => {
		const run = await currentRun(ctx, bundle);
		if (
			run.nextBatch !== run.totalBatches ||
			Object.entries(run.expectedCounts).some(
				([table, count]) => run.counts[table] !== count,
			)
		)
			reject("IMPORT_INCOMPLETE");
		if (!run.complete)
			await ctx.db.patch("legacyImport", run._id, { complete: true });
		return summary({ ...run, complete: true });
	},
});
