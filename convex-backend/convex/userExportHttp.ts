import type { FunctionReturnType } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { httpAction, internalMutation, internalQuery } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { exportStorageContentType } from "./attachmentFiles";
import { legacyReadCredential } from "./apiTokenHttp";
import { reply } from "./sessionHttp";
import { legacyReadIdentity } from "./sessions";

const directLimit = 100 * 1024 * 1024;
const chunkSize = 16 * 1024 * 1024;
const retentionMs = 15 * 60 * 1000;

export const removeArchive = internalMutation({
	args: {
		storageId: v.id("_storage"),
		downloadId: v.optional(v.id("exportDownloads")),
	},
	handler: async (ctx, { storageId, downloadId }) => {
		if (downloadId) await ctx.db.delete(downloadId);
		if (await ctx.db.system.get("_storage", storageId))
			await ctx.storage.delete(storageId);
	},
});

export const registerDownload = internalMutation({
	args: {
		storageId: v.id("_storage"),
		identity: v.object({ issuer: v.string(), subject: v.string() }),
	},
	handler: async (ctx, { storageId, identity }): Promise<Id<"exportDownloads">> => {
		const downloadId = await ctx.db.insert("exportDownloads", {
			...identity,
			storageId,
			expiresAt: Date.now() + retentionMs,
		});
		await ctx.scheduler.runAfter(
			retentionMs,
			internal.userExportHttp.removeArchive,
			{ storageId, downloadId },
		);
		return downloadId;
	},
});

export const lookupDownload = internalQuery({
	args: { id: v.string(), apiTokenHash: v.string() },
	handler: async (ctx, { id, apiTokenHash }) => {
		const identity = await legacyReadIdentity(ctx, apiTokenHash);
		if (!identity) return { type: "unauthenticated" } as const;
		const downloadId = ctx.db.normalizeId("exportDownloads", id);
		const entry = downloadId ? await ctx.db.get(downloadId) : null;
		if (
			!entry ||
			entry.subject !== identity.subject ||
			entry.issuer !== identity.issuer ||
			entry.expiresAt <= Date.now()
		)
			return { type: "missing" } as const;
		return { type: "download", storageId: entry.storageId } as const;
	},
});

export const userExportPart = httpAction(async (ctx, request) => {
	const { apiTokenHash } = await legacyReadCredential(request);
	if (!apiTokenHash) return reply({ code: "UNAUTHENTICATED" }, 401);
	const url = new URL(request.url);
	const id = url.pathname.slice("/api/export/".length);
	if (!/^[a-z0-9]{1,64}$/.test(id))
		return reply({ code: "EXPORT_NOT_FOUND" }, 404);
	const download = await ctx.runQuery(internal.userExportHttp.lookupDownload, {
		id,
		apiTokenHash,
	});
	if (download.type === "unauthenticated")
		return reply({ code: "UNAUTHENTICATED" }, 401);
	if (download.type === "missing") return reply({ code: "EXPORT_NOT_FOUND" }, 404);
	const rawOffset = url.searchParams.get("offset");
	const offset = Number(rawOffset);
	if (
		rawOffset === null ||
		!/^\d+$/.test(rawOffset) ||
		!Number.isSafeInteger(offset)
	)
		return reply({ code: "INVALID_EXPORT_OFFSET" }, 400);
	const archive = await ctx.storage.get(download.storageId);
	if (!archive) return reply({ code: "EXPORT_NOT_FOUND" }, 404);
	if (offset >= archive.size)
		return new Response(null, {
			status: 416,
			headers: {
				"Cache-Control": "private, no-store",
				"Content-Range": `bytes */${archive.size}`,
			},
		});
	const end = Math.min(offset + chunkSize, archive.size);
	return new Response(archive.slice(offset, end).stream(), {
		status: 206,
		headers: {
			"Content-Type": "application/zip",
			"Content-Length": String(end - offset),
			"Content-Range": `bytes ${offset}-${end - 1}/${archive.size}`,
			"Cache-Control": "private, no-store",
		},
	});
});

export const userExport = httpAction(async (ctx, request) => {
	const { apiTokenHash } = await legacyReadCredential(request);
	if (!apiTokenHash) return reply({ code: "UNAUTHENTICATED" }, 401);
	const format = new URL(request.url).searchParams.get("format") ?? "anchor";
	if (format !== "anchor" && format !== "markdown")
		return reply({ code: "INVALID_EXPORT_FORMAT" }, 400);
	const identity = await ctx.runQuery(internal.notes.exportLibraryUser, {
		apiTokenHash,
	});
	if (identity.type === "unauthenticated")
		return reply({ code: "UNAUTHENTICATED" }, 401);
	if (identity.type === "missing")
		return reply({ code: "USER_NOT_FOUND" }, 404);

	const pages: Id<"_storage">[] = [];
	const pageUrls: string[] = [];
	const stage = async (
		source: "tags" | "owned" | "shared",
		rows: unknown[],
	) => {
		if (rows.length === 0) return;
		const storageId = await ctx.storage.store(
			new Blob([JSON.stringify({ source, rows })], {
				type: exportStorageContentType,
			}),
		);
		pages.push(storageId);
		const url = await ctx.storage.getUrl(storageId);
		if (!url) throw new Error("Export staging page unavailable");
		pageUrls.push(url);
	};

	try {
		let cursor: string | null = null;
		do {
			const page: FunctionReturnType<typeof internal.tags.legacyTagsPage> =
				await ctx.runQuery(internal.tags.legacyTagsPage, {
					apiTokenHash,
					page: { cursor, numItems: 64 },
				});
			if (page.type !== "page") return reply({ code: "UNAUTHENTICATED" }, 401);
			await stage(
				"tags",
				page.rows.map(({ id, name, color }) => ({ id, name, color })),
			);
			cursor = page.cursor;
		} while (cursor !== null);
		for (const source of ["owned", "shared"] as const) {
			do {
				const page: FunctionReturnType<
					typeof internal.notes.exportLibraryPage
				> = await ctx.runQuery(internal.notes.exportLibraryPage, {
					apiTokenHash,
					source,
					page: { cursor, numItems: 4, maximumBytesRead: 5_000_000 },
				});
				if (!page) return reply({ code: "UNAUTHENTICATED" }, 401);
				await stage(source, page.rows);
				cursor = page.next;
			} while (cursor !== null);
		}
		const allowLarge = request.headers.get("X-Anchor-Export-Parts") === "1";
		const result = await ctx.runAction(internal.userExportActions.assemble, {
			user: identity.user,
			pageUrls,
			format,
			allowLarge,
			uploadUrl: await ctx.storage.generateUploadUrl(),
		});
		if (result.type === "too-large")
			return reply({ code: "EXPORT_TOO_LARGE" }, 413);
		const name = format === "anchor" ? "export" : "markdown";
		const date = new Date().toISOString().slice(0, 10);
		const headers = {
			"Content-Disposition": `attachment; filename="anchor-${name}-${date}.zip"`,
			"Cache-Control": "private, no-store",
		};
		const archive = await ctx.storage.get(result.storageId);
		if (!archive) return reply({ code: "EXPORT_UNAVAILABLE" }, 503);
		try {
			const current = await ctx.runQuery(internal.notes.exportLibraryUser, {
				apiTokenHash,
			});
			if (
				current.type !== "user" ||
				current.identity.issuer !== identity.identity.issuer ||
				current.identity.subject !== identity.identity.subject
			) {
				await ctx.storage.delete(result.storageId);
				return reply({ code: "UNAUTHENTICATED" }, 401);
			}
			if (allowLarge && archive.size > directLimit) {
				const id = await ctx.runMutation(internal.userExportHttp.registerDownload, {
					storageId: result.storageId,
					identity: current.identity,
				});
				return Response.json(
					{ id, size: archive.size, chunkSize },
					{ status: 202, headers },
				);
			}
			await ctx.scheduler.runAfter(
				retentionMs,
				internal.userExportHttp.removeArchive,
				{ storageId: result.storageId },
			);
		} catch (error) {
			await ctx.storage.delete(result.storageId);
			throw error;
		}
		return new Response(archive.stream(), {
			headers: {
				"Content-Type": "application/zip",
				"Content-Length": String(archive.size),
				...headers,
			},
		});
	} finally {
		for (const storageId of pages) {
			await ctx.storage.delete(storageId).catch(() => {
				console.error("Could not clean up export staging page");
			});
		}
	}
});
