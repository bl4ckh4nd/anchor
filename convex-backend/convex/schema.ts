import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const sharePermission = v.union(
	v.literal("viewer"),
	v.literal("editor"),
);

export const noteStates = ["active", "trashed", "deleted"] as const;
export const noteState = v.union(
	...noteStates.map((state) => v.literal(state)),
);

export const reminderRecurrences = [
	"none",
	"daily",
	"weekly",
	"monthly",
	"yearly",
] as const;
export const reminderRecurrence = v.union(
	...reminderRecurrences.map((value) => v.literal(value)),
);

export const oidcFields = {
	enabled: v.boolean(),
	providerName: v.string(),
	issuerUrl: v.string(),
	clientId: v.string(),
	clientSecret: v.string(),
	disableInternalAuth: v.boolean(),
};

export default defineSchema({
	exportDownloads: defineTable({
		issuer: v.string(),
		subject: v.string(),
		storageId: v.id("_storage"),
		expiresAt: v.number(),
	}),
	oidcFlows: defineTable({
		issuer: v.string(),
		providerIssuer: v.string(),
		clientId: v.string(),
		digest: v.string(),
		browserDigest: v.string(),
		mobileChallenge: v.optional(v.string()),
		redirect: v.string(),
		expiresAt: v.number(),
		payload: v.union(
			v.object({
				type: v.literal("state"),
				verifier: v.string(),
				nonce: v.string(),
			}),
			v.object({
				type: v.literal("exchange"),
				subject: v.string(),
				email: v.string(),
				name: v.string(),
			}),
		),
	})
		.index("by_digest", ["digest"])
		.index("by_expires_at", ["expiresAt"]),
	oidcSettings: defineTable({ issuer: v.string(), ...oidcFields }).index(
		"by_issuer",
		["issuer"],
	),
	registrationPolicies: defineTable({
		issuer: v.string(),
		mode: v.union(
			v.literal("disabled"),
			v.literal("enabled"),
			v.literal("review"),
		),
	}).index("by_issuer", ["issuer"]),
	authPolicies: defineTable({
		issuer: v.string(),
		policy: v.union(
			v.literal("optional"),
			v.literal("admins"),
			v.literal("everyone"),
		),
	}).index("by_issuer", ["issuer"]),
	accounts: defineTable({
		id: v.string(),
		issuer: v.string(),
		email: v.string(),
		name: v.string(),
		status: v.union(v.literal("active"), v.literal("pending")),
		isAdmin: v.boolean(),
		profileImage: v.union(v.string(), v.null()),
		passwordHash: v.union(v.string(), v.null()),
		apiTokenHash: v.union(v.string(), v.null()),
		oidcSubject: v.union(v.string(), v.null()),
		oidcIssuer: v.optional(v.string()),
		totpSecretEnc: v.union(v.string(), v.null()),
		totpPendingSecretEnc: v.union(v.string(), v.null()),
		totpEnabledAt: v.union(v.number(), v.null()),
		totpLastStep: v.union(v.number(), v.null()),
		totpLastUsedAt: v.union(v.number(), v.null()),
		twoFactorFailedAttempts: v.number(),
		twoFactorLockedUntil: v.union(v.number(), v.null()),
		sessionsRevokedAt: v.union(v.number(), v.null()),
		factorResetVersion: v.optional(v.number()),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_issuer_id", ["issuer", "id"])
		.index("by_issuer_admin", ["issuer", "isAdmin"])
		.index("by_issuer_created_at", ["issuer", "createdAt"])
		.index("by_issuer_email", ["issuer", "email"])
		.index("by_profile_image", ["profileImage"])
		.index("by_api_token", ["issuer", "apiTokenHash"])
		.index("by_oidc_subject", ["issuer", "oidcIssuer", "oidcSubject"]),
	sessions: defineTable({
		factorResetVersion: v.optional(v.number()),
		issuer: v.string(),
		userId: v.string(),
		expiresAt: v.number(),
		totpVerified: v.optional(v.literal(true)),
		passkeyVerified: v.optional(v.literal(true)),
		method: v.optional(v.literal("oidc")),
	})
		.index("by_expires_at", ["expiresAt"])
		.index("by_account", ["issuer", "userId"]),
	loginChallenges: defineTable({
		factorResetVersion: v.optional(v.number()),
		enroll: v.optional(v.literal(true)),
		pending: v.optional(v.string()),
		accountId: v.id("accounts"),
		accountUpdatedAt: v.number(),
		digest: v.string(),
		attempts: v.number(),
		expiresAt: v.number(),
	})
		.index("by_digest", ["digest"])
		.index("by_expires_at", ["expiresAt"])
		.index("by_account", ["accountId"]),
	refreshTokens: defineTable({
		digest: v.string(),
		sessionId: v.id("sessions"),
		expiresAt: v.number(),
		successor: v.optional(v.string()),
	})
		.index("by_digest", ["digest"])
		.index("by_expires_at", ["expiresAt"])
		.index("by_session", ["sessionId"]),
	passwordAttempts: defineTable({
		key: v.string(),
		count: v.number(),
		resetAt: v.number(),
	}).index("by_key", ["key"]),
	recoveryCodes: defineTable({
		id: v.string(),
		userId: v.string(),
		codeHash: v.string(),
		usedAt: v.union(v.number(), v.null()),
		createdAt: v.number(),
	})
		.index("by_user", ["userId"])
		.index("by_user_hash", ["userId", "codeHash"]),
	passkeyChallenges: defineTable({
		key: v.string(),
		challenge: v.string(),
		origin: v.string(),
		expiresAt: v.number(),
		mode: v.union(
			v.literal("login"),
			v.literal("register"),
			v.literal("enroll"),
		),
		sessionId: v.optional(v.string()),
	})
		.index("by_key", ["key"])
		.index("by_mode_expiry", ["mode", "expiresAt"])
		.index("by_expires_at", ["expiresAt"]),
	passkeys: defineTable({
		id: v.string(),
		userId: v.string(),
		credentialId: v.string(),
		publicKey: v.string(),
		counter: v.string(),
		transports: v.array(v.string()),
		name: v.string(),
		deviceType: v.string(),
		backedUp: v.boolean(),
		createdAt: v.number(),
		lastUsedAt: v.union(v.number(), v.null()),
	})
		.index("by_user", ["userId"])
		.index("by_credential", ["credentialId"]),
	profileImages: defineTable({
		path: v.string(),
		storageId: v.id("_storage"),
		mimeType: v.union(
			v.literal("image/png"),
			v.literal("image/jpeg"),
			v.literal("image/webp"),
			v.literal("image/gif"),
		),
		fileSize: v.number(),
	})
		.index("by_path", ["path"])
		.index("by_storage_id", ["storageId"]),
	notes: defineTable({
		id: v.string(),
		issuer: v.string(),
		owner: v.string(),
		state: v.optional(noteState),
		stateChangedAt: v.optional(v.number()),
		background: v.optional(v.union(v.string(), v.null())),
		title: v.string(),
		content: v.union(v.string(), v.null()),
		createdAt: v.optional(v.number()),
		version: v.number(),
		updatedAt: v.number(),
		copyUndoSequence: v.optional(v.int64()),
	})
		.index("by_note_id", ["id"])
		.index("by_owner_id", ["issuer", "owner", "id"])
		.index("by_state_age", ["state", "stateChangedAt", "updatedAt"]),
	noteShares: defineTable({
		noteId: v.id("notes"),
		subject: v.string(),
		permission: sharePermission,
		isRevoked: v.optional(v.boolean()),
		legacyId: v.optional(v.string()),
		sharedByUserId: v.optional(v.string()),
		createdAt: v.optional(v.number()),
		updatedAt: v.optional(v.number()),
	})
		.index("by_note_subject", ["noteId", "subject"])
		.index("by_subject", ["subject"])
		.index("by_sharer", ["sharedByUserId"])
		.index("by_sharer_updated", ["sharedByUserId", "updatedAt"])
		.index("by_revocation_age", ["isRevoked", "updatedAt"]),
	noteReminders: defineTable({
		noteId: v.id("notes"),
		subject: v.string(),
		remindAt: v.union(v.string(), v.null()),
		recurrence: reminderRecurrence,
		version: v.number(),
	})
		.index("by_note_subject", ["noteId", "subject"])
		.index("by_subject", ["subject"]),
	notePins: defineTable({
		noteId: v.id("notes"),
		subject: v.string(),
	})
		.index("by_note_subject", ["noteId", "subject"])
		.index("by_subject", ["subject"]),
	notePositions: defineTable({
		noteId: v.id("notes"),
		subject: v.string(),
		position: v.string(),
	})
		.index("by_note_subject", ["noteId", "subject"])
		.index("by_subject", ["subject"]),
	noteArchives: defineTable({
		noteId: v.id("notes"),
		subject: v.string(),
	})
		.index("by_note_subject", ["noteId", "subject"])
		.index("by_subject", ["subject"]),
	noteRevisions: defineTable({
		noteId: v.id("notes"),
		clientId: v.optional(v.string()),
		legacyId: v.optional(v.string()),
		reportedAt: v.optional(v.number()),
		version: v.number(),
		title: v.string(),
		content: v.union(v.string(), v.null()),
		authorSubject: v.union(v.string(), v.null()),
		cause: v.union(
			v.literal("edit"),
			v.literal("restore"),
			v.literal("conflict"),
		),
	})
		.index("by_note", ["noteId"])
		.index("by_note_legacy_id", ["noteId", "legacyId"])
		.index("by_note_client_id", ["noteId", "clientId"])
		.index("by_author", ["authorSubject"])
		.index("by_reported_at", ["reportedAt"])
		.index("by_cause_date", ["cause", "reportedAt"])
		.index("by_note_date", ["noteId", "reportedAt", "legacyId"]),
	noteAttachments: defineTable({
		id: v.string(),
		noteId: v.id("notes"),
		storageId: v.id("_storage"),
		uploadedByUserId: v.string(),
		originalFilename: v.string(),
		mimeType: v.string(),
		fileSize: v.number(),
		position: v.optional(v.number()),
		createdAt: v.optional(v.number()),
		deletedAt: v.optional(v.number()),
	})
		.index("by_note_id", ["noteId", "id"])
		.index("by_note_deleted_at", ["noteId", "deletedAt"])
		.index("by_storage_id", ["storageId"])
		.index("by_uploader", ["uploadedByUserId"]),
	noteTags: defineTable({
		noteId: v.id("notes"),
		subject: v.string(),
		tagIds: v.array(v.id("tags")),
	})
		.index("by_note_subject", ["noteId", "subject"])
		.index("by_subject", ["subject"]),
	tags: defineTable({
		id: v.string(),
		issuer: v.string(),
		owner: v.string(),
		name: v.string(),
		color: v.union(v.string(), v.null()),
		position: v.union(v.string(), v.null()),
		version: v.number(),
		updatedAt: v.number(),
		isDeleted: v.boolean(),
		createdAt: v.optional(v.number()),
	})
		.index("by_tag_id", ["id"])
		.index("by_owner_name", ["issuer", "owner", "isDeleted", "name"])
		.index("by_owner_id", ["issuer", "owner", "isDeleted", "id"])
		.index("by_deletion_age", ["isDeleted", "updatedAt"]),
	noteFeedHeads: defineTable({
		issuer: v.string(),
		subject: v.string(),
		lastSeq: v.int64(),
		prunedThroughSeq: v.optional(v.int64()),
		eventStreams: v.optional(
			v.array(v.object({ id: v.string(), expiresAt: v.number() })),
		),
	}).index("by_recipient", ["issuer", "subject"]),
	legacyImport: defineTable({
		bundle: v.string(),
		issuer: v.string(),
		totalBatches: v.number(),
		nextBatch: v.number(),
		counts: v.record(v.string(), v.number()),
		expectedCounts: v.record(v.string(), v.number()),
		complete: v.boolean(),
	}),
	noteFeed: defineTable({
		issuer: v.string(),
		subject: v.string(),
		seq: v.int64(),
		noteId: v.optional(v.id("notes")),
		entityId: v.string(),
		entityType: v.optional(
			v.union(v.literal("pin"), v.literal("reminder"), v.literal("tag")),
		),
		op: v.union(v.literal("upsert"), v.literal("remove")),
	})
		.index("by_recipient_seq", ["issuer", "subject", "seq"])
		.index("by_recipient_note_seq", ["issuer", "subject", "noteId", "seq"])
		.index("by_op", ["op"]),
});
