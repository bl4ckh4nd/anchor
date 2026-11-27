import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { Schema } from "effect";
import { internal } from "./_generated/api";
import { httpAction, type ActionCtx } from "./_generated/server";
import { legacyReadCredential } from "./apiTokenHttp";
import { reply } from "./sessionHttp";

type NoteArgs = FunctionArgs<typeof internal.notes.legacyListPage>;
type NotePage = Extract<
	FunctionReturnType<typeof internal.notes.legacyListPage>,
	{ type: "page" }
>;
type TagPage = Extract<
	FunctionReturnType<typeof internal.tags.legacyTagsPage>,
	{ type: "page" }
>;

function newestFirst(
	a: { id: string; updatedAt: string },
	b: { id: string; updatedAt: string },
) {
	if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
	return a.id === b.id ? 0 : a.id < b.id ? 1 : -1;
}

async function collectNotes(
	ctx: ActionCtx,
	args: Omit<NoteArgs, "page" | "source">,
	limit?: number,
) {
	const notes: NotePage["rows"] = [];
	const counts = new Map<string, number>();
	const tagNotes: NotePage["tagNotes"] = [];
	for (const source of args.folder === "trash" || args.folder === "tag"
		? (["owned"] as const)
		: (["owned", "shared"] as const)) {
		let cursor: string | null = null;
		do {
			const result: FunctionReturnType<typeof internal.notes.legacyListPage> =
				await ctx.runQuery(internal.notes.legacyListPage, {
					...args,
					source,
					page: { numItems: 8, cursor },
				});
			if (result.type !== "page") return null;
			notes.push(...result.rows);
			tagNotes.push(...result.tagNotes);
			if (limit !== undefined && notes.length > limit) {
				notes.sort(newestFirst);
				notes.length = limit;
			}
			for (const id of result.tags) counts.set(id, (counts.get(id) ?? 0) + 1);
			cursor = result.cursor;
		} while (cursor !== null);
	}
	return { notes, counts, tagNotes };
}

export const listNotes = httpAction(async (ctx, request) => {
	const { pathname, searchParams } = new URL(request.url);
	const folder =
		pathname === "/api/notes/trash"
			? "trash"
			: pathname === "/api/notes/archive"
				? "archive"
				: "active";
	const search =
		folder === "active" ? searchParams.get("search")?.toLowerCase() : undefined;
	const tagId = folder === "active" ? searchParams.get("tagId") : undefined;
	const rawLimit =
		folder === "active"
			? Number.parseInt(searchParams.get("limit") ?? "", 10)
			: NaN;
	const result = await collectNotes(
		ctx,
		{
			...(await legacyReadCredential(request)),
			folder,
			...(search ? { search } : {}),
			...(tagId ? { tagId } : {}),
		},
		Number.isNaN(rawLimit) ? undefined : Math.min(Math.max(rawLimit, 1), 200),
	);
	if (!result) return reply({ code: "UNAUTHENTICATED" }, 401);
	return reply(result.notes.sort(newestFirst));
});

export const listTags = httpAction(async (ctx, request) => {
	const raw = new URL(request.url).pathname.slice("/api/tags".length);
	let id: string | undefined;
	const components = raw ? raw.slice(1).split("/") : [];
	const tagNotes = components.length === 2 && components[1] === "notes";
	if (components.length > 1 && !tagNotes)
		return reply({ code: "TAG_NOT_FOUND" }, 404);
	if (components.length) {
		try {
			id = decodeURIComponent(components[0]);
		} catch {
			return reply({ code: "TAG_NOT_FOUND" }, 404);
		}
		if (!id || id.length > 128 || id.includes("/"))
			return reply({ code: "TAG_NOT_FOUND" }, 404);
	}
	const credential = await legacyReadCredential(request);
	const tags: TagPage["rows"] = [];
	let cursor: string | null = null;
	do {
		const result: FunctionReturnType<typeof internal.tags.legacyTagsPage> =
			await ctx.runQuery(internal.tags.legacyTagsPage, {
				...credential,
				...(id ? { id } : {}),
				page: { numItems: 64, cursor },
			});
		if (result.type === "unauthenticated")
			return reply({ code: "UNAUTHENTICATED" }, 401);
		if (result.type === "missing")
			return reply({ code: "TAG_NOT_FOUND", message: "Tag not found" }, 404);
		tags.push(...result.rows);
		cursor = result.cursor;
	} while (cursor !== null);
	if (tagNotes && id) {
		const result = await collectNotes(ctx, {
			...credential,
			folder: "tag",
			tagId: id,
		});
		return result
			? reply(result.tagNotes.sort(newestFirst))
			: reply({ code: "UNAUTHENTICATED" }, 401);
	}
	if (tags.length === 0) return reply([]);
	const result = await collectNotes(ctx, { ...credential, folder: "count" });
	if (!result) return reply({ code: "UNAUTHENTICATED" }, 401);
	const rows = tags.map((tag) => ({
		...tag,
		_count: { notes: result.counts.get(tag.id) ?? 0 },
	}));
	return reply(id ? rows[0] : rows);
});

const tagName = Schema.String.check(Schema.isMinLength(1));
const tagColor = Schema.optionalKey(Schema.NullOr(Schema.String));
const decodeNewTag = Schema.decodeUnknownSync(
	Schema.Struct({
		name: tagName,
		color: tagColor,
	}),
);
const decodeTagPatch = Schema.decodeUnknownSync(
	Schema.Struct({
		name: Schema.optionalKey(tagName),
		color: tagColor,
		baseVersion: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
	}),
);

export const writeTag = httpAction(async (ctx, request) => {
	const { method } = request;
	if (method !== "POST" && method !== "PATCH" && method !== "DELETE")
		return reply({ code: "TAG_NOT_FOUND" }, 404);
	let id: string;
	try {
		id =
			method === "POST"
				? crypto.randomUUID()
				: decodeURIComponent(
						new URL(request.url).pathname.slice("/api/tags/".length),
					);
	} catch {
		return reply({ code: "TAG_NOT_FOUND" }, 404);
	}
	if (!id || id.length > 128 || id.includes("/"))
		return reply({ code: "TAG_NOT_FOUND" }, 404);
	const credential = await legacyReadCredential(request);
	if (!credential.apiTokenHash) return reply({ code: "UNAUTHENTICATED" }, 401);
	let input: ReturnType<typeof decodeTagPatch> = {};
	if (method !== "DELETE") {
		try {
			const body: unknown = await request.json();
			input = method === "POST" ? decodeNewTag(body) : decodeTagPatch(body);
		} catch {
			return reply({ code: "INVALID_TAG" }, 400);
		}
	}
	const result = await ctx.runMutation(internal.notes.legacyWriteTag, {
		...credential,
		...input,
		id,
		method,
	});
	if (method === "DELETE") return reply(result.body, result.status);
	if ("id" in result.body && result.status === 201)
		return reply({ ...result.body, _count: { notes: 0 } }, 201);
	if ("id" in result.body || "serverTag" in result.body) {
		const notes = await collectNotes(ctx, { ...credential, folder: "count" });
		const _count = notes ? { notes: notes.counts.get(id) ?? 0 } : undefined;
		const body =
			"id" in result.body
				? { ...result.body, _count }
				: { ...result.body, serverTag: { ...result.body.serverTag, _count } };
		return reply(body, result.status);
	}
	return reply(result.body, result.status);
});
