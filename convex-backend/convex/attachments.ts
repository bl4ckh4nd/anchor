import {
	exportStorageContentType,
	maxSize,
	mimeTypes,
	storageContentType,
	validFilename,
} from "./attachmentFiles";
import { v } from "convex/values";
import { profileStorageContentType } from "./profiles";
import { releaseAttachmentBlob } from "./attachmentStorage";
import { legacyImportInProgress } from "./importState";
import { authorizedIdentity, legacyReadIdentity } from "./sessions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
	httpAction,
	internalMutation,
	internalQuery,
	type ActionCtx,
	type QueryCtx,
} from "./_generated/server";
import {
	attachmentView,
	noteAccess,
	noteById,
	orderedAttachments,
	outboxScopeChanged,
	recordNoteUpdate,
} from "./notes";

const orphanGracePeriodMs = 15 * 60 * 1000;

function attachmentFor(ctx: QueryCtx, noteId: Doc<"notes">["_id"], id: string) {
	return ctx.db
		.query("noteAttachments")
		.withIndex("by_note_id", (q) => q.eq("noteId", noteId).eq("id", id))
		.unique();
}

const identifiers = { noteId: v.string(), attachmentId: v.string() };
const bearerHash = { apiTokenHash: v.optional(v.string()) };
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export const list = internalQuery({
	args: { noteId: v.string(), ...bearerHash },
	handler: async (ctx, { noteId, apiTokenHash }) => {
		const identity = await legacyReadIdentity(ctx, apiTokenHash);
		if (!identity) return 401;
		const note = await noteById(ctx, noteId);
		if (!note || !(await noteAccess(ctx, identity, note))) return null;
		const entries = await orderedAttachments(ctx, note._id);
		return entries.map(({ attachment, position }) => ({
			...attachmentView(noteId, attachment),
			position,
		}));
	},
});

export const reorder = internalMutation({
	args: { noteId: v.string(), orderedIds: v.array(v.string()), ...bearerHash },
	handler: async (ctx, { noteId, orderedIds, apiTokenHash }) => {
		const identity = await legacyReadIdentity(ctx, apiTokenHash);
		if (!identity) return { status: 401 as const };
		const note = await noteById(ctx, noteId);
		const access = note && (await noteAccess(ctx, identity, note));
		if (!note || !access) return { status: 404 as const };
		if (access === "viewer") return { status: 403 as const };
		if (note.state === "trashed") return { status: 400 as const };
		const entries = await orderedAttachments(ctx, note._id);
		const byId = new Map(
			entries.map(({ attachment }) => [attachment.id, attachment]),
		);
		if (!orderedIds.length || orderedIds.length !== byId.size)
			return { status: 400 as const };
		const sorted = [];
		for (const id of orderedIds) {
			const attachment = byId.get(id);
			if (!attachment) return { status: 400 as const };
			sorted.push(attachment);
			byId.delete(id);
		}
		for (const [position, attachment] of sorted.entries()) {
			if (attachment.position !== position)
				await ctx.db.patch("noteAttachments", attachment._id, { position });
		}
		await recordNoteUpdate(ctx, note);
		return {
			status: 200 as const,
			attachments: sorted.map((attachment, position) => ({
				...attachmentView(noteId, attachment),
				position,
			})),
		};
	},
});

export const lookup = internalQuery({
	args: { ...identifiers, write: v.boolean(), ...bearerHash, importing: v.optional(v.boolean()) },
	handler: async (ctx, { noteId, attachmentId, write, apiTokenHash, importing }) => {
		const identity = await legacyReadIdentity(ctx, apiTokenHash);
		if (!identity) return { allowed: false as const, status: 401 as const };
		const note = await noteById(ctx, noteId);
		if (importing && note?.issuer === identity.issuer && note.owner !== identity.subject)
			return { allowed: false as const, status: 403 as const };
		const access = note && (await noteAccess(ctx, identity, note));
		if (!note || !access)
			return { allowed: false as const, status: 404 as const };
		if (write && access === "viewer")
			return { allowed: false as const, status: 403 as const };
		if (write && !importing && note.state === "trashed")
			return { allowed: false as const, status: 400 as const };
		const attachment = await attachmentFor(ctx, note._id, attachmentId);
		if (
			write &&
			attachment &&
			attachment.uploadedByUserId !== identity.subject
		) {
			return { allowed: false as const, status: 404 as const };
		}
		return {
			allowed: true as const,
			deleted: attachment?.deletedAt !== undefined,
			attachment:
				attachment && attachment.deletedAt === undefined
					? {
							details: attachmentView(noteId, attachment),
							storageId: attachment.storageId,
						}
					: null,
		};
	},
});

export const finalize = internalMutation({
	args: {
		...identifiers,
		...bearerHash,
		storageId: v.id("_storage"),
		originalFilename: v.string(),
		mimeType: v.string(),
		fileSize: v.number(),
		position: v.optional(v.number()),
	},
	handler: async (ctx, { noteId, attachmentId, apiTokenHash, position, ...file }) => {
		const identity = await legacyReadIdentity(ctx, apiTokenHash);
		if (!identity) {
			await ctx.storage.delete(file.storageId);
			return { status: 401 as const };
		}
		if (!(await ctx.db.system.get("_storage", file.storageId)))
			return { status: 503 as const };
		const note = await noteById(ctx, noteId);
		const access = note && (await noteAccess(ctx, identity, note));
		const allowed = position === undefined
			? access && access !== "viewer" && note?.state !== "trashed"
			: access === "owner";
		if (!note || !allowed) {
			await ctx.storage.delete(file.storageId);
			return { status: 404 as const };
		}
		const existing = await attachmentFor(ctx, note._id, attachmentId);
		if (existing) {
			await ctx.storage.delete(file.storageId);
			if (existing.uploadedByUserId !== identity.subject)
				return { status: 404 as const };
			if (existing.deletedAt !== undefined) return { status: 410 as const };
			return {
				status: 200 as const,
				details: attachmentView(noteId, existing),
			};
		}
		if (position === undefined) {
			for (const { attachment, position: index } of await orderedAttachments(ctx, note._id)) {
				await ctx.db.patch("noteAttachments", attachment._id, {
					position: index + 1,
				});
			}
		}
		const id = await ctx.db.insert("noteAttachments", {
			id: attachmentId,
			noteId: note._id,
			uploadedByUserId: identity.subject,
			position: position ?? 0,
			...file,
		});
		const inserted = await ctx.db.get("noteAttachments", id);
		if (!inserted) throw new Error("Attachment did not persist");
		await recordNoteUpdate(ctx, note);
		return { status: 201 as const, details: attachmentView(noteId, inserted) };
	},
});

export const collectOrphanUploads = internalMutation({
	args: { cutoff: v.optional(v.number()), cursor: v.optional(v.string()) },
	handler: async (ctx, { cutoff, cursor }): Promise<void> => {
		if (await legacyImportInProgress(ctx)) return;
		const now = Date.now();
		const before = Math.min(cutoff ?? now - orphanGracePeriodMs, now);
		const batch = await ctx.db.system
			.query("_storage")
			.withIndex("by_creation_time", (q) => q.lt("_creationTime", before))
			.paginate({ cursor: cursor ?? null, numItems: 64 });
		for (const blob of batch.page) {
			if (blob.contentType === exportStorageContentType) {
				await ctx.storage.delete(blob._id);
				continue;
			}
			if (blob.contentType === profileStorageContentType) {
				const profile = await ctx.db
					.query("profileImages")
					.withIndex("by_storage_id", (q) => q.eq("storageId", blob._id))
					.first();
				if (!profile) await ctx.storage.delete(blob._id);
				continue;
			}
			if (blob.contentType !== storageContentType) continue;
			const attachment = await ctx.db
				.query("noteAttachments")
				.withIndex("by_storage_id", (q) => q.eq("storageId", blob._id))
				.first();
			if (!attachment) await ctx.storage.delete(blob._id);
		}
		if (!batch.isDone) {
			await ctx.scheduler.runAfter(
				0,
				internal.attachments.collectOrphanUploads,
				{
					cutoff: before,
					cursor: batch.continueCursor,
				},
			);
		}
	},
});

export const remove = internalMutation({
	args: { ...identifiers, ...bearerHash },
	handler: async (ctx, { noteId, attachmentId, apiTokenHash }) => {
		const identity = await legacyReadIdentity(ctx, apiTokenHash);
		if (!identity) return 401;
		const note = await noteById(ctx, noteId);
		const access = note && (await noteAccess(ctx, identity, note));
		if (!note || !access || access === "viewer" || note.state === "trashed")
			return 404;
		const attachment = await attachmentFor(ctx, note._id, attachmentId);
		if (!attachment) return 404;
		if (access !== "owner" && attachment.uploadedByUserId !== identity.subject)
			return 400;
		if (attachment.deletedAt !== undefined) return 200;
		await releaseAttachmentBlob(ctx, attachment);
		await ctx.db.patch("noteAttachments", attachment._id, {
			deletedAt: Date.now(),
		});
		await recordNoteUpdate(ctx, note);
		return 200;
	},
});

export const deleteAttachment = httpAction(async (ctx, request) => {
	if (!(await authorizedIdentity(ctx)))
		return reply({ code: "UNAUTHENTICATED" }, 401);
	if (await outboxScopeChanged(ctx, request)) return reply({ code: "OUTBOX_SCOPE_CHANGED" }, 409);
	const ids = requestIds(request);
	if (!ids) return reply({ code: "INVALID_ATTACHMENT_ID" }, 400);
	return removeAttachment(ctx, ids);
});

type AttachmentArgs = {
	noteId: string;
	attachmentId: string;
	apiTokenHash?: string;
};

async function removeAttachment(ctx: ActionCtx, ids: AttachmentArgs) {
	const status = await ctx.runMutation(internal.attachments.remove, ids);
	if (status === 401) return reply({ code: "UNAUTHENTICATED" }, 401);
	if (status === 400)
		return reply({ code: "ATTACHMENT_NOT_UPLOADED_BY_YOU" }, status);
	if (status === 404) return reply({ code: "ATTACHMENT_NOT_FOUND" }, status);
	return reply({ success: true }, status);
}

function requestIds(request: Request) {
	const query = new URL(request.url).searchParams;
	const noteId = query.get("noteId");
	const attachmentId = query.get("attachmentId");
	return noteId && attachmentId && uuid.test(noteId) && uuid.test(attachmentId)
		? { noteId, attachmentId }
		: null;
}

export const attachmentCollection = httpAction(async (ctx, request) => {
	if (!(await authorizedIdentity(ctx)))
		return reply({ code: "UNAUTHENTICATED" }, 401);
	const noteId = new URL(request.url).searchParams.get("noteId");
	if (!noteId || !uuid.test(noteId))
		return reply({ code: "INVALID_NOTE_ID" }, 400);
	return attachmentListOrOrder(ctx, request, noteId);
});

async function attachmentListOrOrder(
	ctx: ActionCtx,
	request: Request,
	noteId: string,
	apiTokenHash?: string,
) {
	if (request.method === "GET") {
		const files = await ctx.runQuery(internal.attachments.list, {
			noteId,
			apiTokenHash,
		});
		if (files === 401) return reply({ code: "UNAUTHENTICATED" }, 401);
		return files === null
			? reply({ code: "NOTE_NOT_FOUND" }, 404)
			: reply(files, 200);
	}
	let orderedIds: unknown;
	try {
		orderedIds = (await request.json())?.orderedIds;
	} catch {
		return reply({ code: "INVALID_ATTACHMENT_ORDER" }, 400);
	}
	if (
		!Array.isArray(orderedIds) ||
		!orderedIds.every((id) => typeof id === "string" && uuid.test(id))
	)
		return reply({ code: "INVALID_ATTACHMENT_ORDER" }, 400);
	const result = await ctx.runMutation(internal.attachments.reorder, {
		noteId,
		orderedIds,
		apiTokenHash,
	});
	if (result.status === 401) return reply({ code: "UNAUTHENTICATED" }, 401);
	if (result.status === 403)
		return apiTokenHash
			? reply({ code: "NOTE_READ_ONLY" }, 403)
			: reply({ code: "NOTE_NOT_FOUND" }, 404);
	if (result.status === 404) return reply({ code: "NOTE_NOT_FOUND" }, 404);
	if (result.status === 400)
		return reply({ code: "INVALID_ATTACHMENT_ORDER" }, 400);
	return reply(result.attachments, 200);
}

function reply(body: unknown, status: number) {
	return Response.json(body, {
		status,
		headers: { "Cache-Control": "private, no-store" },
	});
}

function requestFilename(request: Request) {
	const encoded = request.headers.get("x-anchor-filename-encoded");
	try {
		return (
			encoded === null
				? request.headers.get("x-anchor-filename")
				: decodeURIComponent(encoded)
		)?.trim();
	} catch (error) {
		if (error instanceof URIError) return undefined;
		throw error;
	}
}

async function replyToUpload(request: Request, body: unknown, status: number) {
	// An upstream proxy can lose an early reply while it is still writing the body.
	const size = Number(request.headers.get("content-length"));
	if (request.body && size > 0 && size <= maxSize)
		await request.body.pipeTo(new WritableStream<Uint8Array>());
	return reply(body, status);
}

export const uploadAttachment = httpAction(async (ctx, request) => {
	if (!(await authorizedIdentity(ctx)))
		return replyToUpload(request, { code: "UNAUTHENTICATED" }, 401);
	if (await outboxScopeChanged(ctx, request))
		return replyToUpload(request, { code: "OUTBOX_SCOPE_CHANGED" }, 409);
	const ids = requestIds(request);
	if (!ids)
		return replyToUpload(request, { code: "INVALID_ATTACHMENT_ID" }, 400);
	const mimeType = request.headers.get("content-type") ?? "";
	if (!mimeTypes.has(mimeType))
		return replyToUpload(request, { code: "UNSUPPORTED_ATTACHMENT_TYPE" }, 415);
	const declared = request.headers.get("content-length") ?? "";
	if (!/^\d+$/.test(declared))
		return replyToUpload(request, { code: "ATTACHMENT_LENGTH_REQUIRED" }, 411);
	const fileSize = Number(declared);
	if (fileSize > maxSize) return reply({ code: "ATTACHMENT_TOO_LARGE" }, 413);
	if (fileSize === 0) return reply({ code: "EMPTY_ATTACHMENT" }, 400);
	const originalFilename = requestFilename(request);
	if (!validFilename(originalFilename)) {
		return replyToUpload(request, { code: "INVALID_ATTACHMENT_FILENAME" }, 400);
	}
	const target = await ctx.runQuery(internal.attachments.lookup, {
		...ids,
		write: true,
	});
	if (!target.allowed)
		return replyToUpload(request, { code: "ATTACHMENT_NOT_FOUND" }, 404);
	if (target.deleted)
		return replyToUpload(request, { code: "ATTACHMENT_DELETED" }, 410);
	if (target.attachment)
		return replyToUpload(request, target.attachment.details, 200);

	const blob = await request.blob();
	if (blob.size !== fileSize)
		return reply({ code: "ATTACHMENT_SIZE_MISMATCH" }, 400);
	return commitUpload(ctx, ids, blob, originalFilename, mimeType);
});

async function commitUpload(
	ctx: ActionCtx,
	ids: AttachmentArgs,
	blob: Blob,
	originalFilename: string,
	mimeType: string,
) {
	const storageId = await ctx.storage.store(
		blob.slice(0, blob.size, storageContentType),
	);
	return finalizeUpload(ctx, ids, {
		storageId,
		originalFilename,
		mimeType,
		fileSize: blob.size,
	});
}

async function finalizeUpload(
	ctx: ActionCtx,
	ids: AttachmentArgs,
	file: {
		storageId: Id<"_storage">;
		originalFilename: string;
		mimeType: string;
		fileSize: number;
		position?: number;
	},
) {
	const result = await ctx.runMutation(internal.attachments.finalize, {
		...ids,
		...file,
	});
	if (result.status === 401) return reply({ code: "UNAUTHENTICATED" }, 401);
	if (result.status === 404)
		return reply({ code: "ATTACHMENT_NOT_FOUND" }, 404);
	if (result.status === 410) return reply({ code: "ATTACHMENT_DELETED" }, 410);
	if (result.status === 503)
		return reply({ code: "ATTACHMENT_UPLOAD_RETRY" }, 503);
	return reply(
		file.position === undefined ? result.details : { ...result.details, position: file.position },
		result.status,
	);
}

export const downloadAttachment = httpAction(async (ctx, request) => {
	if (!(await authorizedIdentity(ctx)))
		return reply({ code: "UNAUTHENTICATED" }, 401);
	const ids = requestIds(request);
	if (!ids) return reply({ code: "INVALID_ATTACHMENT_ID" }, 400);
	return serveAttachment(ctx, request, ids);
});

async function serveAttachment(
	ctx: ActionCtx,
	request: Request,
	ids: AttachmentArgs,
	disposition = "attachment",
) {
	const target = await ctx.runQuery(internal.attachments.lookup, {
		...ids,
		write: false,
	});
	if (!target.allowed && target.status === 401)
		return reply({ code: "UNAUTHENTICATED" }, 401);
	if (!target.allowed || !target.attachment)
		return reply({ code: "ATTACHMENT_NOT_FOUND" }, 404);
	const { details, storageId } = target.attachment;
	const headers = new Headers({
		"Cache-Control": "private, no-store",
		"Content-Type": details.mimeType,
		"Content-Disposition": `${disposition}; filename="${encodeURIComponent(details.originalFilename)}"`,
		"X-Content-Type-Options": "nosniff",
		"Accept-Ranges": "bytes",
	});
	const range = request.headers.get("range");
	const span = range ? byteRange(range, details.fileSize) : null;
	if (range && !span) {
		headers.set("Content-Range", `bytes */${details.fileSize}`);
		return new Response(null, { status: 416, headers });
	}
	const blob = await ctx.storage.get(storageId);
	if (!blob) return reply({ code: "ATTACHMENT_NOT_FOUND" }, 404);
	if (span) {
		const { start, end } = span;
		headers.set("Content-Range", `bytes ${start}-${end}/${details.fileSize}`);
		headers.set("Content-Length", String(end - start + 1));
		return new Response(blob.slice(start, end + 1), { status: 206, headers });
	}
	headers.set("Content-Length", String(details.fileSize));
	return new Response(blob.stream(), { headers });
}

const maxMultipartSize = maxSize + 64 * 1024;

export async function legacyAttachmentRequest(
	ctx: ActionCtx,
	request: Request,
	noteId: string,
	apiTokenHash?: string,
	key?: string,
	importing = false,
) {
	if (!apiTokenHash) return reply({ code: "UNAUTHENTICATED" }, 401);
	if (
		(request.method === "GET" && key === undefined) ||
		(request.method === "PATCH" && key === "reorder")
	)
		return attachmentListOrOrder(ctx, request, noteId, apiTokenHash);
	if (key && request.method === "GET")
		return serveAttachment(
			ctx,
			request,
			{ noteId, attachmentId: key, apiTokenHash },
			"inline",
		);
	if (key && request.method === "DELETE")
		return removeAttachment(ctx, { noteId, attachmentId: key, apiTokenHash });
	if (key !== undefined || request.method !== "POST")
		return reply({ code: "ATTACHMENT_NOT_FOUND" }, 404);
	const ids = { noteId, attachmentId: crypto.randomUUID(), apiTokenHash };
	const target = await ctx.runQuery(internal.attachments.lookup, {
		...ids,
		write: true,
		importing,
	});
	if (!target.allowed) {
		const codes = {
			400: "NOTE_NOT_ACTIVE",
			401: "UNAUTHENTICATED",
			403: "NOTE_READ_ONLY",
			404: "ATTACHMENT_NOT_FOUND",
		} as const;
		return reply({ code: codes[target.status] }, target.status);
	}
	const type = request.headers.get("content-type") ?? "";
	if (!/^multipart\/form-data\s*;/i.test(type) || !request.body)
		return reply({ code: "INVALID_ATTACHMENT" }, 400);
	if (Number(request.headers.get("content-length")) > maxMultipartSize)
		return reply({ code: "ATTACHMENT_TOO_LARGE" }, 413);
	const body = await request.blob();
	if (body.size > maxMultipartSize)
		return reply({ code: "ATTACHMENT_TOO_LARGE" }, 413);
	const stagedId = await ctx.storage.store(
		body.slice(0, body.size, storageContentType),
	);
	try {
		const downloadUrl = await ctx.storage.getUrl(stagedId);
		if (!downloadUrl) return reply({ code: "ATTACHMENT_UPLOAD_RETRY" }, 503);
		const result = await ctx.runAction(
			internal.attachmentActions.decodeMultipart,
			{ downloadUrl, uploadUrl: await ctx.storage.generateUploadUrl(), type, importing },
		);
		if (!("file" in result)) return reply({ code: result.code }, result.status);
		return finalizeUpload(ctx, ids, result.file);
	} finally {
		await ctx.storage.delete(stagedId);
	}
}

function byteRange(range: string, size: number) {
	const match = /^bytes=(\d*)-(\d*)$/i.exec(range);
	if (!match || (!match[1] && !match[2])) return null;
	const last = size - 1;
	if (!match[1]) {
		const suffix = Number(match[2]);
		return suffix > 0 ? { start: Math.max(0, size - suffix), end: last } : null;
	}
	const start = Number(match[1]);
	const end = match[2] ? Math.min(Number(match[2]), last) : last;
	return start <= end ? { start, end } : null;
}
