import { paginationOptsValidator, type UserIdentity } from "convex/server";
import { type Infer, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
	internalQuery,
	type MutationCtx,
	type QueryCtx,
} from "./_generated/server";
import { legacyReadIdentity } from "./sessions";

export const tagChange = v.object({
	type: v.literal("tag"),
	id: v.string(),
	name: v.string(),
	color: v.optional(v.union(v.string(), v.null())),
	baseVersion: v.optional(v.number()),
	isDeleted: v.optional(v.boolean()),
});

export function tagById(ctx: QueryCtx, id: string) {
	return ctx.db
		.query("tags")
		.withIndex("by_tag_id", (q) => q.eq("id", id))
		.unique();
}

export function tagView(tag: Doc<"tags">) {
	return {
		id: tag.id,
		name: tag.name,
		color: tag.color,
		position: tag.position,
		version: tag.version,
		createdAt: new Date(tag._creationTime).toISOString(),
		updatedAt: new Date(tag.updatedAt).toISOString(),
	};
}

export type TagPushResult = { type: "tag"; id: string } & (
	| { status: "applied"; version?: number }
	| { status: "denied" | "failed" }
	| { status: "conflict"; serverCopy: ReturnType<typeof tagView> }
);

export async function applyTag(
	ctx: MutationCtx,
	{ issuer, subject }: Pick<UserIdentity, "issuer" | "subject">,
	change: Infer<typeof tagChange>,
): Promise<{ result: TagPushResult; op?: "upsert" | "remove" }> {
	const { id, name, isDeleted, baseVersion } = change;
	const result = { type: change.type, id };
	const existing = await tagById(ctx, id);

	if (existing && (existing.issuer !== issuer || existing.owner !== subject)) {
		return { result: { ...result, status: "denied" } };
	}
	if (!existing && isDeleted)
		return { result: { ...result, status: "applied" } };
	if (existing?.isDeleted) {
		return isDeleted
			? { result: { ...result, status: "applied", version: existing.version } }
			: { result: { ...result, status: "denied" } };
	}

	const color =
		change.color === undefined ? (existing?.color ?? null) : change.color;
	if (existing) {
		if (!isDeleted && name === existing.name && color === existing.color) {
			return {
				result: { ...result, status: "applied", version: existing.version },
			};
		}
		if (baseVersion !== existing.version) {
			return {
				result: {
					...result,
					status: "conflict",
					serverCopy: tagView(existing),
				},
			};
		}
		if (isDeleted) {
			const version = existing.version + 1;
			await ctx.db.patch("tags", existing._id, {
				isDeleted: true,
				version,
				updatedAt: Date.now(),
			});
			return {
				result: { ...result, status: "applied", version },
				op: "remove",
			};
		}
	} else if (baseVersion !== undefined) {
		return { result: { ...result, status: "denied" } };
	}

	if (!existing || name !== existing.name) {
		const collision = await ctx.db
			.query("tags")
			.withIndex("by_owner_name", (q) =>
				q
					.eq("issuer", issuer)
					.eq("owner", subject)
					.eq("isDeleted", false)
					.eq("name", name),
			)
			.first();
		if (collision) {
			return {
				result: {
					...result,
					status: "conflict",
					serverCopy: tagView(collision),
				},
			};
		}
	}
	const version = (existing?.version ?? 0) + 1;
	const next = { name, color, version, updatedAt: Date.now() };
	if (existing) await ctx.db.patch("tags", existing._id, next);
	else
		await ctx.db.insert("tags", {
			issuer,
			owner: subject,
			id,
			isDeleted: false,
			position: null,
			...next,
		});
	return { result: { ...result, status: "applied", version }, op: "upsert" };
}

function assignedTags(
	ctx: QueryCtx,
	noteId: Doc<"notes">["_id"],
	subject: string,
) {
	return ctx.db
		.query("noteTags")
		.withIndex("by_note_subject", (q) =>
			q.eq("noteId", noteId).eq("subject", subject),
		)
		.unique();
}

function isOwnedTag(
	tag: Doc<"tags"> | null,
	issuer: string,
	subject: string,
): tag is Doc<"tags"> {
	return (
		tag !== null &&
		!tag.isDeleted &&
		tag.issuer === issuer &&
		tag.owner === subject
	);
}

export async function noteTagIds(
	ctx: QueryCtx,
	note: Pick<Doc<"notes">, "_id" | "issuer">,
	subject: string,
) {
	const current = await assignedTags(ctx, note._id, subject);
	if (!current) return [];
	const tags = await Promise.all(
		current.tagIds.map((id) => ctx.db.get("tags", id)),
	);
	return tags
		.filter((tag) => isOwnedTag(tag, note.issuer, subject))
		.map((tag) => tag.id);
}

export async function setNoteTags(
	ctx: MutationCtx,
	note: Pick<Doc<"notes">, "_id" | "issuer">,
	subject: string,
	ids?: readonly string[],
) {
	if (ids === undefined) return false;
	const tagIds = await ownedTagRefs(ctx, note.issuer, subject, ids);
	return writeNoteTagRefs(ctx, note._id, subject, tagIds);
}

export async function setNoteTagAssignment(
	ctx: MutationCtx,
	note: Pick<Doc<"notes">, "_id" | "issuer">,
	subject: string,
	id: string,
	assigned: boolean,
) {
	const [tag] = await ownedTagRefs(ctx, note.issuer, subject, [id]);
	if (!tag) return null;
	const current = await assignedTags(ctx, note._id, subject);
	const ids = current?.tagIds ?? [];
	if (ids.includes(tag) === assigned) return false;
	return writeNoteTagRefs(
		ctx,
		note._id,
		subject,
		assigned ? [...ids, tag] : ids.filter((ref) => ref !== tag),
	);
}

export async function ownedTagRefs(
	ctx: QueryCtx,
	issuer: string,
	subject: string,
	ids: readonly string[],
) {
	const requested = await Promise.all(
		[...new Set(ids)].sort().map((id) => tagById(ctx, id)),
	);
	return requested
		.filter((tag) => isOwnedTag(tag, issuer, subject))
		.map((tag) => tag._id);
}

export async function writeNoteTagRefs(
	ctx: MutationCtx,
	noteId: Id<"notes">,
	subject: string,
	requested: Id<"tags">[],
	merge = false,
) {
	const current = await assignedTags(ctx, noteId, subject);
	const tagIds =
		merge && current
			? [...new Set([...current.tagIds, ...requested])]
			: requested;
	if (tagIds.length === 0) {
		if (!current) return false;
		await ctx.db.delete("noteTags", current._id);
	} else if (!current) {
		await ctx.db.insert("noteTags", { noteId, subject, tagIds });
	} else {
		if (
			current.tagIds.length === tagIds.length &&
			tagIds.every((id, i) => current.tagIds[i] === id)
		)
			return false;
		await ctx.db.patch("noteTags", current._id, { tagIds });
	}
	return true;
}

export function legacyTagView(tag: Doc<"tags">) {
	return {
		...tagView(tag),
		createdAt: new Date(tag.createdAt ?? tag._creationTime).toISOString(),
		userId: tag.owner,
		isDeleted: tag.isDeleted,
	};
}

export const legacyTagsPage = internalQuery({
	args: {
		apiTokenHash: v.optional(v.string()),
		id: v.optional(v.string()),
		page: paginationOptsValidator,
	},
	handler: async (ctx, { apiTokenHash, id, page }) => {
		const identity = await legacyReadIdentity(ctx, apiTokenHash);
		if (!identity) return { type: "unauthenticated" } as const;
		const { issuer, subject } = identity;
		if (id !== undefined) {
			const tag = await tagById(ctx, id);
			if (
				!tag ||
				tag.issuer !== issuer ||
				tag.owner !== subject ||
				tag.isDeleted
			)
				return { type: "missing" } as const;
			return {
				type: "page",
				rows: [legacyTagView(tag)],
				cursor: null,
			} as const;
		}
		const results = await ctx.db
			.query("tags")
			.withIndex("by_owner_name", (q) =>
				q.eq("issuer", issuer).eq("owner", subject).eq("isDeleted", false),
			)
			.paginate(page);
		return {
			type: "page",
			rows: results.page.map(legacyTagView),
			cursor: results.isDone ? null : results.continueCursor,
		} as const;
	},
});
