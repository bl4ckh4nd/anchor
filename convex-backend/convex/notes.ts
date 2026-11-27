import { paginationOptsValidator, type UserIdentity } from "convex/server";
import { ConvexError, type Infer, v } from "convex/values";
import { generateNKeysBetween } from "fractional-indexing";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { releaseAttachmentBlob } from "./attachmentStorage";
import { legacyImportInProgress } from "./importState";
import {
	action,
	type ActionCtx,
	internalMutation,
	internalQuery,
	mutation,
	type MutationCtx,
	query,
	type QueryCtx,
} from "./_generated/server";
import { noteState, reminderRecurrence, sharePermission } from "./schema";
import {
	legacyReadIdentity,
	accountFor,
	authorizedIdentity,
	contactView,
	nativeAuthEnabled,
} from "./sessions";

import {
	applyTag,
	legacyTagView,
	noteTagIds,
	ownedTagRefs,
	setNoteTagAssignment,
	setNoteTags,
	tagById,
	tagChange,
	type TagPushResult,
	tagView,
	writeNoteTagRefs,
} from "./tags";

type Permission = "owner" | Doc<"noteShares">["permission"];
type NoteIdentity = Pick<UserIdentity, "issuer" | "subject">;

export async function requireIdentity(ctx: QueryCtx | ActionCtx) {
	const identity = await authorizedIdentity(ctx);
	if (!identity) throw new ConvexError("UNAUTHENTICATED");
	return identity;
}

export function noteById(ctx: QueryCtx, id: string) {
	return ctx.db
		.query("notes")
		.withIndex("by_note_id", (q) => q.eq("id", id))
		.unique();
}

function shareBySubject(
	ctx: QueryCtx,
	noteId: Doc<"notes">["_id"],
	subject: string,
) {
	return ctx.db
		.query("noteShares")
		.withIndex("by_note_subject", (q) =>
			q.eq("noteId", noteId).eq("subject", subject),
		)
		.unique();
}

export async function noteAccess(
	ctx: QueryCtx,
	identity: Pick<UserIdentity, "issuer" | "subject">,
	note: Doc<"notes">,
): Promise<Permission | null> {
	if (note.issuer !== identity.issuer || note.state === "deleted") return null;
	if (note.owner === identity.subject) return "owner";
	if (nativeAuthEnabled() && !(await accountFor(ctx, note.issuer, note.owner)))
		return null;
	const share = await shareBySubject(ctx, note._id, identity.subject);
	return share && !share.isRevoked ? share.permission : null;
}

function activeShares(ctx: QueryCtx, noteId: Doc<"notes">["_id"]) {
	return ctx.db
		.query("noteShares")
		.withIndex("by_note_subject", (q) => q.eq("noteId", noteId))
		.filter((q) => q.neq(q.field("isRevoked"), true))
		.collect();
}

export function feedHead(ctx: QueryCtx, issuer: string, subject: string) {
	return ctx.db
		.query("noteFeedHeads")
		.withIndex("by_recipient", (q) =>
			q.eq("issuer", issuer).eq("subject", subject),
		)
		.unique();
}

export function recordChange(
	ctx: MutationCtx,
	note: Pick<Doc<"notes">, "_id" | "issuer" | "id">,
	subject: string,
	op: Doc<"noteFeed">["op"],
	entityType?: "pin" | "reminder",
) {
	return recordFeed(ctx, {
		issuer: note.issuer,
		subject,
		noteId: note._id,
		entityId: note.id,
		entityType,
		op,
	});
}

async function recordFeed(
	ctx: MutationCtx,
	change: Omit<Doc<"noteFeed">, "_id" | "_creationTime" | "seq">,
) {
	const { issuer, subject } = change;
	const head = await feedHead(ctx, issuer, subject);
	const seq = (head?.lastSeq ?? 0n) + 1n;
	if (head) {
		await ctx.db.patch("noteFeedHeads", head._id, { lastSeq: seq });
	} else {
		await ctx.db.insert("noteFeedHeads", {
			issuer: issuer,
			subject,
			lastSeq: seq,
		});
	}
	await ctx.db.insert("noteFeed", { ...change, seq });
}

export function recordTagChange(
	ctx: MutationCtx,
	{ issuer, subject }: NoteIdentity,
	id: string,
	op: "upsert" | "remove",
) {
	return recordFeed(ctx, {
		issuer,
		subject,
		entityId: id,
		entityType: "tag",
		op,
	});
}

function archiveFor(
	ctx: QueryCtx,
	noteId: Doc<"notes">["_id"],
	subject: string,
) {
	return ctx.db
		.query("noteArchives")
		.withIndex("by_note_subject", (q) =>
			q.eq("noteId", noteId).eq("subject", subject),
		)
		.unique();
}

async function setArchive(
	ctx: MutationCtx,
	noteId: Doc<"notes">["_id"],
	subject: string,
	archived?: boolean,
) {
	if (archived === undefined) return false;
	const previous = await archiveFor(ctx, noteId, subject);
	if (archived && !previous) {
		await ctx.db.insert("noteArchives", { noteId, subject });
		return true;
	}
	if (!archived && previous) {
		await ctx.db.delete("noteArchives", previous._id);
		return true;
	}
	return false;
}

function pinFor(ctx: QueryCtx, noteId: Doc<"notes">["_id"], subject: string) {
	return ctx.db
		.query("notePins")
		.withIndex("by_note_subject", (q) =>
			q.eq("noteId", noteId).eq("subject", subject),
		)
		.unique();
}

async function setPin(
	ctx: MutationCtx,
	noteId: Doc<"notes">["_id"],
	subject: string,
	pinned: boolean,
) {
	const existing = await pinFor(ctx, noteId, subject);
	if (pinned && !existing) {
		await ctx.db.insert("notePins", { noteId, subject });
		return true;
	}
	if (!pinned && existing) {
		await ctx.db.delete("notePins", existing._id);
		return true;
	}
	return false;
}

export const reminderWallClock = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

function reminderFor(
	ctx: QueryCtx,
	noteId: Doc<"notes">["_id"],
	subject: string,
) {
	return ctx.db
		.query("noteReminders")
		.withIndex("by_note_subject", (q) =>
			q.eq("noteId", noteId).eq("subject", subject),
		)
		.unique();
}

function reminderView(
	reminder: Doc<"noteReminders"> | null,
) {
	if (reminder?.remindAt == null) return null;
	return {
		remindAt: reminder.remindAt,
		recurrence: reminder.recurrence,
		version: reminder.version,
	};
}

async function clearReminder(
	ctx: MutationCtx,
	reminder: Doc<"noteReminders"> | null,
) {
	if (reminder?.remindAt != null) {
		await ctx.db.patch("noteReminders", reminder._id, {
			remindAt: null,
			recurrence: "none",
			version: reminder.version + 1,
		});
	}
}

export const maxPositionsPerRequest = 500;
export const orderKeyPattern = /^[0-9A-Za-z]{1,128}$/;

function positionFor(
	ctx: QueryCtx,
	noteId: Doc<"notes">["_id"],
	subject: string,
) {
	return ctx.db
		.query("notePositions")
		.withIndex("by_note_subject", (q) =>
			q.eq("noteId", noteId).eq("subject", subject),
		)
		.unique();
}

async function setNotePosition(
	ctx: MutationCtx,
	noteId: Doc<"notes">["_id"],
	subject: string,
	position: string | null,
) {
	const current = await positionFor(ctx, noteId, subject);
	if ((current?.position ?? null) === position) return false;
	if (position === null) {
		if (current) await ctx.db.delete("notePositions", current._id);
	} else if (current) {
		await ctx.db.patch("notePositions", current._id, { position });
	} else {
		await ctx.db.insert("notePositions", { noteId, subject, position });
	}
	return true;
}

const placeArgs = v.object({
	kind: v.union(v.literal("note"), v.literal("tag")),
	positions: v.array(
		v.object({ id: v.string(), position: v.union(v.string(), v.null()) }),
	),
});

async function placeFor(
	ctx: MutationCtx,
	identity: NoteIdentity,
	{ kind, positions }: Infer<typeof placeArgs>,
) {
	const { issuer, subject } = identity;
	if (
		positions.length > maxPositionsPerRequest ||
		positions.some(
			({ id, position }) =>
				!id || (position !== null && !orderKeyPattern.test(position)),
		)
	) {
		throw new ConvexError("INVALID_POSITIONS");
	}
	const updated: string[] = [];
	for (const [id, position] of new Map(
		positions.map((change) => [change.id, change.position]),
	)) {
		if (kind === "note") {
			const note = await noteById(ctx, id);
			if (!note || !(await noteAccess(ctx, identity, note))) continue;
			if (!(await setNotePosition(ctx, note._id, subject, position))) continue;
			await recordChange(ctx, note, subject, "upsert");
		} else {
			const tag = await tagById(ctx, id);
			if (
				!tag ||
				tag.issuer !== issuer ||
				tag.owner !== subject ||
				tag.isDeleted ||
				tag.position === position
			)
				continue;
			await ctx.db.patch("tags", tag._id, { position });
			await recordTagChange(ctx, identity, id, "upsert");
		}
		updated.push(id);
	}
	return { updated };
}

export const place = mutation({
	args: placeArgs,
	handler: async (ctx, input) =>
		placeFor(ctx, await requireIdentity(ctx), input),
});

export const legacyPlace = internalMutation({
	args: { ...placeArgs.fields, apiTokenHash: v.optional(v.string()) },
	handler: async (ctx, { apiTokenHash, ...input }) => {
		const identity = await legacyReadIdentity(ctx, apiTokenHash);
		return identity ? placeFor(ctx, identity, input) : null;
	},
});

const noteOrderGroup = v.array(v.object({ id: v.string(), position: v.union(v.string(), v.null()) }));

export const moveNote = mutation({
	args: {
		notes: noteOrderGroup,
		otherGroup: v.optional(noteOrderGroup),
		noteId: v.string(),
		step: v.number(),
	},
	handler: async (ctx, { notes, otherGroup = [], noteId, step }) => {
		const identity = await requireIdentity(ctx);
		const { subject } = identity;
		const from = notes.findIndex(({ id }) => id === noteId);
		const to = from + step;
		const snapshots = [...notes, ...otherGroup];
		if (
			!Number.isInteger(step) || step === 0 || from < 0 || to < 0 || to >= notes.length ||
			snapshots.length > maxPositionsPerRequest ||
			new Set(snapshots.map(({ id }) => id)).size !== snapshots.length
		) return false;

		let pinned: boolean | undefined;
		for (const [index, snapshot] of snapshots.entries()) {
			const note = await noteById(ctx, snapshot.id);
			if (!note || (note.state ?? "active") !== "active" ||
				!(await noteAccess(ctx, identity, note)) || await archiveFor(ctx, note._id, subject))
				return false;
			const isPinned = (await pinFor(ctx, note._id, subject)) !== null;
			pinned ??= isPinned;
			if (isPinned !== (index < notes.length ? pinned : !pinned) ||
				(await positionFor(ctx, note._id, subject))?.position !== (snapshot.position ?? undefined))
				return false;
		}

		const [moved] = notes.splice(from, 1);
		notes.splice(to, 0, moved);
		const positions = [notes, otherGroup].flatMap((group) => {
			const keys = newOrderKeys(group.map(({ id, position }) => id === noteId ? null : position));
			return group.flatMap(({ id, position }, index) =>
				keys[index] === position ? [] : [{ id, position: keys[index] }],
			);
		});
		await placeFor(ctx, identity, {
			kind: "note",
			positions,
		});
		return true;
	},
});

function newOrderKeys(keys: (string | null)[]): string[] {
	try {
		let previous: string | null = null;
		for (let start = 0; start < keys.length;) {
			const key = keys[start];
			if (key !== null) {
				if (previous !== null && previous >= key) throw new Error("Overlapping positions");
				previous = key;
				start++;
				continue;
			}
			let end = start + 1;
			while (end < keys.length && keys[end] === null) end++;
			const next = keys[end] ?? null;
			const placed = generateNKeysBetween(previous, next, end - start);
			placed.forEach((key, index) => { keys[start + index] = key; });
			previous = placed.at(-1) ?? previous;
			start = end;
		}
		if (!keys.every((key): key is string => key !== null && orderKeyPattern.test(key)))
			throw new Error("Position exceeds server limits");
		return keys;
	} catch {
		return generateNKeysBetween(null, null, keys.length);
	}
}

export const legacyWriteTag = internalMutation({
	args: {
		method: v.union(v.literal("POST"), v.literal("PATCH"), v.literal("DELETE")),
		id: v.string(),
		name: v.optional(v.string()),
		color: v.optional(v.union(v.string(), v.null())),
		baseVersion: v.optional(v.number()),
		apiTokenHash: v.optional(v.string()),
	},
	handler: async (
		ctx,
		{ apiTokenHash, method, id, name, color, baseVersion },
	) => {
		const identity = await legacyReadIdentity(ctx, apiTokenHash);
		if (!identity) return { status: 401, body: { code: "UNAUTHENTICATED" } };
		const existing = await tagById(ctx, id);
		if (method === "POST") {
			if (existing) return { status: 409, body: { code: "TAG_ID_CONFLICT" } };
		} else if (
			!existing ||
			existing.isDeleted ||
			existing.issuer !== identity.issuer ||
			existing.owner !== identity.subject
		) {
			return {
				status: 404,
				body: { code: "TAG_NOT_FOUND", message: "Tag not found" },
			};
		}
		if (
			existing &&
			baseVersion !== undefined &&
			baseVersion !== existing.version
		) {
			return {
				status: 409,
				body: {
					code: "TAG_CHANGED",
					message: "Tag was changed by someone else",
					serverTag: legacyTagView(existing),
				},
			};
		}
		const nextName = name ?? existing?.name;
		if (nextName === undefined)
			return { status: 400, body: { code: "INVALID_TAG" } };
		const { result, op } = await applyTag(ctx, identity, {
			type: "tag",
			id,
			name: nextName,
			color,
			baseVersion: existing?.version,
			isDeleted: method === "DELETE",
		});
		if (result.status === "conflict")
			return {
				status: 409,
				body: {
					code: "TAG_NAME_EXISTS",
					message: "A tag with this name already exists",
				},
			};
		if (result.status !== "applied") throw new Error("Tag write failed");
		if (op) await recordTagChange(ctx, identity, id, op);
		const tag = await tagById(ctx, id);
		if (!tag) throw new Error("Tag write missing");
		return { status: method === "POST" ? 201 : 200, body: legacyTagView(tag) };
	},
});

export function attachmentView(
	noteId: string,
	attachment: Doc<"noteAttachments">,
) {
	return {
		id: attachment.id,
		noteId,
		type: attachment.mimeType.startsWith("image/") ? "image" : "audio",
		originalFilename: attachment.originalFilename,
		mimeType: attachment.mimeType,
		fileSize: attachment.fileSize,
		uploadedByUserId: attachment.uploadedByUserId,
		createdAt: new Date(
			attachment.createdAt ?? attachment._creationTime,
		).toISOString(),
	};
}

export async function orderedAttachments(
	ctx: QueryCtx,
	noteId: Doc<"notes">["_id"],
) {
	const rows = await ctx.db
		.query("noteAttachments")
		.withIndex("by_note_deleted_at", (q) =>
			q.eq("noteId", noteId).eq("deletedAt", undefined),
		)
		.order("desc")
		.collect();
	return rows
		.map((attachment, index) => ({
			attachment,
			position: attachment.position ?? index,
		}))
		.sort((a, b) => a.position - b.position);
}

async function view(
	ctx: QueryCtx,
	note: Pick<
		Doc<"notes">,
		| "_id"
		| "issuer"
		| "id"
		| "title"
		| "content"
		| "version"
		| "_creationTime"
		| "createdAt"
		| "updatedAt"
		| "state"
		| "background"
	>,
	permission: Permission,
	subject: string,
) {
	const reminder = await reminderFor(ctx, note._id, subject);
	const attachments = await orderedAttachments(ctx, note._id);
	return {
		...(attachments.length
			? {
					attachments: attachments.map(({ attachment }) =>
						attachmentView(note.id, attachment),
					),
				}
			: {}),
		reminder: reminderView(reminder),
		id: note.id,
		tagIds: await noteTagIds(ctx, note, subject),
		position: (await positionFor(ctx, note._id, subject))?.position ?? null,
		isArchived: (await archiveFor(ctx, note._id, subject)) !== null,
		isPinned: (await pinFor(ctx, note._id, subject)) !== null,
		title: note.title,
		content: note.content,
		state: note.state ?? "active",
		background: note.background ?? null,
		version: note.version,
		createdAt: note.createdAt ?? note._creationTime,
		updatedAt: note.updatedAt,
		permission,
	};
}

const noteUuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export const trashRetentionMs = 30 * 24 * 60 * 60 * 1000;

async function insertNote(
	ctx: MutationCtx,
	identity: NoteIdentity,
	args: {
		id: string;
		title: string;
		content?: string | null;
		state?: Infer<typeof noteState>;
		background?: string | null;
		createdAt?: string;
	},
	importedTimes?: { createdAt?: number; updatedAt?: number },
) {
	const now = Date.now();
	const note = {
		id: args.id,
		issuer: identity.issuer,
		owner: identity.subject,
		title: args.title,
		content: args.content ?? null,
		state: args.state ?? "active",
		background: args.background ?? null,
		createdAt: importedTimes?.createdAt ??
			(args.createdAt ? Math.min(Date.parse(args.createdAt), now) : now),
		stateChangedAt: now,
		version: 1,
		updatedAt: importedTimes?.updatedAt ?? now,
	};
	const id = await ctx.db.insert("notes", note);
	await recordChange(
		ctx,
		{ ...note, _id: id },
		note.owner,
		note.state === "deleted" ? "remove" : "upsert",
	);
	return { ...note, _id: id, _creationTime: now };
}

export const create = mutation({
	args: {
		id: v.string(),
		title: v.string(),
		content: v.optional(v.string()),
		background: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const identity = await requireIdentity(ctx);
		if (!noteUuid.test(args.id)) {
			throw new ConvexError("INVALID_NOTE_ID");
		}
		const existing = await noteById(ctx, args.id);
		if (existing) {
			if (
				existing.state === "deleted" ||
				existing.issuer !== identity.issuer ||
				existing.owner !== identity.subject
			) {
				throw new ConvexError("NOTE_ID_CONFLICT");
			}
			return view(ctx, existing, "owner", identity.subject);
		}
		return view(
			ctx,
			await insertNote(ctx, identity, args),
			"owner",
			identity.subject,
		);
	},
});

export const get = query({
	args: { id: v.string() },
	handler: async (ctx, { id }) => {
		const identity = await requireIdentity(ctx);
		const note = await noteById(ctx, id);
		if (!note) return null;
		const permission = await noteAccess(ctx, identity, note);
		return permission ? view(ctx, note, permission, identity.subject) : null;
	},
});

async function legacyNoteView(
	ctx: QueryCtx,
	note: Doc<"notes">,
	permission: Permission,
	identity: Pick<UserIdentity, "issuer" | "subject">,
	projection?: Awaited<ReturnType<typeof view>>,
) {
	const {
		attachments = [],
		updatedAt,
		...summary
	} = projection ?? (await view(ctx, note, permission, identity.subject));
	const share =
		permission === "owner"
			? null
			: await shareBySubject(ctx, note._id, identity.subject);
	const sharer =
		share &&
		(await accountFor(
			ctx,
			identity.issuer,
			share.sharedByUserId ?? note.owner,
		));
	const ownShares =
		permission === "owner" ? await activeShares(ctx, note._id) : null;
	return {
		...summary,
		userId: note.owner,
		createdAt: new Date(note.createdAt ?? note._creationTime).toISOString(),
		updatedAt: new Date(updatedAt).toISOString(),
		...(note.state === "trashed"
			? {
					stateChangedAt: new Date(
						note.stateChangedAt ?? updatedAt,
					).toISOString(),
				}
			: {}),
		attachmentCount: attachments.length,
		imagePreviewIds: attachments
			.filter((item) => item.type === "image")
			.slice(0, 4)
			.map((item) => item.id),
		...(ownShares
			? {
					shareIds: ownShares.map((row) => row.legacyId ?? row._id),
				}
			: {}),
		...(sharer
			? {
					sharedBy: {
						id: sharer.id,
						name: sharer.name,
						email: sharer.email,
						profileImage: sharer.profileImage,
					},
				}
			: {}),
	};
}

async function feedNoteView(
	ctx: QueryCtx,
	note: Doc<"notes">,
	permission: Permission,
	identity: NoteIdentity,
	legacy: boolean,
) {
	const projection = await view(ctx, note, permission, identity.subject);
	if (!legacy) return projection;
	return {
		...(await legacyNoteView(ctx, note, permission, identity, projection)),
		attachments: (projection.attachments ?? []).map((attachment, position) => ({
			...attachment,
			position,
		})),
	};
}

export const legacyDetail = internalQuery({
	args: { id: v.string(), apiTokenHash: v.optional(v.string()) },
	handler: async (ctx, { id, apiTokenHash }) => {
		const identity = await legacyReadIdentity(ctx, apiTokenHash);
		if (!identity) return { type: "unauthenticated" } as const;
		const note = await noteById(ctx, id);
		const permission = note && (await noteAccess(ctx, identity, note));
		if (!note || !permission) return { type: "missing" } as const;
		return {
			type: "note",
			note: await legacyNoteView(ctx, note, permission, identity),
		} as const;
	},
});

export const legacyDuplicate = internalMutation({
	args: {
		id: v.string(),
		copyId: v.string(),
		withUndo: v.optional(v.boolean()),
		apiTokenHash: v.optional(v.string()),
	},
	handler: async (ctx, { id, copyId, withUndo, apiTokenHash }) => {
		const identity = await legacyReadIdentity(ctx, apiTokenHash);
		if (!identity) return { status: 401, body: { code: "UNAUTHENTICATED" } };
		const source = await noteById(ctx, id);
		if (
			!source ||
			(source.state ?? "active") !== "active" ||
			!(await noteAccess(ctx, identity, source))
		)
			return { status: 404, body: { code: "NOTE_NOT_FOUND" } };
		if (await noteById(ctx, copyId))
			return { status: 409, body: { code: "NOTE_ID_CONFLICT" } };
		const attachments = await orderedAttachments(ctx, source._id);
		for (const { attachment } of attachments) {
			if (!(await ctx.db.system.get("_storage", attachment.storageId)))
				return { status: 404, body: { code: "ATTACHMENT_NOT_FOUND" } };
		}
		const copy = await insertNote(ctx, identity, {
			id: copyId,
			title: source.title,
			content: source.content,
			background: source.background,
		});
		const { subject } = identity;
		await setNoteTags(
			ctx,
			copy,
			subject,
			await noteTagIds(ctx, source, subject),
		);
		for (const { attachment, position } of attachments) {
			await ctx.db.insert("noteAttachments", {
				id: crypto.randomUUID(),
				noteId: copy._id,
				uploadedByUserId: subject,
				storageId: attachment.storageId,
				originalFilename: attachment.originalFilename,
				mimeType: attachment.mimeType,
				fileSize: attachment.fileSize,
				position,
			});
		}
		const body = await legacyNoteView(ctx, copy, "owner", identity);
		const head = withUndo ? await feedHead(ctx, copy.issuer, copy.owner) : null;
		if (head) await ctx.db.patch("notes", copy._id, { copyUndoSequence: head.lastSeq });
		return {
			status: 201,
			body: head ? { ...body, undoSequence: head.lastSeq.toString() } : body,
		};
	},
});

export const undoNoteCopy = internalMutation({
	args: { id: v.string(), baseSequence: v.int64(), apiTokenHash: v.optional(v.string()) },
	handler: async (ctx, { id, baseSequence, apiTokenHash }) => {
		const identity = await legacyReadIdentity(ctx, apiTokenHash);
		if (!identity) return { status: 401, body: { code: "UNAUTHENTICATED" } };
		const note = await noteById(ctx, id);
		if (!note || note.issuer !== identity.issuer || note.owner !== identity.subject)
			return { status: 404, body: { code: "NOTE_NOT_FOUND" } };
		if (note.copyUndoSequence !== baseSequence)
			return { status: 409, body: { code: "NOTE_CHANGED" } };
		if (note.state === "deleted") return { status: 200, body: { success: true } };

		const latest = await ctx.db
			.query("noteFeed")
			.withIndex("by_recipient_note_seq", (q) =>
				q.eq("issuer", note.issuer).eq("subject", note.owner).eq("noteId", note._id),
			)
			.order("desc")
			.first();
		const head = await feedHead(ctx, note.issuer, note.owner);
		if ((note.state ?? "active") !== "active" || latest?.seq !== baseSequence ||
			baseSequence < (head?.prunedThroughSeq ?? 0n) ||
			(await activeShares(ctx, note._id)).length !== 0)
			return { status: 409, body: { code: "NOTE_CHANGED" } };
		await writeNoteUpdate(ctx, note, "owner", identity.subject, { state: "deleted" });
		return { status: 200, body: { success: true } };
	},
});

const legacyNoteFields = v.object({
	content: v.optional(v.union(v.string(), v.null())),
	background: v.optional(v.union(v.string(), v.null())),
	isPinned: v.optional(v.boolean()),
	isArchived: v.optional(v.boolean()),
	tagIds: v.optional(v.array(v.string())),
	reminder: v.optional(
		v.union(
			v.null(),
			v.object({
				remindAt: v.string(),
				recurrence: v.optional(reminderRecurrence),
			}),
		),
	),
});

async function applyLegacyPersonalFields(
	ctx: MutationCtx,
	note: Doc<"notes">,
	identity: NoteIdentity,
	args: Infer<typeof legacyNoteFields>,
) {
	const { subject } = identity;
	const archiveChanged = await setArchive(
		ctx,
		note._id,
		subject,
		args.isArchived,
	);
	const tagsChanged = await setNoteTags(ctx, note, subject, args.tagIds);
	if (archiveChanged || tagsChanged)
		await recordChange(ctx, note, subject, "upsert");
	if (
		args.isPinned !== undefined &&
		(await setPin(ctx, note._id, subject, args.isPinned))
	)
		await recordChange(
			ctx,
			note,
			subject,
			args.isPinned ? "upsert" : "remove",
			"pin",
		);
	if (args.reminder !== undefined)
		await applyReminder(
			ctx,
			note,
			identity,
			{
				type: "reminder",
				id: note.id,
				remindAt: args.reminder?.remindAt ?? null,
				recurrence: args.reminder?.recurrence,
			},
			false,
		);
}

export const legacyCreate = internalMutation({
	args: {
		...legacyNoteFields.fields,
		id: v.string(),
		title: v.string(),
		apiTokenHash: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const identity = await legacyReadIdentity(ctx, args.apiTokenHash);
		if (!identity) return { status: 401, body: { code: "UNAUTHENTICATED" } };
		const existing = await noteById(ctx, args.id);
		if (
			existing &&
			(existing.issuer !== identity.issuer ||
				existing.owner !== identity.subject ||
				existing.state === "deleted")
		)
			return { status: 409, body: { code: "NOTE_ID_CONFLICT" } };
		const note = existing ?? (await insertNote(ctx, identity, args));
		if (!existing) await applyLegacyPersonalFields(ctx, note, identity, args);
		return {
			status: 201,
			body: await legacyNoteView(ctx, note, "owner", identity),
		};
	},
});

export const importTagPalette = internalMutation({
	args: {
		apiTokenHash: v.string(),
		tags: v.array(v.object({ id: v.string(), name: v.string(), color: v.optional(v.string()) })),
	},
	handler: async (ctx, { apiTokenHash, tags }) => {
		const identity = await legacyReadIdentity(ctx, apiTokenHash);
		if (!identity) return null;
		const results: { name: string; id: string; created: boolean }[] = [];
		for (const tag of tags) {
			const result = await applyTag(ctx, identity, { ...tag, type: "tag" });
			if (result.result.status === "conflict") {
				results.push({ name: tag.name, id: result.result.serverCopy.id, created: false });
			} else {
				if (result.op !== "upsert") throw new Error("Could not import tag");
				await recordTagChange(ctx, identity, tag.id, result.op);
				results.push({ name: tag.name, id: tag.id, created: true });
			}
		}
		return results;
	},
});

export const importLibraryNote = internalMutation({
	args: {
		...legacyNoteFields.fields,
		apiTokenHash: v.string(),
		preferredId: v.optional(v.string()),
		newId: v.string(),
		title: v.string(),
		isTrashed: v.optional(v.boolean()),
		createdAt: v.optional(v.number()),
		updatedAt: v.optional(v.number()),
	},
	handler: async (ctx, {
		apiTokenHash, preferredId, newId, isTrashed, createdAt, updatedAt, ...fields
	}) => {
		const identity = await legacyReadIdentity(ctx, apiTokenHash);
		if (!identity) return null;
		const existing = preferredId ? await noteById(ctx, preferredId) : null;
		if (existing && existing.issuer === identity.issuer &&
			existing.owner === identity.subject && existing.state !== "deleted") {
			return { status: "skipped", noteId: existing.id } as const;
		}
		const id = existing ? newId : (preferredId ?? newId);
		const note = await insertNote(ctx, identity, {
			id,
			...fields,
			state: isTrashed ? "trashed" : "active",
		}, { createdAt, updatedAt });
		await applyLegacyPersonalFields(ctx, note, identity, fields);
		return { status: existing ? "remapped" : "created", noteId: id } as const;
	},
});

export const legacyPatch = internalMutation({
	args: {
		...legacyNoteFields.fields,
		id: v.string(),
		title: v.optional(v.string()),
		baseVersion: v.optional(v.number()),
		replacesOtherEdit: v.optional(v.boolean()),
		tagAssignment: v.optional(v.object({ id: v.string(), assigned: v.boolean() })),
		apiTokenHash: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const identity = await legacyReadIdentity(ctx, args.apiTokenHash);
		if (!identity) return { status: 401, body: { code: "UNAUTHENTICATED" } };
		const note = await noteById(ctx, args.id);
		const permission = note && (await noteAccess(ctx, identity, note));
		if (!note || !permission)
			return { status: 404, body: { code: "NOTE_NOT_FOUND" } };
		if (
			permission === "viewer" &&
			(args.title !== undefined ||
				args.content !== undefined ||
				args.background !== undefined)
		)
			return { status: 403, body: { code: "NOTE_READ_ONLY" } };
		if (args.baseVersion !== undefined && args.baseVersion !== note.version) {
			const title = args.title ?? note.title;
			if (
				title !== note.title ||
				(args.content !== undefined && args.content !== note.content)
			) {
				await keepRejectedDraft(ctx, note, identity.subject, {
					title,
					content: args.content,
					baseVersion: args.baseVersion,
				});
				await recordNoteUpdate(ctx, note);
			}
			return {
				status: 409,
				body: {
					message: "Note was changed by someone else",
					serverNote: await legacyNoteView(ctx, note, permission, identity),
				},
			};
		}
		if (args.tagAssignment) {
			const { id, assigned } = args.tagAssignment;
			const changed = await setNoteTagAssignment(
				ctx, note, identity.subject, id, assigned,
			);
			if (changed === null)
				return { status: 404, body: { code: "TAG_NOT_FOUND" } };
			if (changed) await recordChange(ctx, note, identity.subject, "upsert");
		}
		const updated =
			permission === "viewer"
				? note
				: await writeNoteUpdate(ctx, note, permission, identity.subject, args);
		await applyLegacyPersonalFields(ctx, updated, identity, args);
		return {
			status: 200,
			body: await legacyNoteView(ctx, updated, permission, identity),
		};
	},
});

export const legacyChangeState = internalMutation({
	args: {
		id: v.string(),
		action: v.union(
			v.literal("trash"),
			v.literal("restore"),
			v.literal("permanent"),
		),
		trashedAt: v.optional(v.number()),
		apiTokenHash: v.optional(v.string()),
	},
	handler: async (ctx, { id, action, trashedAt, apiTokenHash }) => {
		const identity = await legacyReadIdentity(ctx, apiTokenHash);
		if (!identity) return { status: 401, body: { code: "UNAUTHENTICATED" } };
		const note = await noteById(ctx, id);
		if (!note || note.issuer !== identity.issuer)
			return { status: 404, body: { code: "NOTE_NOT_FOUND" } };
		const isOwner = note.owner === identity.subject;
		if (!isOwner && action !== "trash")
			return { status: 403, body: { code: "NOTE_OWNER_REQUIRED" } };
		if (action === "trash" && !(await noteAccess(ctx, identity, note)))
			return { status: 404, body: { code: "NOTE_NOT_FOUND" } };
		if (!isOwner) {
			await leaveLegacyShare(ctx, note, identity.subject);
			return { status: 200, body: { success: true } };
		}
		if (action === "restore" && note.state !== "trashed")
			return { status: 404, body: { code: "NOTE_NOT_TRASHED" } };
		const now = Date.now();
		const next = await writeNoteUpdate(ctx, note, "owner", identity.subject, {
			state:
				action === "trash"
					? "trashed"
					: action === "restore"
						? "active"
						: "deleted",
			stateChangedAt:
				trashedAt === undefined
					? now
					: Math.min(now, Math.max(now - trashRetentionMs, trashedAt)),
		});
		return {
			status: 200,
			body: await legacyNoteView(ctx, next, "owner", identity),
		};
	},
});

const legacyBulkChange = v.union(
	v.object({ action: v.literal("archive") }),
	v.object({ action: v.literal("delete") }),
	v.object({ action: v.literal("pin"), isPinned: v.boolean() }),
	v.object({ action: v.literal("tags"), tagIds: v.array(v.string()) }),
);

export const legacyBulkNotes = internalMutation({
	args: {
		noteIds: v.array(v.string()),
		change: legacyBulkChange,
		apiTokenHash: v.optional(v.string()),
	},
	handler: async (ctx, { noteIds, change, apiTokenHash }) => {
		const identity = await legacyReadIdentity(ctx, apiTokenHash);
		if (!identity) return null;
		const { issuer, subject } = identity;
		const tagRefs =
			change.action === "tags"
				? await ownedTagRefs(ctx, issuer, subject, change.tagIds)
				: [];
		if (change.action === "tags" && tagRefs.length === 0) return { count: 0 };
		let count = 0;
		for (const id of noteIds) {
			const note = await noteById(ctx, id);
			const permission = note && (await noteAccess(ctx, identity, note));
			if (!note || !permission) continue;
			count++;
			switch (change.action) {
				case "delete":
					if (permission === "owner")
						await writeNoteUpdate(ctx, note, "owner", subject, {
							state: "trashed",
						});
					else await leaveLegacyShare(ctx, note, subject);
					break;
				case "archive":
					if (await setArchive(ctx, note._id, subject, true))
						await recordChange(ctx, note, subject, "upsert");
					break;
				case "pin":
					if (await setPin(ctx, note._id, subject, change.isPinned))
						await recordChange(
							ctx,
							note,
							subject,
							change.isPinned ? "upsert" : "remove",
							"pin",
						);
					break;
				case "tags":
					if (await writeNoteTagRefs(ctx, note._id, subject, tagRefs, true))
						await recordChange(ctx, note, subject, "upsert");
					break;
			}
		}
		return { count };
	},
});

async function leaveLegacyShare(
	ctx: MutationCtx,
	note: Doc<"notes">,
	subject: string,
) {
	await removeShare(ctx, note, subject);
	await recordNoteUpdate(ctx, note);
}

async function librarySourcePage(
	ctx: QueryCtx,
	{ issuer, subject }: NoteIdentity,
	source: "owned" | "shared",
	page: Infer<typeof paginationOptsValidator>,
) {
	const owned =
		source === "owned"
			? await ctx.db
					.query("notes")
					.withIndex("by_owner_id", (q) =>
						q.eq("issuer", issuer).eq("owner", subject),
					)
					.paginate(page)
			: null;
	const shared =
		source === "shared"
			? await ctx.db
					.query("noteShares")
					.withIndex("by_subject", (q) => q.eq("subject", subject))
					.filter((q) => q.neq(q.field("isRevoked"), true))
					.paginate(page)
			: null;
	const notes =
		owned?.page ??
		(await Promise.all(
			(shared?.page ?? []).map((row) => ctx.db.get("notes", row.noteId)),
		));
	const cursor = owned ?? shared;
	if (!cursor) throw new Error("Missing note page");
	return { notes, next: cursor.isDone ? null : cursor.continueCursor };
}

export const exportLibraryUser = internalQuery({
	args: { apiTokenHash: v.string() },
	handler: async (ctx, { apiTokenHash }) => {
		const identity = await legacyReadIdentity(ctx, apiTokenHash);
		if (!identity) return { type: "unauthenticated" } as const;
		const account = await accountFor(ctx, identity.issuer, identity.subject);
		if (!account) return { type: "missing" } as const;
		return {
			type: "user",
			identity,
			user: { id: account.id, email: account.email },
		} as const;
	},
});

export const exportLibraryPage = internalQuery({
	args: {
		apiTokenHash: v.string(),
		source: v.union(v.literal("owned"), v.literal("shared")),
		page: paginationOptsValidator,
	},
	handler: async (ctx, { apiTokenHash, source, page }) => {
		const identity = await legacyReadIdentity(ctx, apiTokenHash);
		if (!identity) return null;
		const { notes, next } = await librarySourcePage(ctx, identity, source, page);
		const rows = [];
		for (const note of notes) {
			if (!note || note.state === "deleted") continue;
			if (source === "shared" && (note.owner === identity.subject || note.state === "trashed")) continue;
			const access = await noteAccess(ctx, identity, note);
			if (!access) continue;
			rows.push({
				note: await legacyNoteView(ctx, note, access, identity),
				media: await Promise.all((await orderedAttachments(ctx, note._id)).map(async ({ attachment, position }) => ({
					...attachmentView(note.id, attachment),
					position,
					downloadUrl: await ctx.storage.getUrl(attachment.storageId),
				}))),
			});
		}
		return { rows, next };
	},
});

export const legacyListPage = internalQuery({
	args: {
		apiTokenHash: v.optional(v.string()),
		source: v.union(v.literal("owned"), v.literal("shared")),
		folder: v.union(
			v.literal("active"),
			v.literal("archive"),
			v.literal("trash"),
			v.literal("count"),
			v.literal("tag"),
		),
		search: v.optional(v.string()),
		tagId: v.optional(v.string()),
		page: paginationOptsValidator,
	},
	handler: async (
		ctx,
		{ apiTokenHash, source, folder, search, tagId, page },
	) => {
		const identity = await legacyReadIdentity(ctx, apiTokenHash);
		if (!identity) return { type: "unauthenticated" } as const;
		const { subject } = identity;
		const { notes, next } = await librarySourcePage(ctx, identity, source, page);
		const rows = [];
		const tags = [];
		const tagNotes = [];
		for (const note of notes) {
			if (!note || (source === "shared" && note.owner === subject)) continue;
			const state = note.state ?? "active";
			if (folder === "trash" ? state !== "trashed" : state !== "active")
				continue;
			const permission = await noteAccess(ctx, identity, note);
			if (!permission) continue;
			if (folder === "count") {
				tags.push(...(await noteTagIds(ctx, note, subject)));
				continue;
			}
			if (folder === "active" || folder === "archive") {
				const archived = Boolean(await archiveFor(ctx, note._id, subject));
				if (archived !== (folder === "archive")) continue;
			}
			if (
				search &&
				!note.title.toLowerCase().includes(search) &&
				!note.content?.toLowerCase().includes(search)
			)
				continue;
			const assigned = tagId ? await noteTagIds(ctx, note, subject) : [];
			if (tagId && !assigned.includes(tagId)) continue;
			if (folder === "tag") {
				const records = await Promise.all(
					assigned.map((id) => tagById(ctx, id)),
				);
				tagNotes.push({
					id: note.id,
					userId: note.owner,
					title: note.title,
					content: note.content,
					background: note.background ?? null,
					state: note.state ?? "active",
					version: note.version,
					createdAt: new Date(
						note.createdAt ?? note._creationTime,
					).toISOString(),
					updatedAt: new Date(note.updatedAt).toISOString(),
					stateChangedAt: new Date(
						note.stateChangedAt ?? note.createdAt ?? note._creationTime,
					).toISOString(),
					tagIds: assigned,
					tags: records.filter((record) => record !== null).map(legacyTagView),
				});
				continue;
			}
			rows.push(await legacyNoteView(ctx, note, permission, identity));
		}
		return {
			type: "page",
			rows,
			tags,
			tagNotes,
			cursor: next,
		} as const;
	},
});

async function removeShare(
	ctx: MutationCtx,
	note: Doc<"notes">,
	subject: string,
) {
	const share = await shareBySubject(ctx, note._id, subject);
	if (share && !share.isRevoked)
		await ctx.db.patch("noteShares", share._id, {
			isRevoked: true,
			updatedAt: Date.now(),
		});
	await setArchive(ctx, note._id, subject, false);
	await setPin(ctx, note._id, subject, false);
	await clearReminder(ctx, await reminderFor(ctx, note._id, subject));
	await setNoteTags(ctx, note, subject, []);
	await setNotePosition(ctx, note._id, subject, null);
	await recordChange(ctx, note, subject, "remove");
}

async function writeShare(
	ctx: MutationCtx,
	note: Doc<"notes">,
	subject: string,
	permission: Doc<"noteShares">["permission"],
	share: Doc<"noteShares"> | null,
) {
	if (share && !share.isRevoked && permission === share.permission)
		return share;
	const now = Date.now();
	const update = {
		permission,
		sharedByUserId: share?.sharedByUserId ?? note.owner,
		updatedAt: now,
	};
	if (share) {
		await ctx.db.patch("noteShares", share._id, {
			...update,
			isRevoked: undefined,
		});
		return { ...share, ...update, isRevoked: undefined };
	}
	const data = { ...update, noteId: note._id, subject, createdAt: now };
	const id = await ctx.db.insert("noteShares", data);
	return { ...data, _id: id, _creationTime: now };
}

export const setShare = mutation({
	args: {
		id: v.string(),
		subject: v.string(),
		permission: v.union(sharePermission, v.null()),
	},
	handler: async (ctx, { id, subject, permission }) => {
		const identity = await requireIdentity(ctx);
		const note = await noteById(ctx, id);
		if (
			!note ||
			note.state === "deleted" ||
			note.issuer !== identity.issuer ||
			note.owner !== identity.subject
		) {
			throw new ConvexError("NOTE_NOT_FOUND");
		}
		if (!subject || subject === note.owner)
			throw new ConvexError("INVALID_SHARE_SUBJECT");
		if (
			permission !== null &&
			nativeAuthEnabled() &&
			!(await accountFor(ctx, note.issuer, subject))
		)
			throw new ConvexError("INVALID_SHARE_SUBJECT");
		const share = await shareBySubject(ctx, note._id, subject);
		if (permission === (share && !share.isRevoked ? share.permission : null))
			return;
		if (permission === null) {
			return removeShare(ctx, note, subject);
		}
		await writeShare(ctx, note, subject, permission, share);
		await recordChange(ctx, note, subject, "upsert");
	},
});

async function legacyShareOwner(
	ctx: QueryCtx,
	id: string,
	apiTokenHash?: string,
) {
	const identity = await legacyReadIdentity(ctx, apiTokenHash);
	if (!identity)
		return { status: 401, body: { code: "UNAUTHENTICATED" } } as const;
	const note = await noteById(ctx, id);
	if (!note || note.issuer !== identity.issuer || note.state === "deleted")
		return { status: 404, body: { code: "NOTE_NOT_FOUND" } } as const;
	if (note.owner !== identity.subject)
		return { status: 403, body: { code: "NOTE_OWNER_REQUIRED" } } as const;
	return { note };
}

function legacyShareView(share: Doc<"noteShares">, recipient: Doc<"accounts">) {
	return {
		id: share.legacyId ?? share._id,
		sharedWithUser: contactView(recipient),
		permission: share.permission,
		createdAt: new Date(share.createdAt ?? share._creationTime).toISOString(),
		updatedAt: new Date(
			share.updatedAt ?? share.createdAt ?? share._creationTime,
		).toISOString(),
	};
}

export const legacyListShares = internalQuery({
	args: { id: v.string(), apiTokenHash: v.optional(v.string()) },
	handler: async (ctx, { id, apiTokenHash }) => {
		const access = await legacyShareOwner(ctx, id, apiTokenHash);
		if ("status" in access) return access;
		const { note } = access;
		const shares = await activeShares(ctx, note._id);
		const results = await Promise.all(
			shares.map(async (share) => {
				const account = await accountFor(ctx, note.issuer, share.subject);
				return account ? legacyShareView(share, account) : null;
			}),
		);
		return {
			status: 200,
			body: results
				.filter((share) => share !== null)
				.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
		};
	},
});

export const legacyWriteShare = internalMutation({
	args: {
		id: v.string(),
		apiTokenHash: v.optional(v.string()),
		change: v.union(
			v.object({
				method: v.literal("POST"),
				subject: v.string(),
				permission: sharePermission,
			}),
			v.object({
				method: v.literal("PATCH"),
				shareId: v.string(),
				permission: sharePermission,
			}),
			v.object({ method: v.literal("DELETE"), shareId: v.string() }),
		),
	},
	handler: async (ctx, { id, apiTokenHash, change }) => {
		const access = await legacyShareOwner(ctx, id, apiTokenHash);
		if ("status" in access) return access;
		const { note } = access;
		if (change.method === "POST") {
			if (change.subject === note.owner)
				return { status: 400, body: { code: "CANNOT_SHARE_WITH_SELF" } };
			const recipient = await accountFor(ctx, note.issuer, change.subject);
			if (recipient?.status !== "active")
				return { status: 404, body: { code: "USER_NOT_FOUND" } };
			const prior = await shareBySubject(ctx, note._id, change.subject);
			const share = await writeShare(
				ctx,
				note,
				change.subject,
				change.permission,
				prior,
			);
			if (share !== prior) await recordNoteUpdate(ctx, note);
			return { status: 201, body: legacyShareView(share, recipient) };
		}
		const share = (await activeShares(ctx, note._id)).find(
			(row) => (row.legacyId ?? row._id) === change.shareId,
		);
		if (!share) return { status: 404, body: { code: "SHARE_NOT_FOUND" } };
		if (change.method === "DELETE") {
			await leaveLegacyShare(ctx, note, share.subject);
			return { status: 200, body: { success: true } };
		}
		const recipient = await accountFor(ctx, note.issuer, share.subject);
		if (!recipient) return { status: 404, body: { code: "USER_NOT_FOUND" } };
		const updated = await writeShare(
			ctx,
			note,
			share.subject,
			change.permission,
			share,
		);
		if (updated !== share) await recordNoteUpdate(ctx, note);
		return { status: 200, body: legacyShareView(updated, recipient) };
	},
});

export const update = mutation({
	args: {
		id: v.string(),
		baseVersion: v.number(),
		title: v.optional(v.string()),
		content: v.optional(v.union(v.string(), v.null())),
	},
	handler: async (ctx, { id, baseVersion, title, content }) => {
		const identity = await requireIdentity(ctx);
		const note = await noteById(ctx, id);
		const permission = note && (await noteAccess(ctx, identity, note));
		if (!note || !permission) throw new ConvexError("NOTE_NOT_FOUND");
		if (permission === "viewer") throw new ConvexError("NOTE_READ_ONLY");
		if (!Number.isSafeInteger(baseVersion) || baseVersion < 1) {
			throw new ConvexError("INVALID_BASE_VERSION");
		}
		return applyNoteUpdate(ctx, note, permission, identity.subject, {
			baseVersion,
			title,
			content,
		});
	},
});

async function writableHistory(
	ctx: QueryCtx,
	id: string,
	identity: UserIdentity,
) {
	const note = await noteById(ctx, id);
	const permission = note && (await noteAccess(ctx, identity, note));
	if (!note || !permission || permission === "viewer") {
		throw new ConvexError("NOTE_NOT_FOUND");
	}
	return { note, permission };
}

function revisionView({
	_id,
	_creationTime,
	noteId: _,
	legacyId,
	reportedAt,
	...revision
}: Doc<"noteRevisions">) {
	return {
		...revision,
		id: legacyId ?? _id,
		createdAt: reportedAt ?? _creationTime,
	};
}

export const history = query({
	args: {
		id: v.string(),
		cursor: v.optional(v.string()),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, { id, cursor, limit = 50 }) => {
		validateFeedLimit(limit);
		const identity = await requireIdentity(ctx);
		const { note } = await writableHistory(ctx, id, identity);
		const page = await ctx.db
			.query("noteRevisions")
			.withIndex("by_note", (q) => q.eq("noteId", note._id))
			.order("desc")
			.paginate({ numItems: limit, cursor: cursor ?? null });
		return {
			revisions: page.page.map(revisionView),
			nextCursor: page.isDone ? null : page.continueCursor,
		};
	},
});

export const revision = query({
	args: { id: v.string(), revisionId: v.string() },
	handler: async (ctx, { id, revisionId }) => {
		const identity = await requireIdentity(ctx);
		const { note } = await writableHistory(ctx, id, identity);
		return revisionView(await revisionForNote(ctx, note, revisionId));
	},
});

async function revisionForNote(
	ctx: QueryCtx,
	note: Doc<"notes">,
	revisionId: string,
) {
	const revision = await findRevision(ctx, note, revisionId);
	if (!revision) throw new ConvexError("REVISION_NOT_FOUND");
	return revision;
}

async function findRevision(
	ctx: QueryCtx,
	note: Doc<"notes">,
	revisionId: string,
) {
	const normalized = ctx.db.normalizeId("noteRevisions", revisionId);
	const revision = normalized
		? await ctx.db.get("noteRevisions", normalized)
		: await ctx.db
				.query("noteRevisions")
				.withIndex("by_note_legacy_id", (q) =>
					q.eq("noteId", note._id).eq("legacyId", revisionId),
				)
				.unique();
	return revision?.noteId === note._id ? revision : null;
}

export const restore = mutation({
	args: { id: v.string(), revisionId: v.string() },
	handler: async (ctx, { id, revisionId }) => {
		const identity = await requireIdentity(ctx);
		const { note, permission } = await writableHistory(ctx, id, identity);
		if (note.state === "trashed") throw new ConvexError("NOTE_NOT_ACTIVE");
		const revision = await revisionForNote(ctx, note, revisionId);

		const restored = await writeNoteUpdate(
			ctx,
			note,
			permission,
			identity.subject,
			{
				title: revision.title,
				content: revision.content,
			},
			"restore",
		);
		return view(ctx, restored, permission, identity.subject);
	},
});

async function legacyHistoryAccess(
	ctx: QueryCtx,
	id: string,
	apiTokenHash?: string,
) {
	const identity = await legacyReadIdentity(ctx, apiTokenHash);
	if (!identity)
		return { status: 401, body: { code: "UNAUTHENTICATED" } } as const;
	const note = await noteById(ctx, id);
	const permission = note && (await noteAccess(ctx, identity, note));
	if (!note || !permission)
		return { status: 404, body: { code: "NOTE_NOT_FOUND" } } as const;
	if (permission === "viewer")
		return { status: 403, body: { code: "NOTE_READ_ONLY" } } as const;
	return { note, permission, identity };
}

async function legacyRevisionView(
	ctx: QueryCtx,
	note: Doc<"notes">,
	revision: Doc<"noteRevisions">,
	withContent: boolean,
) {
	const author = revision.authorSubject
		? await accountFor(ctx, note.issuer, revision.authorSubject)
		: null;
	return {
		id: revision.legacyId ?? revision._id,
		noteId: note.id,
		title: revision.title,
		version: revision.version,
		cause: revision.cause,
		createdAt: new Date(
			revision.reportedAt ?? revision._creationTime,
		).toISOString(),
		author: author
			? {
					id: author.id,
					name: author.name,
					email: author.email,
					profileImage: author.profileImage,
				}
			: null,
		...(withContent ? { content: revision.content } : {}),
	};
}

export const legacyHistory = internalQuery({
	args: {
		id: v.string(),
		apiTokenHash: v.optional(v.string()),
		revisionId: v.optional(v.string()),
		cursor: v.optional(v.string()),
		limit: v.number(),
		withContent: v.boolean(),
	},
	handler: async (
		ctx,
		{ id, apiTokenHash, revisionId, cursor, limit, withContent },
	) => {
		const access = await legacyHistoryAccess(ctx, id, apiTokenHash);
		if ("status" in access) return access;
		const { note } = access;
		if (revisionId) {
			const revision = await findRevision(ctx, note, revisionId);
			return revision
				? {
						status: 200,
						body: await legacyRevisionView(ctx, note, revision, true),
					}
				: { status: 404, body: { code: "REVISION_NOT_FOUND" } };
		}
		const anchor = cursor ? await findRevision(ctx, note, cursor) : null;
		if (cursor && !anchor)
			return { status: 200, body: { revisions: [], nextCursor: null } };
		const rows = await ctx.db
			.query("noteRevisions")
			.withIndex("by_note", (q) => {
				const range = q.eq("noteId", note._id);
				return anchor ? range.lt("_creationTime", anchor._creationTime) : range;
			})
			.order("desc")
			.take(limit + 1);
		const revisions = await Promise.all(
			rows
				.slice(0, limit)
				.map((revision) =>
					legacyRevisionView(ctx, note, revision, withContent),
				),
		);
		return {
			status: 200,
			body: {
				revisions,
				nextCursor: rows.length > limit ? revisions[limit - 1].id : null,
			},
		};
	},
});

export const legacyRestoreRevision = internalMutation({
	args: {
		id: v.string(),
		revisionId: v.string(),
		baseVersion: v.optional(v.number()),
		apiTokenHash: v.optional(v.string()),
	},
	handler: async (ctx, { id, revisionId, baseVersion, apiTokenHash }) => {
		const access = await legacyHistoryAccess(ctx, id, apiTokenHash);
		if ("status" in access) return access;
		const { note, permission, identity } = access;
		if (note.state === "trashed")
			return { status: 400, body: { code: "NOTE_NOT_ACTIVE" } };
		if (baseVersion !== undefined && note.version !== baseVersion)
			return { status: 409, body: { code: "NOTE_CHANGED" } };
		const revision = await findRevision(ctx, note, revisionId);
		if (!revision) return { status: 404, body: { code: "REVISION_NOT_FOUND" } };
		const restored = await writeNoteUpdate(
			ctx,
			note,
			permission,
			identity.subject,
			{ title: revision.title, content: revision.content },
			"restore",
		);
		const prior =
			baseVersion !== undefined && restored.version !== note.version
				? await ctx.db
						.query("noteRevisions")
						.withIndex("by_note", (q) => q.eq("noteId", note._id))
						.order("desc")
						.first()
				: null;
		return {
			status: 200,
			body: {
				...(await legacyNoteView(ctx, restored, permission, identity)),
				...(prior?.cause === "restore" && prior.version === note.version
					? { undoRevisionId: prior.legacyId ?? prior._id }
					: {}),
			},
		};
	},
});

const revisionCollapseWindowMs = 10 * 60 * 1000;

async function recordRevision(
	ctx: MutationCtx,
	note: Doc<"notes">,
	authorSubject: string,
	cause: "edit" | "restore",
	collapse = true,
) {
	if (cause === "edit" && collapse) {
		const newest = await ctx.db
			.query("noteRevisions")
			.withIndex("by_note", (q) => q.eq("noteId", note._id))
			.order("desc")
			.first();
		if (
			newest?.cause === "edit" &&
			newest.authorSubject === authorSubject &&
			Date.now() - newest._creationTime < revisionCollapseWindowMs
		)
			return;
	}
	await ctx.db.insert("noteRevisions", {
		noteId: note._id,
		version: note.version,
		title: note.title,
		content: note.content,
		authorSubject,
		cause,
		reportedAt: Date.now(),
	});
}

type NoteUpdate = {
	baseVersion?: number;
	title?: string;
	content?: string | null;
	state?: Infer<typeof noteState>;
	background?: string | null;
	stateChangedAt?: number;
	replacesOtherEdit?: boolean;
};

async function applyNoteUpdate(
	ctx: MutationCtx,
	note: Doc<"notes">,
	permission: Permission,
	authorSubject: string,
	change: NoteUpdate,
	cause: "edit" | "restore" = "edit",
	recordPrior = true,
) {
	if (permission === "viewer" || note.version !== change.baseVersion) {
		return {
			ok: false as const,
			serverNote: await view(ctx, note, permission, authorSubject),
		};
	}
	const updated = await writeNoteUpdate(
		ctx,
		note,
		permission,
		authorSubject,
		change,
		cause,
		recordPrior,
	);
	return {
		ok: true as const,
		note: await view(ctx, updated, permission, authorSubject),
	};
}

async function writeNoteUpdate(
	ctx: MutationCtx,
	note: Doc<"notes">,
	permission: Exclude<Permission, "viewer">,
	authorSubject: string,
	{
		title,
		content,
		state,
		background,
		stateChangedAt,
		replacesOtherEdit,
	}: NoteUpdate,
	cause: "edit" | "restore" = "edit",
	recordPrior = true,
) {
	const currentState = note.state ?? "active";
	const next = {
		title: title ?? note.title,
		content: content === undefined ? note.content : content,
		state: permission === "owner" ? (state ?? currentState) : currentState,
		background:
			background === undefined ? (note.background ?? null) : background,
	};
	const changedContent =
		next.title !== note.title || next.content !== note.content;
	const changedState = next.state !== currentState;
	if (
		!changedContent &&
		!changedState &&
		next.background === (note.background ?? null)
	) {
		return note;
	}
	const now = Date.now();
	const patch = {
		...next,
		version: note.version + 1,
		updatedAt: now,
		...(changedState ? { stateChangedAt: stateChangedAt ?? now } : {}),
	};
	if (recordPrior && changedContent)
		await recordRevision(ctx, note, authorSubject, cause, !replacesOtherEdit);
	await ctx.db.patch("notes", note._id, patch);
	if (changedState && next.state === "deleted")
		await ctx.scheduler.runAfter(
			0,
			internal.notes.purgeDeletedNoteAttachments,
			{ noteId: note._id },
		);
	await recordNoteUpdate(ctx, { ...note, ...patch });
	return { ...note, ...patch };
}

export const expireTrashBatch = internalMutation({
	args: { cutoff: v.optional(v.number()) },
	handler: async (ctx, { cutoff }) => {
		if (await legacyImportInProgress(ctx)) return { expired: 0 };
		const limit = 8;
		const eligibleBefore = Date.now() - trashRetentionMs;
		const before = Math.min(cutoff ?? eligibleBefore, eligibleBefore);
		const expired = await notesInStateBefore(ctx, "trashed", before, limit);
		for (const note of expired) {
			await writeNoteUpdate(ctx, note, "owner", note.owner, {
				state: "deleted",
			});
		}
		if (expired.length === limit)
			await ctx.scheduler.runAfter(0, internal.notes.expireTrashBatch, {
				cutoff: before,
			});
		return { expired: expired.length };
	},
});

export async function notesInStateBefore(
	ctx: QueryCtx,
	state: "trashed" | "deleted",
	before: number,
	limit: number,
) {
	const expired = await ctx.db
		.query("notes")
		.withIndex("by_state_age", (q) =>
			q
				.eq("state", state)
				.gt("stateChangedAt", undefined)
				.lt("stateChangedAt", before),
		)
		.take(limit);
	if (expired.length < limit) {
		const legacy = await ctx.db
			.query("notes")
			.withIndex("by_state_age", (q) =>
				q
					.eq("state", state)
					.eq("stateChangedAt", undefined)
					.lt("updatedAt", before),
			)
			.take(limit - expired.length);
		expired.push(...legacy);
	}
	return expired;
}

export const purgeDeletedNoteAttachments = internalMutation({
	args: { noteId: v.id("notes") },
	handler: async (ctx, { noteId }): Promise<void> => {
		const note = await ctx.db.get("notes", noteId);
		if (note?.state !== "deleted") return;
		const batch = await ctx.db
			.query("noteAttachments")
			.withIndex("by_note_id", (q) => q.eq("noteId", noteId))
			.take(32);
		for (const attachment of batch) {
			await releaseAttachmentBlob(ctx, attachment);
			await ctx.db.delete("noteAttachments", attachment._id);
		}
		if (batch.length === 32)
			await ctx.scheduler.runAfter(
				0,
				internal.notes.purgeDeletedNoteAttachments,
				{ noteId },
			);
	},
});

export async function recordNoteUpdate(ctx: MutationCtx, note: Doc<"notes">) {
	const shares = await activeShares(ctx, note._id);
	const op = note.state === "deleted" ? "remove" : "upsert";
	await recordChange(ctx, note, note.owner, op);
	for (const share of shares) {
		await recordChange(ctx, note, share.subject, op);
	}
}

export const maxClientRevisions = 20;

const clientRevision = v.object({
	id: v.string(),
	title: v.string(),
	content: v.optional(v.union(v.string(), v.null())),
	version: v.optional(v.number()),
	cause: v.union(v.literal("edit"), v.literal("restore")),
	createdAt: v.string(),
});

function clientRevisionById(
	ctx: QueryCtx,
	noteId: Doc<"notes">["_id"],
	clientId: string,
) {
	return ctx.db
		.query("noteRevisions")
		.withIndex("by_note_client_id", (q) =>
			q.eq("noteId", noteId).eq("clientId", clientId),
		)
		.unique();
}

async function recordClientRevisions(
	ctx: MutationCtx,
	noteId: Doc<"notes">["_id"],
	authorSubject: string,
	revisions: ReadonlyArray<Infer<typeof clientRevision>> = [],
) {
	let inserted = false;
	for (const revision of revisions) {
		const existing = await clientRevisionById(ctx, noteId, revision.id);
		if (existing) continue;
		await ctx.db.insert("noteRevisions", {
			noteId,
			clientId: revision.id,
			title: revision.title,
			content: revision.content ?? null,
			version: revision.version ?? 0,
			cause: revision.cause,
			reportedAt: Math.min(Date.parse(revision.createdAt), Date.now()),
			authorSubject,
		});
		inserted = true;
	}
	return inserted;
}

const noteChange = v.object({
	type: v.literal("note"),
	id: v.string(),
	title: v.string(),
	createdAt: v.optional(v.string()),
	content: v.optional(v.union(v.string(), v.null())),
	baseVersion: v.optional(v.number()),
	isArchived: v.optional(v.boolean()),
	tagIds: v.optional(v.array(v.string())),
	state: v.optional(noteState),
	background: v.optional(v.union(v.string(), v.null())),
	revisions: v.optional(v.array(clientRevision)),
	revisionsOnly: v.optional(v.boolean()),
	requireRevisionWrite: v.optional(v.boolean()),
});

const reminderChange = v.object({
	type: v.literal("reminder"),
	id: v.string(),
	baseVersion: v.optional(v.number()),
	remindAt: v.optional(v.union(v.string(), v.null())),
	recurrence: v.optional(reminderRecurrence),
});

type ReminderPushResult = { type: "reminder"; id: string } & (
	| { status: "applied"; version?: number }
	| {
			status: "conflict";
			version?: number;
			serverCopy: ReturnType<typeof reminderView>;
	  }
	| { status: "denied" | "failed" }
);

async function applyReminder(
	ctx: MutationCtx,
	note: Doc<"notes"> | null,
	identity: NoteIdentity,
	change: Infer<typeof reminderChange>,
	checkVersion = true,
): Promise<ReminderPushResult> {
	const result = { type: change.type, id: change.id };
	if (!note || !(await noteAccess(ctx, identity, note)))
		return { ...result, status: "denied" };
	const { subject } = identity;
	const prior = await reminderFor(ctx, note._id, subject);
	const current = reminderView(prior);
	const remindAt = change.remindAt ?? null;
	const recurrence = change.recurrence ?? "none";

	if (!current && remindAt === null) return { ...result, status: "applied" };
	if (current?.remindAt === remindAt && current.recurrence === recurrence) {
		return { ...result, status: "applied", version: current.version };
	}
	if (checkVersion && change.baseVersion !== current?.version) {
		return {
			...result,
			status: "conflict",
			...(current ? { version: current.version } : {}),
			serverCopy: current,
		};
	}
	if (remindAt === null) {
		await clearReminder(ctx, prior);
		await recordChange(ctx, note, subject, "remove", "reminder");
		return { ...result, status: "applied" };
	}
	const version = (prior?.version ?? 0) + 1;
	const next = { remindAt, recurrence, version };
	if (prior) await ctx.db.patch("noteReminders", prior._id, next);
	else
		await ctx.db.insert("noteReminders", {
			noteId: note._id,
			subject,
			...next,
		});
	await recordChange(ctx, note, subject, "upsert", "reminder");
	return { ...result, status: "applied", version };
}

const syncChange = v.union(
	noteChange,
	tagChange,
	reminderChange,
	v.object({
		type: v.literal("pin"),
		id: v.string(),
		isPinned: v.boolean(),
	}),
);

type SyncPushResult =
	| NotePushResult
	| TagPushResult
	| ReminderPushResult
	| { type: "pin"; id: string; status: "applied" | "denied" | "failed" };

type NotePushResult = { type: "note"; id: string } & (
	| { status: "applied"; version: number }
	| {
			status: "conflict";
			serverCopy: Awaited<
				ReturnType<typeof view> | ReturnType<typeof legacyNoteView>
			>;
	  }
	| { status: "denied" | "failed" }
);

async function keepRejectedDraft(
	ctx: MutationCtx,
	note: Doc<"notes">,
	authorSubject: string,
	change: Pick<Infer<typeof noteChange>, "title" | "content" | "baseVersion">,
) {
	const content = change.content === undefined ? note.content : change.content;
	const existing = await ctx.db
		.query("noteRevisions")
		.withIndex("by_note", (q) => q.eq("noteId", note._id))
		.filter((q) =>
			q.and(
				q.eq(q.field("title"), change.title),
				q.eq(q.field("content"), content),
			),
		)
		.first();
	if (existing) return;
	await ctx.db.insert("noteRevisions", {
		noteId: note._id,
		version: change.baseVersion ?? 0,
		title: change.title,
		content,
		authorSubject,
		cause: "conflict",
		reportedAt: Date.now(),
	});
}

export const applyPush = internalMutation({
	args: {
		change: syncChange,
		apiTokenHash: v.optional(v.string()),
		legacy: v.optional(v.boolean()),
	},
	handler: async (
		ctx,
		{ change, apiTokenHash, legacy },
	): Promise<SyncPushResult> => {
		const identity = await legacyReadIdentity(ctx, apiTokenHash);
		if (!identity)
			return { type: change.type, id: change.id, status: "failed" };
		if (change.type === "tag") {
			const { result, op } = await applyTag(ctx, identity, change);
			if (op) await recordTagChange(ctx, identity, change.id, op);
			return result;
		}
		const note = await noteById(ctx, change.id);
		if (change.type === "reminder")
			return applyReminder(ctx, note, identity, change);
		if (change.type === "pin") {
			const result = { type: "pin" as const, id: change.id };
			if (!note || !(await noteAccess(ctx, identity, note)))
				return { ...result, status: "denied" };
			if (await setPin(ctx, note._id, identity.subject, change.isPinned)) {
				await recordChange(
					ctx,
					note,
					identity.subject,
					change.isPinned ? "upsert" : "remove",
					"pin",
				);
			}
			return { ...result, status: "applied" };
		}
		const result = { type: change.type, id: change.id };
		if (!note) {
			if (
				change.revisionsOnly ||
				change.baseVersion !== undefined ||
				!noteUuid.test(change.id)
			) {
				return { ...result, status: "denied" };
			}
			const inserted = await insertNote(ctx, identity, change);
			if (inserted.state !== "deleted") {
				await setArchive(
					ctx,
					inserted._id,
					identity.subject,
					change.isArchived,
				);
				await setNoteTags(ctx, inserted, identity.subject, change.tagIds);
			}
			await recordClientRevisions(
				ctx,
				inserted._id,
				identity.subject,
				change.revisions,
			);
			return { ...result, status: "applied", version: inserted.version };
		}
		if (note.state === "deleted") {
			return note.issuer === identity.issuer &&
				note.owner === identity.subject &&
				change.state === "deleted"
				? { ...result, status: "applied", version: note.version }
				: { ...result, status: "denied" };
		}
		const permission = await noteAccess(ctx, identity, note);
		if (!permission) return { ...result, status: "denied" };
		if (change.revisionsOnly && change.requireRevisionWrite && permission === "viewer" && !legacy)
			return { ...result, status: "denied" };
		if (
			!change.revisionsOnly &&
			permission !== "owner" &&
			(change.state === "deleted" ||
				(change.state === "trashed" && (note.state ?? "active") === "active"))
		) {
			await removeShare(ctx, note, identity.subject);
			return { ...result, status: "denied" };
		}
		const archiveChanged =
			!change.revisionsOnly &&
			(await setArchive(ctx, note._id, identity.subject, change.isArchived));
		const tagsChanged =
			!change.revisionsOnly &&
			(await setNoteTags(ctx, note, identity.subject, change.tagIds));
		const personalChanged = archiveChanged || tagsChanged;
		const sameText =
			change.title === note.title &&
			(change.content === undefined || change.content === note.content);
		const sameContent =
			sameText &&
			(change.background === undefined ||
				change.background === (note.background ?? null)) &&
			(permission !== "owner" ||
				change.state === undefined ||
				change.state === (note.state ?? "active"));
		if (
			change.revisionsOnly ||
			(sameContent && (!legacy || permission !== "viewer"))
		) {
			if (
				permission !== "viewer" &&
				(await recordClientRevisions(
					ctx,
					note._id,
					identity.subject,
					change.revisions,
				))
			) {
				await recordNoteUpdate(ctx, note);
			} else if (personalChanged) {
				await recordChange(ctx, note, identity.subject, "upsert");
			}
			return { ...result, status: "applied", version: note.version };
		}
		const covering = change.revisions?.find(
			(revision) =>
				revision.title === note.title &&
				(revision.content ?? null) === note.content,
		);
		// Only the first payload for a device ID can insert a row.
		const firstForId = change.revisions?.find(
			(revision) => revision.id === covering?.id,
		);
		const stored =
			covering && (await clientRevisionById(ctx, note._id, covering.id));
		const coversPrior =
			covering !== undefined &&
			(stored
				? stored.title === note.title && stored.content === note.content
				: firstForId === covering);

		const outcome = await applyNoteUpdate(
			ctx,
			note,
			permission,
			identity.subject,
			change,
			"edit",
			!coversPrior,
		);
		if (outcome.ok) {
			await recordClientRevisions(
				ctx,
				note._id,
				identity.subject,
				change.revisions,
			);
			return { ...result, status: "applied", version: outcome.note.version };
		}
		if (personalChanged)
			await recordChange(ctx, note, identity.subject, "upsert");
		if (permission !== "viewer" && !sameText)
			await keepRejectedDraft(ctx, note, identity.subject, change);
		return {
			...result,
			status: "conflict",
			serverCopy: legacy
				? await legacyNoteView(
						ctx,
						note,
						permission,
						identity,
						outcome.serverNote,
					)
				: outcome.serverNote,
		};
	},
});

export async function pushNoteChanges(
	ctx: ActionCtx,
	changes: ReadonlyArray<Infer<typeof syncChange>>,
	legacy?: { apiTokenHash?: string },
): Promise<SyncPushResult[]> {
	if (!legacy) await requireIdentity(ctx);
	if (changes.length > 200) throw new ConvexError("TOO_MANY_SYNC_CHANGES");
	const deduped = new Map<string, Infer<typeof syncChange>>();
	for (const change of changes) {
		deduped.set(`${change.type}:${change.id}`, change);
		if (change.type === "pin") continue;
		const base = change.baseVersion;
		if (base !== undefined && (!Number.isSafeInteger(base) || base < 1)) {
			throw new ConvexError("INVALID_BASE_VERSION");
		}
		if (change.type === "tag") continue;
		if (change.type === "reminder") {
			if (change.remindAt != null && !reminderWallClock.test(change.remindAt)) {
				throw new ConvexError("INVALID_REMINDER_TIME");
			}
			continue;
		}
		if (
			(change.createdAt !== undefined &&
				!Number.isFinite(Date.parse(change.createdAt))) ||
			(change.revisions?.length ?? 0) > maxClientRevisions ||
			change.revisions?.some(
				(revision) =>
					revision.id.length === 0 ||
					revision.id.length > 128 ||
					!Number.isFinite(Date.parse(revision.createdAt)) ||
					(revision.version !== undefined &&
						(!Number.isSafeInteger(revision.version) || revision.version < 0)),
			)
		) {
			throw new ConvexError("INVALID_CLIENT_REVISION");
		}
	}
	const results: SyncPushResult[] = [];
	for (const change of deduped.values()) {
		try {
			results.push(
				await ctx.runMutation(internal.notes.applyPush, {
					change,
					...(legacy ? { legacy: true, ...legacy } : {}),
				}),
			);
		} catch {
			console.error("Sync note mutation failed.");
			results.push({ type: change.type, id: change.id, status: "failed" });
		}
	}
	return results;
}

export const push = action({
	args: { changes: v.array(syncChange) },
	handler: (ctx, { changes }): Promise<SyncPushResult[]> =>
		pushNoteChanges(ctx, changes),
});

const validSequence = /^(0|[1-9][0-9]{0,18})$/;

function validateFeedLimit(limit: number) {
	if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
		throw new ConvexError("INVALID_FEED_LIMIT");
	}
}

const resetPage = {
	entries: [],
	nextCursor: null,
	hasMore: false,
	resetRequired: true as const,
};

const syncRemovalRetentionMs = 90 * 24 * 60 * 60 * 1000;

export const pruneSyncRemovals = internalMutation({
	args: { cutoff: v.optional(v.number()) },
	handler: async (ctx, { cutoff }): Promise<void> => {
		if (await legacyImportInProgress(ctx)) return;
		const now = Date.now();
		const before = Math.min(cutoff ?? now - syncRemovalRetentionMs, now);
		const limit = 64;
		const rows = await ctx.db
			.query("noteFeed")
			.withIndex("by_op", (q) =>
				q.eq("op", "remove").lt("_creationTime", before),
			)
			.take(limit);
		for (const row of rows) {
			const head = await feedHead(ctx, row.issuer, row.subject);
			if (head && row.seq > (head.prunedThroughSeq ?? 0n))
				await ctx.db.patch("noteFeedHeads", head._id, {
					prunedThroughSeq: row.seq,
				});
			await ctx.db.delete("noteFeed", row._id);
		}
		if (rows.length === limit)
			await ctx.scheduler.runAfter(0, internal.notes.pruneSyncRemovals, {
				cutoff: before,
			});
	},
});

function feedCursorIsCurrent(head: Doc<"noteFeedHeads"> | null, seq: bigint) {
	return seq >= (head?.prunedThroughSeq ?? 0n) && seq <= (head?.lastSeq ?? 0n);
}

async function deltaPage(
	ctx: QueryCtx,
	{ issuer, subject }: Pick<UserIdentity, "issuer" | "subject">,
	seq: bigint,
	limit: number,
	legacy = false,
) {
	const rows = await ctx.db
		.query("noteFeed")
		.withIndex("by_recipient_seq", (q) =>
			q.eq("issuer", issuer).eq("subject", subject).gt("seq", seq),
		)
		.take(limit + 1);
	const page = rows.slice(0, limit);
	const entries = await Promise.all(
		page.map(async (row) => {
			if (row.entityType === "tag") {
				const tag =
					row.op === "upsert" ? await tagById(ctx, row.entityId) : null;
				const entry = {
					seq: row.seq.toString(),
					entityType: "tag" as const,
					entityId: row.entityId,
				};
				return tag &&
					tag.issuer === issuer &&
					tag.owner === subject &&
					!tag.isDeleted
					? { ...entry, op: "upsert" as const, tag: tagView(tag) }
					: { ...entry, op: "remove" as const };
			}
			if (!row.noteId) throw new ConvexError("NOTE_FEED_REFERENCE_MISSING");
			const noteId = row.noteId;
			if (row.entityType === "pin") {
				const note =
					row.op === "upsert" ? await ctx.db.get("notes", noteId) : null;
				const pinned =
					note &&
					(await noteAccess(ctx, { issuer, subject }, note)) &&
					(await pinFor(ctx, noteId, subject));
				return {
					seq: row.seq.toString(),
					entityType: "pin" as const,
					entityId: row.entityId,
					op: pinned ? ("upsert" as const) : ("remove" as const),
				};
			}
			if (row.entityType === "reminder") {
				const note =
					row.op === "upsert" ? await ctx.db.get("notes", noteId) : null;
				const reminder =
					note &&
					(await noteAccess(ctx, { issuer, subject }, note)) &&
					reminderView(await reminderFor(ctx, noteId, subject));
				const entry = {
					seq: row.seq.toString(),
					entityType: "reminder" as const,
					entityId: row.entityId,
				};
				return reminder
					? {
							...entry,
							op: "upsert" as const,
							reminder,
						}
					: { ...entry, op: "remove" as const };
			}
			const entry = {
				seq: row.seq.toString(),
				entityType: "note" as const,
				entityId: row.entityId,
			};
			if (row.op === "upsert") {
				const note = await ctx.db.get("notes", noteId);
				const permission =
					note && (await noteAccess(ctx, { issuer, subject }, note));
				if (note && permission) {
					return {
						...entry,
						op: "upsert" as const,
						note: await feedNoteView(
							ctx,
							note,
							permission,
							{ issuer, subject },
							legacy,
						),
					};
				}
			}
			return { ...entry, op: "remove" as const };
		}),
	);
	return {
		entries,
		nextCursor: page.at(-1)?.seq.toString() ?? seq.toString(),
		hasMore: rows.length > limit,
	};
}

export const changes = query({
	args: { after: v.optional(v.string()), limit: v.optional(v.number()) },
	handler: async (ctx, { after = "0", limit = 50 }) => {
		const identity = await requireIdentity(ctx);
		if (!validSequence.test(after))
			throw new ConvexError("INVALID_FEED_CURSOR");
		validateFeedLimit(limit);
		const seq = BigInt(after);
		const head = await feedHead(ctx, identity.issuer, identity.subject);
		if (!feedCursorIsCurrent(head, seq)) return resetPage;
		return deltaPage(ctx, identity, seq, limit);
	},
});

async function snapshotEntry(
	ctx: QueryCtx,
	note: Doc<"notes">,
	permission: Permission,
	subject: string,
	legacy: boolean,
) {
	return {
		seq: "0",
		entityType: "note" as const,
		entityId: note.id,
		op: "upsert" as const,
		note: await feedNoteView(
			ctx,
			note,
			permission,
			{ issuer: note.issuer, subject },
			legacy,
		),
	};
}

const syncPageArgs = v.object({
	cursor: v.optional(v.string()),
	limit: v.optional(v.number()),
	attachmentMetadata: v.optional(v.boolean()),
	attachmentOrder: v.optional(v.boolean()),
});

async function feedScope(ctx: QueryCtx, { issuer, subject }: NoteIdentity, head: Doc<"noteFeedHeads"> | null) {
	// A full Convex restore preserves these IDs.
	const id = (await accountFor(ctx, issuer, subject))?._id ?? head?._id;
	if (!id) return "empty";
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const outboxScope = internalQuery({
	args: {},
	handler: async (ctx) => {
		const identity = await requireIdentity(ctx);
		return feedScope(ctx, identity, await feedHead(ctx, identity.issuer, identity.subject));
	},
});

export async function outboxScopeChanged(ctx: ActionCtx, request: Request) {
	const expected = request.headers.get("X-Anchor-Outbox-Scope");
	return expected !== null &&
		(!/^[0-9a-f]{64}$/.test(expected) || expected !== await ctx.runQuery(internal.notes.outboxScope));
}

export const syncPage = query({
	args: syncPageArgs,
	handler: async (ctx, args) =>
		pullSyncPage(ctx, await requireIdentity(ctx), args, false),
});

export const legacySyncPage = internalQuery({
	args: {
		...syncPageArgs.fields,
		apiTokenHash: v.optional(v.string()),
		reset: v.optional(v.boolean()),
	},
	handler: async (ctx, { apiTokenHash, reset, cursor, limit = 200 }) => {
		const identity = await legacyReadIdentity(ctx, apiTokenHash);
		if (!identity) return null;
		if (reset) return resetPage;
		const pending = legacyAttachmentCursor(cursor);
		const page = await pullSyncPage(
			ctx,
			identity,
			{
				cursor: pending?.next ?? cursor,
				// A note expands into a note and an attachment entry.
				limit: pending ? 1 : Math.min(8, Math.max(1, Math.floor(limit / 2))),
			},
			true,
		);
		if (page.nextCursor === null) return page;
		if (pending) {
			const note = await noteById(ctx, pending.noteId);
			const accessible = note && (await noteAccess(ctx, identity, note));
			const entry = {
				seq: pending.seq,
				entityType: "attachments",
				entityId: pending.noteId,
			};
			return {
				entries: [
					accessible
						? {
								...entry,
								op: "upsert",
								attachments: (await orderedAttachments(ctx, note._id)).map(
									({ attachment, position }) => ({
										...attachmentView(note.id, attachment),
										position,
									}),
								),
							}
						: { ...entry, op: "remove" },
				],
				nextCursor: pending.next,
				hasMore: true,
			};
		}
		const entries: unknown[] = [];
		for (const row of page.entries) {
			if (row.entityType !== "note" || !("note" in row)) {
				entries.push(row);
				continue;
			}
			const { attachments = [], ...note } = row.note;
			entries.push({ ...row, note });
			if (limit === 1) {
				return {
					entries,
					nextCursor: `la:${row.seq}:${encodeURIComponent(row.entityId)}:${page.nextCursor}`,
					hasMore: true,
				};
			}
			entries.push({
				seq: row.seq,
				entityType: "attachments",
				entityId: row.entityId,
				op: "upsert",
				attachments,
			});
		}
		return { ...page, entries };
	},
});

function legacyAttachmentCursor(cursor?: string) {
	if (!cursor?.startsWith("la:")) return null;
	const parts = /^la:([0-9]+):([^:]+):(l1:.*)$/.exec(cursor);
	if (!parts || !validSequence.test(parts[1]))
		throw new ConvexError("INVALID_FEED_CURSOR");
	try {
		const noteId = decodeURIComponent(parts[2]);
		if (!noteId || noteId.length > 128) throw new Error("Invalid note id");
		return { seq: parts[1], noteId, next: parts[3] };
	} catch {
		throw new ConvexError("INVALID_FEED_CURSOR");
	}
}

async function pullSyncPage(
	ctx: QueryCtx,
	identity: NoteIdentity,
	{
		cursor,
		limit = 50,
		attachmentMetadata,
		attachmentOrder,
	}: Infer<typeof syncPageArgs>,
	legacy: boolean,
) {
	const { issuer, subject } = identity;
	validateFeedLimit(limit);
	const head = await feedHead(ctx, issuer, subject);
	const lastSeq = head?.lastSeq ?? 0n;

	// Capture once, then replay anything that changed during pagination.
	const parts =
		cursor === undefined
			? null
			: /^([nl][1-5]):(?:@(empty|[0-9a-f]{64}):)?([tospd]):([0-9]+):(.*)$/.exec(cursor);
	if (
		cursor !== undefined &&
		(cursor.length > 8192 ||
			!parts ||
			!validSequence.test(parts[4]) ||
			(parts[3] === "d" && parts[5] !== ""))
	) {
		throw new ConvexError("INVALID_FEED_CURSOR");
	}
	const prefix = legacy
		? "l1"
		: attachmentOrder
			? "n5"
			: attachmentMetadata
				? "n4"
				: "n1";
	const scope = await feedScope(ctx, identity, head);
	if (parts && (parts[1] !== prefix || parts[2] !== scope)) return resetPage;
	const phase = parts?.[3] ?? "t";
	const captured = parts ? BigInt(parts[4]) : lastSeq;
	const after = parts?.[5] ?? "";
	if (!feedCursorIsCurrent(head, captured)) return resetPage;
	const atCursor = (phase: string, seq: bigint | string, after = "") =>
		`${prefix}:@${scope}:${phase}:${seq}:${after}`;

	if (phase === "d") {
		const page = await deltaPage(ctx, identity, captured, limit, legacy);
		return { ...page, nextCursor: atCursor("d", page.nextCursor) };
	}

	if (phase === "t") {
		const tags = await ctx.db
			.query("tags")
			.withIndex("by_owner_id", (q) =>
				q
					.eq("issuer", issuer)
					.eq("owner", subject)
					.eq("isDeleted", false)
					.gt("id", after),
			)
			.take(limit + 1);
		const page = tags.slice(0, limit);
		const last = page.at(-1);
		if (last) {
			return {
				entries: page.map((tag) => ({
					seq: "0",
					entityType: "tag" as const,
					entityId: tag.id,
					op: "upsert" as const,
					tag: tagView(tag),
				})),
				nextCursor:
					tags.length > limit
						? atCursor("t", captured, last.id)
						: atCursor("o", captured),
				hasMore: true,
			};
		}
	}
	if (phase === "o" || phase === "t") {
		const owned = await ctx.db
			.query("notes")
			.withIndex("by_owner_id", (q) =>
				q
					.eq("issuer", issuer)
					.eq("owner", subject)
					.gt("id", phase === "o" ? after : ""),
			)
			.take(limit + 1);
		const page = owned.slice(0, limit);
		const last = page.at(-1);
		if (last) {
			return {
				entries: await Promise.all(
					page
						.filter((note) => note.state !== "deleted")
						.map((note) => snapshotEntry(ctx, note, "owner", subject, legacy)),
				),
				nextCursor:
					owned.length > limit
						? atCursor("o", captured, last.id)
						: atCursor("s", captured),
				hasMore: true,
			};
		}
	}

	if (phase === "p") {
		const pins = await ctx.db
			.query("notePins")
			.withIndex("by_subject", (q) => q.eq("subject", subject))
			.paginate({ numItems: limit, cursor: after || null });
		const entries = await Promise.all(
			pins.page.map(async (pin) => {
				const note = await ctx.db.get("notes", pin.noteId);
				return note && (await noteAccess(ctx, identity, note))
					? {
							seq: "0",
							entityType: "pin" as const,
							entityId: note.id,
							op: "upsert" as const,
						}
					: null;
			}),
		);
		return {
			entries: entries.filter((entry) => entry !== null),
			nextCursor: pins.isDone
				? atCursor("d", captured)
				: atCursor("p", captured, pins.continueCursor),
			hasMore: true,
		};
	}

	const shares = await ctx.db
		.query("noteShares")
		.withIndex("by_subject", (q) => q.eq("subject", subject))
		.filter((q) => q.neq(q.field("isRevoked"), true))
		.paginate({
			numItems: limit,
			cursor: phase === "s" && after ? after : null,
		});
	const entries = await Promise.all(
		shares.page.map(async (share) => {
			const note = await ctx.db.get("notes", share.noteId);
			return note &&
				note.owner !== subject &&
				(await noteAccess(ctx, identity, note))
				? snapshotEntry(ctx, note, share.permission, subject, legacy)
				: null;
		}),
	);
	return {
		entries: entries.filter((entry) => entry !== null),
		nextCursor: shares.isDone
			? atCursor("p", captured)
			: atCursor("s", captured, shares.continueCursor),
		hasMore: true,
	};
}
