import type { FunctionReturnType } from "convex/server";
import { Schema } from "effect";
import { internal } from "./_generated/api";
import { httpAction, type ActionCtx } from "./_generated/server";
import { legacyAttachmentRequest } from "./attachments";
import { authenticatorClaims, reply } from "./sessionHttp";
import { nativeAuthEnabled } from "./sessions";

const hex = (bytes: Uint8Array) =>
	Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const hash = async (token: string) =>
	hex(
		new Uint8Array(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
		),
	);

export const manage = httpAction(async (ctx, request) => {
	if (!nativeAuthEnabled()) return reply({ code: "NOT_FOUND" }, 404);
	const claims = await authenticatorClaims(ctx);
	if (!claims) return reply({ code: "UNAUTHENTICATED" }, 401);
	if (request.method === "GET") {
		const status = await ctx.runQuery(internal.sessions.apiTokenStatus, claims);
		return status
			? reply({ apiToken: null, ...status })
			: reply({ code: "UNAUTHENTICATED" }, 401);
	}
	const token =
		request.method === "POST"
			? hex(crypto.getRandomValues(new Uint8Array(32)))
			: null;
	const result = await ctx.runMutation(internal.sessions.setApiToken, {
		...claims,
		hash: token === null ? null : await hash(token),
	});
	if (result === "unauthenticated")
		return reply({ code: "UNAUTHENTICATED" }, 401);
	if (result !== "updated") return reply({ code: "API_TOKEN_RETRY" }, 503);
	return reply({ apiToken: token, hasApiToken: token !== null });
});

export async function legacyReadCredential(request: Request) {
	const token = /^Bearer ([^\s]{1,4096})$/i.exec(
		request.headers.get("Authorization") ?? "",
	)?.[1];
	return token ? { apiTokenHash: await hash(token) } : {};
}

const permission = Schema.Literals(["viewer", "editor"]);
const decodeCreateShare = Schema.decodeUnknownSync(
	Schema.Struct({
		sharedWithUserId: Schema.String.check(
			Schema.isMinLength(1),
			Schema.isMaxLength(128),
		),
		permission,
	}),
);
const decodeUpdateShare = Schema.decodeUnknownSync(
	Schema.Struct({ permission }),
);

export async function noteSharesRequest(
	ctx: ActionCtx,
	request: Request,
	id: string,
	shareId?: string,
) {
	const credentials = await legacyReadCredential(request);
	if (!credentials.apiTokenHash) return reply({ code: "UNAUTHENTICATED" }, 401);
	const { method } = request;
	if (method === "GET" && shareId === undefined) {
		const result = await ctx.runQuery(internal.notes.legacyListShares, {
			id,
			...credentials,
		});
		return reply(result.body, result.status);
	}
	if (method === "DELETE" && shareId !== undefined) {
		const result = await ctx.runMutation(internal.notes.legacyWriteShare, {
			id,
			...credentials,
			change: { method, shareId },
		});
		return reply(result.body, result.status);
	}
	if (method === "POST" && shareId === undefined) {
		let input: ReturnType<typeof decodeCreateShare>;
		try {
			input = decodeCreateShare(await request.json());
		} catch {
			return reply({ code: "INVALID_NOTE_SHARE" }, 400);
		}
		const result = await ctx.runMutation(internal.notes.legacyWriteShare, {
			id,
			...credentials,
			change: {
				method,
				subject: input.sharedWithUserId,
				permission: input.permission,
			},
		});
		return reply(result.body, result.status);
	}
	if (method === "PATCH" && shareId !== undefined) {
		let input: ReturnType<typeof decodeUpdateShare>;
		try {
			input = decodeUpdateShare(await request.json());
		} catch {
			return reply({ code: "INVALID_NOTE_SHARE" }, 400);
		}
		const result = await ctx.runMutation(internal.notes.legacyWriteShare, {
			id,
			...credentials,
			change: { method, shareId, ...input },
		});
		return reply(result.body, result.status);
	}
	return reply({ code: "SHARE_NOT_FOUND" }, 404);
}

export const contacts = httpAction(async (ctx, request) => {
	const url = new URL(request.url);
	const search =
		url.pathname === "/api/users/search"
			? (url.searchParams.get("q") ?? "").trim().toLowerCase()
			: undefined;
	const credentials = await legacyReadCredential(request);
	const limit = search === undefined ? 5 : 10;
	const rows = [];
	const seen = new Set<string>();
	let cursor: string | null = null;
	do {
		const page: FunctionReturnType<
			typeof internal.sessions.legacyContactsPage
		> = await ctx.runQuery(internal.sessions.legacyContactsPage, {
			...credentials,
			search,
			page: { cursor, numItems: search === undefined ? 8 : 64 },
		});
		if (!page) return reply({ code: "UNAUTHENTICATED" }, 401);
		for (const row of page.rows) {
			if (search === undefined) {
				if (seen.has(row.id)) continue;
				seen.add(row.id);
			}
			rows.push(row);
		}
		if (search !== undefined)
			rows.sort(
				(a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
			);
		if (rows.length > limit) rows.length = limit;
		cursor = page.cursor;
	} while (cursor !== null && (search !== undefined || rows.length < limit));
	return reply(rows);
});

export const noteDetail = httpAction(async (ctx, request) => {
	const url = new URL(request.url);
	let segments: string[];
	try {
		segments = url.pathname
			.slice("/api/notes/".length)
			.split("/")
			.map(decodeURIComponent);
	} catch {
		return reply({ code: "NOTE_NOT_FOUND" }, 404);
	}
	if (
		segments.some(
			(segment) => !segment || segment.length > 128 || segment.includes("/"),
		)
	)
		return reply({ code: "NOTE_NOT_FOUND" }, 404);
	const [id, resource, revisionId, action] = segments;
	if (
		resource === "duplicate" &&
		request.method === "POST" &&
		segments.length === 2
	) {
		const result = await ctx.runMutation(internal.notes.legacyDuplicate, {
			id,
			copyId: crypto.randomUUID(),
			withUndo: url.searchParams.get("undo") === "true",
			...(await legacyReadCredential(request)),
		});
		return reply(result.body, result.status);
	}
	if (resource === "duplicate" && revisionId === "undo" &&
		request.method === "POST" && segments.length === 3) {
		const input = url.searchParams.get("baseSequence") ?? "";
		if (!/^[1-9]\d{0,18}$/.test(input) || BigInt(input) > 9223372036854775807n)
			return reply({ code: "INVALID_BASE_SEQUENCE" }, 400);
		const result = await ctx.runMutation(internal.notes.undoNoteCopy, {
			id,
			baseSequence: BigInt(input),
			...(await legacyReadCredential(request)),
		});
		return reply(result.body, result.status);
	}
	if (resource === "attachments" && segments.length <= 3) {
		const { apiTokenHash } = await legacyReadCredential(request);
		return legacyAttachmentRequest(ctx, request, id, apiTokenHash, revisionId);
	}
	if (resource === "shares" && segments.length === 2)
		return noteSharesRequest(ctx, request, id);
	if (resource === "revisions") {
		const credentials = await legacyReadCredential(request);
		if (
			request.method === "POST" &&
			segments.length === 4 &&
			action === "restore"
		) {
			const version = url.searchParams.get("baseVersion");
			const baseVersion = version === null ? undefined : Number(version);
			if (
				baseVersion !== undefined &&
				(!/^[1-9]\d*$/.test(version ?? "") ||
					!Number.isSafeInteger(baseVersion))
			)
				return reply({ code: "INVALID_BASE_VERSION" }, 400);
			const result = await ctx.runMutation(
				internal.notes.legacyRestoreRevision,
				{ id, revisionId, baseVersion, ...credentials },
			);
			return reply(result.body, result.status);
		}
		if (request.method === "GET" && segments.length <= 3) {
			const limit = revisionId
				? 30
				: Number(url.searchParams.get("limit") ?? 30);
			const cursor = revisionId
				? undefined
				: url.searchParams.get("cursor") || undefined;
			if (
				!Number.isInteger(limit) ||
				limit < 1 ||
				limit > 100 ||
				(cursor && cursor.length > 128)
			)
				return reply({ code: "INVALID_REVISION_PAGE" }, 400);
			const result = await ctx.runQuery(internal.notes.legacyHistory, {
				id,
				revisionId,
				cursor,
				limit,
				...credentials,
				withContent: url.searchParams.get("withContent") === "true",
			});
			return reply(result.body, result.status);
		}
	}
	if (request.method !== "GET" || segments.length !== 1)
		return reply({ code: "NOTE_NOT_FOUND" }, 404);
	const result = await ctx.runQuery(internal.notes.legacyDetail, {
		id,
		...(await legacyReadCredential(request)),
	});
	if (result.type === "unauthenticated")
		return reply({ code: "UNAUTHENTICATED" }, 401);
	if (result.type === "missing") return reply({ code: "NOTE_NOT_FOUND" }, 404);
	return reply(result.note);
});
