import * as passkeyHttp from "./passkeyHttp";
import * as apiTokenHttp from "./apiTokenHttp";
import { userExport, userExportPart } from "./userExportHttp";
import { httpRouter } from "convex/server";
import { ConvexError } from "convex/values";
import { Data, Effect, Schema } from "effect";
import {
	importAttachment,
	importNotes,
} from "./userImportHttp";
import {
	ANCHOR_PROTOCOL,
	SUPPORTED_PROTOCOLS,
} from "../../server/src/common/protocol/protocol.constants";
import { api, internal } from "./_generated/api";
import {
	attachmentCollection,
	deleteAttachment,
	downloadAttachment,
	uploadAttachment,
} from "./attachments";
import { httpAction } from "./_generated/server";
import { listNotes, listTags, writeTag } from "./legacyListsHttp";
import { bulkNotes, createNote, writeNote } from "./legacyNoteWritesHttp";
import {
	maxClientRevisions,
	maxPositionsPerRequest,
	orderKeyPattern,
	outboxScopeChanged,
	pushNoteChanges,
	reminderWallClock,
} from "./notes";
import * as oidcHttp from "./oidcHttp";
import { adminOidcSettings } from "./oidcSettingsHttp";
import { noteStates, reminderRecurrences } from "./schema";
import * as sessionHttp from "./sessionHttp";
import { authorizedIdentity } from "./sessions";
import { syncEvents } from "./syncEvents";
import {
	downloadProfileImage,
	profilePathPrefix,
	updateProfileImage,
} from "./profiles";

const createNoteInput = Schema.Struct({
	id: Schema.String.check(
		Schema.isPattern(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i),
	),
	title: Schema.String,
	content: Schema.optionalKey(Schema.String),
	background: Schema.optionalKey(Schema.String),
});

class InvalidBody extends Data.TaggedError("InvalidBody") {}
class InvalidSyncCursor extends Data.TaggedError("InvalidSyncCursor") {}
class NoteIdConflict extends Data.TaggedError("NoteIdConflict") {}

function json(body: unknown, status = 200) {
	return Response.json(body, {
		status,
		headers: { "Cache-Control": "no-store" },
	});
}

function readJson(request: Request) {
	return Effect.tryPromise({
		try: (): Promise<unknown> => request.json(),
		catch: () => new InvalidBody(),
	});
}

const http = httpRouter();

http.route({ path: "/api/sync/events", method: "GET", handler: syncEvents });
http.route({
	path: "/api/health",
	method: "GET",
	handler: httpAction(async () =>
		json({
			status: "ok",
			app: "anchor",
			version: process.env.ANCHOR_APP_VERSION,
			protocols: SUPPORTED_PROTOCOLS,
			timestamp: new Date().toISOString(),
		}),
	),
});

http.route({
	path: "/api/auth/oidc/config",
	method: "GET",
	handler: oidcHttp.configuration,
});
http.route({
	path: "/api/auth/oidc/initiate",
	method: "GET",
	handler: oidcHttp.initiate,
});
http.route({
	path: "/api/auth/oidc/callback",
	method: "GET",
	handler: oidcHttp.callback,
});
http.route({
	path: "/api/auth/oidc/exchange",
	method: "POST",
	handler: oidcHttp.exchange,
});

http.route({
	path: "/api/auth/oidc/exchange/mobile",
	method: "POST",
	handler: oidcHttp.exchangeLegacyMobile,
});

http.route({
	path: "/api/auth/oidc/exchange/compose",
	method: "POST",
	handler: oidcHttp.exchangeCompose,
});

for (const method of ["GET", "PATCH"] as const) {
	http.route({
		path: "/api/admin/settings/oidc",
		method,
		handler: adminOidcSettings,
	});
}

for (const method of ["GET", "PATCH"] as const) {
	http.route({
		path: "/api/admin/settings/two-factor",
		method,
		handler: sessionHttp.adminTwoFactorPolicy,
	});
}

for (const path of ["/api/admin/users", "/api/admin/users/pending"]) {
	http.route({ path, method: "GET", handler: sessionHttp.adminDirectory });
}
http.route({
	path: "/api/admin/stats",
	method: "GET",
	handler: sessionHttp.adminStats,
});
http.route({
	path: "/api/admin/users",
	method: "POST",
	handler: sessionHttp.adminAccountCreate,
});
http.route({
	pathPrefix: "/api/admin/users/",
	method: "POST",
	handler: sessionHttp.adminAccountPost,
});

http.route({
	pathPrefix: "/api/admin/users/",
	method: "PATCH",
	handler: sessionHttp.adminAccountPatch,
});
http.route({
	pathPrefix: "/api/admin/users/",
	method: "DELETE",
	handler: sessionHttp.adminAccountDelete,
});
for (const method of ["GET", "PATCH"] as const) {
	http.route({
		path: "/api/admin/settings/registration",
		method,
		handler: sessionHttp.adminSignupSettings,
	});
}
for (const path of ["passkeys/login", "passkeys/register", "enroll/passkey"]) {
	for (const operation of ["options", "verify"]) {
		http.route({
			path: `/api/auth/${path}/${operation}`,
			method: "POST",
			handler: passkeyHttp.ceremony,
		});
	}
}
for (const method of ["PATCH", "DELETE"] as const) {
	http.route({ pathPrefix: "/api/auth/passkeys/", method, handler: passkeyHttp.manage });
}
http.route({
	path: "/api/auth/capabilities",
	method: "GET",
	handler: sessionHttp.capabilities,
});
http.route({
	path: "/api/auth/registration-mode",
	method: "GET",
	handler: sessionHttp.registrationMode,
});
http.route({
	path: "/api/auth/register",
	method: "POST",
	handler: sessionHttp.register,
});
http.route({
	path: "/api/auth/login",
	method: "POST",
	handler: sessionHttp.login,
});
http.route({
	path: "/api/auth/2fa",
	method: "GET",
	handler: sessionHttp.authenticatorStatus,
});
http.route({
	path: "/api/auth/2fa/setup",
	method: "POST",
	handler: sessionHttp.setupAuthenticator,
});
http.route({
	path: "/api/auth/2fa/enable",
	method: "POST",
	handler: sessionHttp.enableAuthenticator,
});
http.route({
	path: "/api/auth/2fa/disable",
	method: "POST",
	handler: sessionHttp.disableAuthenticator,
});
http.route({
	path: "/api/auth/2fa/recovery-codes",
	method: "POST",
	handler: sessionHttp.regenerateRecoveryCodes,
});
http.route({
	path: "/api/auth/enroll/totp/setup",
	method: "POST",
	handler: sessionHttp.setupRequiredAuthenticator,
});
http.route({
	path: "/api/auth/enroll/totp/enable",
	method: "POST",
	handler: sessionHttp.enableRequiredAuthenticator,
});
http.route({
	path: "/api/auth/login/2fa",
	method: "POST",
	handler: sessionHttp.loginFactor,
});
http.route({
	path: "/api/auth/refresh",
	method: "POST",
	handler: sessionHttp.refresh,
});
http.route({
	path: "/api/auth/clipper/session",
	method: "POST",
	handler: sessionHttp.clipperSession,
});
http.route({
	path: "/api/auth/logout",
	method: "POST",
	handler: sessionHttp.logout,
});
for (const method of ["GET", "DELETE"] as const) {
	http.route({
		path: "/api/auth/api-token",
		method,
		handler: apiTokenHttp.manage,
	});
}
http.route({
	path: "/api/auth/api-token/regenerate",
	method: "POST",
	handler: apiTokenHttp.manage,
});
for (const path of ["/api/notes", "/api/notes/archive", "/api/notes/trash"]) {
	http.route({ path, method: "GET", handler: listNotes });
}
http.route({ path: "/api/notes", method: "POST", handler: createNote });
http.route({ path: "/api/import/notes", method: "POST", handler: importNotes });
http.route({ path: "/api/export", method: "GET", handler: userExport });
http.route({ pathPrefix: "/api/export/", method: "GET", handler: userExportPart });
http.route({ pathPrefix: "/api/import/notes/", method: "POST", handler: importAttachment });
for (const action of ["archive", "delete", "pin", "tags"]) {
	http.route({
		path: "/api/notes/bulk/" + action,
		method: "POST",
		handler: bulkNotes,
	});
}
for (const method of ["PATCH", "DELETE"] as const) {
	http.route({ pathPrefix: "/api/notes/", method, handler: writeNote });
}
http.route({ path: "/api/tags", method: "GET", handler: listTags });
http.route({ pathPrefix: "/api/tags/", method: "GET", handler: listTags });
http.route({ path: "/api/tags", method: "POST", handler: writeTag });
for (const method of ["PATCH", "DELETE"] as const) {
	http.route({ pathPrefix: "/api/tags/", method, handler: writeTag });
}

for (const method of ["GET", "POST"] as const) {
	http.route({
		pathPrefix: "/api/notes/",
		method,
		handler: apiTokenHttp.noteDetail,
	});
}

for (const path of ["/api/users/search", "/api/users/recent-contacts"]) {
	http.route({ path, method: "GET", handler: apiTokenHttp.contacts });
}

http.route({ path: "/api/auth/me", method: "GET", handler: sessionHttp.me });
http.route({
	path: "/api/auth/profile",
	method: "PATCH",
	handler: sessionHttp.updateProfile,
});
http.route({
	path: "/api/auth/change-password",
	method: "POST",
	handler: sessionHttp.changePassword,
});
http.route({
	path: "/api/auth/delete-account",
	method: "POST",
	handler: sessionHttp.deleteAccount,
});
http.route({
	path: "/api/auth/convex-token",
	method: "POST",
	handler: sessionHttp.exchange,
});

for (const method of ["POST", "DELETE"] as const) {
	http.route({
		path: "/api/auth/profile/image",
		method,
		handler: updateProfileImage,
	});
}

http.route({
	pathPrefix: profilePathPrefix,
	method: "GET",
	handler: downloadProfileImage,
});

http.route({
	path: "/api/compose/notes",
	method: "POST",
	handler: httpAction(async (ctx, request) => {
		if (!(await authorizedIdentity(ctx))) {
			return json({ code: "UNAUTHENTICATED" }, 401);
		}
		if (await outboxScopeChanged(ctx, request)) return json({ code: "OUTBOX_SCOPE_CHANGED" }, 409);
		const response = Effect.gen(function* () {
			const body = yield* readJson(request);
			const input = yield* Schema.decodeUnknownEffect(createNoteInput)(body);
			const note = yield* Effect.tryPromise({
				try: () => ctx.runMutation(api.notes.create, input),
				catch: (error) => {
					if (
						error instanceof ConvexError &&
						error.data === "NOTE_ID_CONFLICT"
					) {
						return new NoteIdConflict();
					}
					throw error;
				},
			});
			return json(note);
		});
		return Effect.runPromise(
			response.pipe(
				Effect.catchTags({
					InvalidBody: () =>
						Effect.succeed(json({ code: "INVALID_NOTE" }, 400)),
					SchemaError: () =>
						Effect.succeed(json({ code: "INVALID_NOTE" }, 400)),
					NoteIdConflict: () =>
						Effect.succeed(json({ code: "NOTE_ID_CONFLICT" }, 409)),
				}),
			),
		);
	}),
});

const revisionInput = Schema.Struct({
	id: Schema.String.check(Schema.isBetweenLength(1, 128)),
	title: Schema.String,
	content: Schema.optionalKey(Schema.NullOr(Schema.String)),
	version: Schema.optionalKey(
		Schema.Int.check(
			Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		),
	),
	cause: Schema.Literals(["edit", "restore"]),
	createdAt: Schema.String,
});

const syncInput = Schema.Struct({
	cursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(8192))),
	attachmentMetadata: Schema.optionalKey(Schema.Boolean),
	attachmentOrder: Schema.optionalKey(Schema.Boolean),
	limit: Schema.optionalKey(
		Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
	),
	changes: Schema.optionalKey(
		Schema.Array(
			Schema.Union([
				Schema.Struct({
					type: Schema.Literal("note"),
					id: Schema.String,
					title: Schema.String,
					createdAt: Schema.optionalKey(Schema.String),
					revisions: Schema.optionalKey(
						Schema.mutable(
							Schema.Array(revisionInput).check(
								Schema.isMaxLength(maxClientRevisions),
							),
						),
					),
					revisionsOnly: Schema.optionalKey(Schema.Boolean),
					requireRevisionWrite: Schema.optionalKey(Schema.Boolean),
					isArchived: Schema.optionalKey(Schema.Boolean),
					tagIds: Schema.optionalKey(
						Schema.mutable(Schema.Array(Schema.String)),
					),
					state: Schema.optionalKey(Schema.Literals(noteStates)),
					background: Schema.optionalKey(Schema.NullOr(Schema.String)),
					content: Schema.optionalKey(Schema.NullOr(Schema.String)),
					baseVersion: Schema.optionalKey(
						Schema.Int.check(
							Schema.isBetween({
								minimum: 1,
								maximum: Number.MAX_SAFE_INTEGER,
							}),
						),
					),
				}),
				Schema.Struct({
					type: Schema.Literal("pin"),
					id: Schema.String,
					isPinned: Schema.Boolean,
				}),
				Schema.Struct({
					type: Schema.Literal("reminder"),
					id: Schema.String,
					remindAt: Schema.optionalKey(
						Schema.NullOr(
							Schema.String.check(Schema.isPattern(reminderWallClock)),
						),
					),
					recurrence: Schema.optionalKey(Schema.Literals(reminderRecurrences)),
					baseVersion: Schema.optionalKey(
						Schema.Int.check(
							Schema.isBetween({
								minimum: 1,
								maximum: Number.MAX_SAFE_INTEGER,
							}),
						),
					),
				}),
				Schema.Struct({
					type: Schema.Literal("tag"),
					id: Schema.String,
					name: Schema.String,
					color: Schema.optionalKey(Schema.NullOr(Schema.String)),
					isDeleted: Schema.optionalKey(Schema.Boolean),
					baseVersion: Schema.optionalKey(
						Schema.Int.check(
							Schema.isBetween({
								minimum: 1,
								maximum: Number.MAX_SAFE_INTEGER,
							}),
						),
					),
				}),
			]),
		).check(Schema.isMaxLength(200)),
	),
});

const legacySyncInput = Schema.Struct({
	cursor: syncInput.fields.cursor,
	changes: syncInput.fields.changes,
	limit: Schema.optionalKey(
		Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })),
	),
});

function oldSyncCursor(cursor: string) {
	if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return false;
	try {
		const bytes = Uint8Array.from(
			atob(cursor.replace(/-/g, "+").replace(/_/g, "/")),
			(byte) => byte.charCodeAt(0),
		);
		const wire = JSON.parse(new TextDecoder().decode(bytes));
		if (wire?.v !== 3) return false;
		if (wire.m === "d")
			return typeof wire.s === "string" && /^\d+$/.test(wire.s);
		return (
			wire.m === "s" &&
			["tags", "notes", "attachments", "pins"].includes(wire.p) &&
			(wire.a === null || typeof wire.a === "string") &&
			typeof wire.c === "string" &&
			/^\d+$/.test(wire.c)
		);
	} catch {
		return false;
	}
}

http.route({
	path: "/api/sync",
	method: "POST",
	handler: httpAction(async (ctx, request) => {
		const header = request.headers.get("x-anchor-protocol");
		const protocol = header === null ? ANCHOR_PROTOCOL : Number(header);
		if (!SUPPORTED_PROTOCOLS.includes(protocol)) {
			const newer = protocol > ANCHOR_PROTOCOL;
			return json(
				{
					code: newer ? "SERVER_OUTDATED" : "APP_OUTDATED",
					message: newer
						? "Your Anchor server is too old to sync with this app. Update the server to continue."
						: "This app is too old to sync with your Anchor server. Update the app to continue.",
					protocols: SUPPORTED_PROTOCOLS,
				},
				426,
			);
		}
		const credential = await apiTokenHttp.legacyReadCredential(request);
		if (!credential.apiTokenHash) return json({ code: "UNAUTHENTICATED" }, 401);
		const response = Effect.gen(function* () {
			const body = yield* readJson(request);
			const { cursor, changes, limit } =
				yield* Schema.decodeUnknownEffect(legacySyncInput)(body);
			const reset = cursor ? oldSyncCursor(cursor) : false;
			const readPage = (size: number) =>
				Effect.tryPromise({
					try: () =>
						ctx.runQuery(internal.notes.legacySyncPage, {
							...credential,
							reset,
							cursor: reset ? undefined : cursor || undefined,
							limit: size,
						}),
					catch: (error) => {
						if (
							error instanceof ConvexError &&
							error.data === "INVALID_FEED_CURSOR"
						)
							return new InvalidSyncCursor();
						throw error;
					},
				});
			const size = limit ?? 200;
			const first = yield* readPage(changes?.length ? 1 : size);
			if (!first) return json({ code: "UNAUTHENTICATED" }, 401);
			const results = changes?.length
				? yield* Effect.tryPromise({
						try: () => pushNoteChanges(ctx, changes, credential),
						catch: (error) => {
							if (
								error instanceof ConvexError &&
								error.data === "INVALID_CLIENT_REVISION"
							)
								return new InvalidBody();
							throw error;
						},
					})
				: [];
			const page =
				changes?.length && !("resetRequired" in first)
					? yield* readPage(size)
					: first;
			if (!page)
				return json({
					protocol,
					results,
					entries: [],
					nextCursor: null,
					hasMore: false,
					resetRequired: true,
				});
			return json({ ...page, protocol, results });
		});
		return Effect.runPromise(
			response.pipe(
				Effect.catchTags({
					InvalidBody: () =>
						Effect.succeed(json({ code: "INVALID_SYNC_REQUEST" }, 400)),
					SchemaError: () =>
						Effect.succeed(json({ code: "INVALID_SYNC_REQUEST" }, 400)),
					InvalidSyncCursor: () =>
						Effect.succeed(json({ code: "INVALID_SYNC_CURSOR" }, 400)),
				}),
			),
		);
	}),
});

http.route({
	path: "/api/compose/sync",
	method: "POST",
	handler: httpAction(async (ctx, request) => {
		if (!(await authorizedIdentity(ctx)))
			return json({ code: "UNAUTHENTICATED" }, 401);
		if (await outboxScopeChanged(ctx, request)) return json({ code: "OUTBOX_SCOPE_CHANGED" }, 409);

		const response = Effect.gen(function* () {
			const body = yield* readJson(request);
			const { cursor, limit, changes, attachmentMetadata, attachmentOrder } =
				yield* Schema.decodeUnknownEffect(syncInput, {
					onExcessProperty: "error",
				})(body);
			const args = {
				...(cursor === undefined ? {} : { cursor }),
				...(limit === undefined ? {} : { limit }),
				...(attachmentMetadata === undefined ? {} : { attachmentMetadata }),
				...(attachmentOrder === undefined ? {} : { attachmentOrder }),
			};
			const pull = (pageSize?: number) =>
				Effect.tryPromise({
					try: () =>
						ctx.runQuery(
							api.notes.syncPage,
							pageSize === undefined ? args : { ...args, limit: pageSize },
						),
					catch: (error) => {
						if (
							error instanceof ConvexError &&
							error.data === "INVALID_FEED_CURSOR"
						) {
							return new InvalidSyncCursor();
						}
						throw error;
					},
				});

			if (!changes?.length) {
				const page = yield* pull();
				const reply = json({ ...page, results: [] });
				const scope = /^n[145]:@([0-9a-f]{64}):/.exec(page.nextCursor ?? "")?.[1];
				if (scope) reply.headers.set("X-Anchor-Sync-Scope", scope);
				return reply;
			}
			if (cursor !== undefined) {
				const preflight = yield* pull(1);
				if (preflight.nextCursor === null)
					return json({ ...preflight, results: [] });
			}
			const results = yield* Effect.tryPromise({
				try: () => pushNoteChanges(ctx, changes),
				catch: (error) => {
					if (
						error instanceof ConvexError &&
						error.data === "INVALID_CLIENT_REVISION"
					) {
						return new InvalidBody();
					}
					throw error;
				},
			});
			return json({ ...(yield* pull()), results });
		});

		return Effect.runPromise(
			response.pipe(
				Effect.catchTags({
					InvalidBody: () =>
						Effect.succeed(json({ code: "INVALID_SYNC_REQUEST" }, 400)),
					SchemaError: () =>
						Effect.succeed(json({ code: "INVALID_SYNC_REQUEST" }, 400)),
					InvalidSyncCursor: () =>
						Effect.succeed(json({ code: "INVALID_SYNC_CURSOR" }, 400)),
				}),
			),
		);
	}),
});

const position = Schema.NullOr(
	Schema.String.check(Schema.isPattern(orderKeyPattern)),
);
const positionId = Schema.String.check(Schema.isMinLength(1));
const notePositionsInput = Schema.Struct({
	positions: Schema.Array(
		Schema.Struct({ noteId: positionId, position }),
	).check(Schema.isMaxLength(maxPositionsPerRequest)),
});
const tagPositionsInput = Schema.Struct({
	positions: Schema.Array(Schema.Struct({ id: positionId, position })).check(
		Schema.isMaxLength(maxPositionsPerRequest),
	),
});

const orderGroup = Schema.Array(Schema.Struct({ id: positionId, position })).check(
	Schema.isMaxLength(maxPositionsPerRequest),
);
const noteMove = {
	noteId: positionId,
	step: Schema.Int.check(Schema.isBetween({
		minimum: 1 - maxPositionsPerRequest,
		maximum: maxPositionsPerRequest - 1,
	})),
};
const moveNoteInput = Schema.Union([
	Schema.Struct({ ...noteMove, notes: orderGroup }),
	Schema.Struct({ ...noteMove, groups: Schema.Struct({ moved: orderGroup, other: orderGroup }) }),
]);

http.route({
	path: "/api/compose/notes/order",
	method: "POST",
	handler: httpAction(async (ctx, request) => {
		if (!(await authorizedIdentity(ctx))) return json({ code: "UNAUTHENTICATED" }, 401);
		return Effect.runPromise(
			Effect.gen(function* () {
				const body = yield* readJson(request);
				const input = yield* Schema.decodeUnknownEffect(moveNoteInput)(body);
				const groups = "groups" in input ? input.groups : { moved: input.notes };
				const applied = yield* Effect.promise(() => ctx.runMutation(api.notes.moveNote, {
					noteId: input.noteId,
					step: input.step,
					notes: [...groups.moved],
					...("other" in groups ? { otherGroup: [...groups.other] } : {}),
				}));
				return applied ? json({ applied }) : json({ code: "STALE_ORDER" }, 409);
			}).pipe(Effect.catchTags({
				InvalidBody: () => Effect.succeed(json({ code: "INVALID_POSITIONS" }, 400)),
				SchemaError: () => Effect.succeed(json({ code: "INVALID_POSITIONS" }, 400)),
			})),
		);
	}),
});

function positionAction(kind: "note" | "tag") {
	return httpAction(async (ctx, request) => {
		const credential = await apiTokenHttp.legacyReadCredential(request);
		if (!credential.apiTokenHash) return json({ code: "UNAUTHENTICATED" }, 401);
		const response = Effect.gen(function* () {
			const body = yield* readJson(request);
			const options = { onExcessProperty: "error" } as const;
			const positions = yield* kind === "note"
				? Schema.decodeUnknownEffect(
						notePositionsInput,
						options,
					)(body).pipe(
						Effect.map((input) =>
							input.positions.map(({ noteId, position }) => ({
								id: noteId,
								position,
							})),
						),
					)
				: Schema.decodeUnknownEffect(
						tagPositionsInput,
						options,
					)(body).pipe(Effect.map((input) => [...input.positions]));
			const result = yield* Effect.promise(() =>
				ctx.runMutation(internal.notes.legacyPlace, {
					kind,
					positions,
					...credential,
				}),
			);
			return result ? json(result) : json({ code: "UNAUTHENTICATED" }, 401);
		});
		return Effect.runPromise(
			response.pipe(
				Effect.catchTags({
					InvalidBody: () =>
						Effect.succeed(json({ code: "INVALID_POSITIONS" }, 400)),
					SchemaError: () =>
						Effect.succeed(json({ code: "INVALID_POSITIONS" }, 400)),
				}),
			),
		);
	});
}

http.route({
	path: "/api/notes/positions",
	method: "PUT",
	handler: positionAction("note"),
});
http.route({
	path: "/api/tags/positions",
	method: "PUT",
	handler: positionAction("tag"),
});

http.route({
	path: "/api/compose/attachments",
	method: "POST",
	handler: uploadAttachment,
});
http.route({
	path: "/api/compose/attachments",
	method: "GET",
	handler: downloadAttachment,
});

http.route({
	path: "/api/compose/attachments",
	method: "DELETE",
	handler: deleteAttachment,
});

for (const method of ["GET", "PATCH"] as const) {
	http.route({
		path: "/api/compose/attachments/list",
		method,
		handler: attachmentCollection,
	});
}

export default http;
