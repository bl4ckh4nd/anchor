import { paginationOptsValidator, type UserIdentity } from "convex/server";
import { type Infer, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
	internalMutation,
	internalQuery,
	type ActionCtx,
	type MutationCtx,
	type QueryCtx,
} from "./_generated/server";

import { localAuthDisabled } from "./oidcConfig";
import { passkeyRelyingParty } from "./passkeyConfig";

const day = 24 * 60 * 60 * 1000;
const sessionLifetime = 90 * day;

export function nativeAuthEnabled() {
	return process.env.ANCHOR_NATIVE_PASSWORD_AUTH === "true";
}

export function accountFor(ctx: QueryCtx, issuer: string, id: string) {
	return ctx.db
		.query("accounts")
		.withIndex("by_issuer_id", (q) => q.eq("issuer", issuer).eq("id", id))
		.unique();
}

export async function accountByApiToken(ctx: QueryCtx, hash: string) {
	const issuer = process.env.ANCHOR_AUTH_ISSUER;
	if (!nativeAuthEnabled() || !issuer) return null;
	const account = await ctx.db
		.query("accounts")
		.withIndex("by_api_token", (q) =>
			q.eq("issuer", issuer).eq("apiTokenHash", hash),
		)
		.unique();
	return account?.status === "active" ? account : null;
}

export async function legacyReadIdentity(ctx: QueryCtx, apiTokenHash?: string) {
	const identity = await authorizedIdentity(ctx);
	if (identity) return { issuer: identity.issuer, subject: identity.subject };
	const account = apiTokenHash
		? await accountByApiToken(ctx, apiTokenHash)
		: null;
	return account ? { issuer: account.issuer, subject: account.id } : null;
}

export function contactView({
	id,
	name,
	email,
	profileImage,
}: Doc<"accounts">) {
	return { id, name, email, profileImage };
}

export const legacyContactsPage = internalQuery({
	args: {
		apiTokenHash: v.optional(v.string()),
		search: v.optional(v.string()),
		page: paginationOptsValidator,
	},
	handler: async (ctx, { apiTokenHash, search, page }) => {
		const identity = await legacyReadIdentity(ctx, apiTokenHash);
		if (!identity) return null;
		const { issuer, subject } = identity;
		if (search !== undefined) {
			if (search.length < 2) return { rows: [], cursor: null };
			const accounts = await ctx.db
				.query("accounts")
				.withIndex("by_issuer_created_at", (q) => q.eq("issuer", issuer))
				.paginate(page);
			const rows = accounts.page
				.filter(
					(account) =>
						account.id !== subject &&
						account.status === "active" &&
						(account.name.toLowerCase().includes(search) ||
							account.email.toLowerCase().includes(search)),
				)
				.map(contactView);
			return { rows, cursor: accounts.isDone ? null : accounts.continueCursor };
		}
		const shares = await ctx.db
			.query("noteShares")
			.withIndex("by_sharer_updated", (q) => q.eq("sharedByUserId", subject))
			.order("desc")
			.paginate(page);
		const rows = [];
		for (const share of shares.page) {
			const note = await ctx.db.get("notes", share.noteId);
			if (note?.issuer !== issuer || note.owner !== subject) continue;
			const account = await accountFor(ctx, issuer, share.subject);
			if (account?.status === "active") rows.push(contactView(account));
		}
		return { rows, cursor: shares.isDone ? null : shares.continueCursor };
	},
});

function refreshByDigest(ctx: QueryCtx, digest: string) {
	return ctx.db
		.query("refreshTokens")
		.withIndex("by_digest", (q) => q.eq("digest", digest))
		.unique();
}

export async function accountPolicy(ctx: QueryCtx, issuer: string) {
	return (
		(
			await ctx.db
				.query("authPolicies")
				.withIndex("by_issuer", (q) => q.eq("issuer", issuer))
				.unique()
		)?.policy ?? "optional"
	);
}

export function requiresFactor(
	policy: Doc<"authPolicies">["policy"],
	account: Doc<"accounts">,
) {
	return (
		Boolean(account.passwordHash) &&
		(policy === "everyone" || (policy === "admins" && account.isAdmin))
	);
}

export function passkeysFor(ctx: QueryCtx, userId: string) {
	return ctx.db.query("passkeys").withIndex("by_user", (q) => q.eq("userId", userId));
}

export async function passkeysAvailable(ctx: QueryCtx, issuer: string) {
	return Boolean(
		nativeAuthEnabled() &&
		issuer === process.env.ANCHOR_AUTH_ISSUER &&
		passkeyRelyingParty() &&
		!(await localAuthDisabled(ctx, issuer)),
	);
}

async function activeAccount(ctx: QueryCtx, session: Doc<"sessions"> | null) {
	if (!session || session.expiresAt <= Date.now()) return null;
	const account = await accountFor(ctx, session.issuer, session.userId);
	const factorVerified = session.totpVerified || session.passkeyVerified;
	if (
		account?.status !== "active" ||
		(account.factorResetVersion ?? 0) !== (session.factorResetVersion ?? 0) ||
		(session.method === "oidc"
			? !account.oidcSubject
			: !account.passwordHash) ||
		(account.sessionsRevokedAt !== null &&
			account.sessionsRevokedAt > session._creationTime) ||
		((account.totpEnabledAt !== null || account.totpSecretEnc !== null) &&
			!factorVerified)
	)
		return null;
	if (
		!factorVerified &&
		requiresFactor(await accountPolicy(ctx, account.issuer), account)
	)
		return null;
	return account;
}

export const sessionClaims = {
	issuer: v.string(),
	subject: v.string(),
	sessionId: v.string(),
};

export async function verifiedAccount(
	ctx: QueryCtx,
	{
		issuer,
		subject,
		sessionId,
	}: {
		issuer: string;
		subject: string;
		sessionId: string;
	},
) {
	const id = ctx.db.normalizeId("sessions", sessionId);
	const session = id && (await ctx.db.get("sessions", id));
	if (!session || session.issuer !== issuer || session.userId !== subject)
		return null;
	return activeAccount(ctx, session);
}

export const validate = internalQuery({
	args: sessionClaims,
	handler: async (ctx, claims): Promise<boolean> =>
		Boolean(await verifiedAccount(ctx, claims)),
});

export const createClipperSession = internalMutation({
	args: { ...sessionClaims, refreshDigest: v.string() },
	handler: async (ctx, { issuer, subject, sessionId, refreshDigest }) => {
		const account = await verifiedAccount(ctx, { issuer, subject, sessionId });
		const id = ctx.db.normalizeId("sessions", sessionId);
		const session = id && (await ctx.db.get("sessions", id));
		if (!account || !session) return null;
		return issueSession(
			ctx,
			account,
			refreshDigest,
			session.totpVerified,
			session.passkeyVerified ? "passkey" : session.method,
		);
	},
});

export async function authenticatedIdentity(
	ctx: Pick<QueryCtx, "auth">,
): Promise<UserIdentity | null> {
	try {
		return await ctx.auth.getUserIdentity();
	} catch (error) {
		if (
			error instanceof Error &&
			(error.message.startsWith("Could not validate token:") ||
				error.message.startsWith("Could not parse JWT payload.") ||
				error.message.startsWith("Could not decode token. The JWT's 'kid' (key ID) header"))
		)
			return null;
		throw error;
	}
}

export async function authorizedIdentity(
	ctx: QueryCtx | ActionCtx,
): Promise<UserIdentity | null> {
	const identity = await authenticatedIdentity(ctx);
	if (!identity) return null;
	if (!nativeAuthEnabled())
		return identity.anchorSession === undefined ? identity : null;
	if (typeof identity.anchorSession !== "string") return null;
	const claims = {
		issuer: identity.issuer,
		subject: identity.subject,
		sessionId: identity.anchorSession,
	};
	const valid =
		"db" in ctx
			? await verifiedAccount(ctx, claims)
			: await ctx.runQuery(internal.sessions.validate, claims);
	return valid ? identity : null;
}

function profile(account: Doc<"accounts">) {
	return {
		id: account.id,
		email: account.email,
		name: account.name,
		profileImage: account.profileImage,
		isAdmin: account.isAdmin,
		status: account.status,
		hasPassword: Boolean(account.passwordHash),
		createdAt: new Date(account.createdAt).toISOString(),
		updatedAt: new Date(account.updatedAt).toISOString(),
	};
}

export const me = internalQuery({
	args: sessionClaims,
	handler: async (ctx, claims) => {
		const account = await verifiedAccount(ctx, claims);
		return account ? profile(account) : null;
	},
});

export const apiTokenStatus = internalQuery({
	args: sessionClaims,
	handler: async (ctx, claims) => {
		const account = await verifiedAccount(ctx, claims);
		return account ? { hasApiToken: account.apiTokenHash !== null } : null;
	},
});

export const setApiToken = internalMutation({
	args: { ...sessionClaims, hash: v.union(v.string(), v.null()) },
	handler: async (ctx, { hash, ...claims }) => {
		const account = await verifiedAccount(ctx, claims);
		if (!account) return "unauthenticated";
		if (
			hash !== null &&
			(await ctx.db
				.query("accounts")
				.withIndex("by_api_token", (q) =>
					q.eq("issuer", account.issuer).eq("apiTokenHash", hash),
				)
				.first())
		)
			return "collision";
		await ctx.db.patch("accounts", account._id, { apiTokenHash: hash });
		return "updated";
	},
});

export const updateProfile = internalMutation({
	args: { ...sessionClaims, name: v.optional(v.string()) },
	handler: async (ctx, { name, ...claims }) => {
		const account = await verifiedAccount(ctx, claims);
		if (!account) return null;
		if (name === undefined) return profile(account);
		const update = { name, updatedAt: Date.now() };
		await ctx.db.patch("accounts", account._id, update);
		return profile({ ...account, ...update });
	},
});

async function recordPasswordAttempt(ctx: MutationCtx, accountId?: string) {
	const key = accountId ?? "";
	const prior = await ctx.db
		.query("passwordAttempts")
		.withIndex("by_key", (q) => q.eq("key", key))
		.unique();
	const now = Date.now();
	const currentWindow = prior && prior.resetAt > now;
	if (currentWindow && prior.count >= (accountId ? 12 : 40)) return false;
	const values = {
		count: currentWindow ? prior.count + 1 : 1,
		resetAt: currentWindow ? prior.resetAt : now + 60_000,
	};
	if (prior) await ctx.db.patch("passwordAttempts", prior._id, values);
	else await ctx.db.insert("passwordAttempts", { key, ...values });
	return true;
}

export const attempt = internalMutation({
	args: { email: v.string(), login: v.optional(v.boolean()) },
	handler: async (ctx, { email, login }) => {
		const issuer = process.env.ANCHOR_AUTH_ISSUER;
		if (!nativeAuthEnabled() || !issuer) return { type: "disabled" } as const;
		if (login && (await localAuthDisabled(ctx, issuer)))
			return { type: "local-disabled" } as const;
		const account = await ctx.db
			.query("accounts")
			.withIndex("by_issuer_email", (q) =>
				q.eq("issuer", issuer).eq("email", email),
			)
			.unique();
		if (!(await recordPasswordAttempt(ctx, account?.id)))
			return { type: "rate-limit" } as const;
		return {
			type: "attempt",
			accountId: account?.id ?? null,
			issuer,
			passwordHash: account?.passwordHash ?? null,
		} as const;
	},
});

export const accountPasswordAttempt = internalMutation({
	args: sessionClaims,
	handler: async (ctx, claims) => {
		const account = await verifiedAccount(ctx, claims);
		if (!account) return { type: "unauthenticated" } as const;
		if (!account.passwordHash) return { type: "passwordless" } as const;
		if (!(await recordPasswordAttempt(ctx, account.id)))
			return { type: "rate-limit" } as const;
		return { type: "attempt", passwordHash: account.passwordHash } as const;
	},
});

export const finishPasswordChange = internalMutation({
	args: { ...sessionClaims, passwordHash: v.string(), replacement: v.string() },
	handler: async (ctx, { passwordHash, replacement, ...claims }) => {
		const account = await verifiedAccount(ctx, claims);
		if (!account) return "unauthenticated";
		if (account.passwordHash !== passwordHash) return "conflict";
		await ctx.db.patch("accounts", account._id, {
			passwordHash: replacement,
			updatedAt: Date.now(),
		});
		return "changed";
	},
});

async function removeUnusedProfileImage(ctx: MutationCtx, path: string | null) {
	if (!path?.startsWith("/uploads/profiles/")) return;
	const image = await ctx.db
		.query("profileImages")
		.withIndex("by_path", (q) => q.eq("path", path))
		.unique();
	if (!image) return;
	const other = await ctx.db
		.query("accounts")
		.withIndex("by_profile_image", (q) => q.eq("profileImage", path))
		.first();
	if (other) return;
	if (await ctx.db.system.get("_storage", image.storageId))
		await ctx.storage.delete(image.storageId);
	await ctx.db.delete("profileImages", image._id);
}

export const setProfileImage = internalMutation({
	args: {
		...sessionClaims,
		image: v.union(
			v.null(),
			v.object({
				path: v.string(),
				storageId: v.id("_storage"),
				mimeType: v.union(
					v.literal("image/jpeg"),
					v.literal("image/png"),
					v.literal("image/webp"),
				),
			}),
		),
	},
	handler: async (ctx, { image, ...claims }) => {
		const account = await verifiedAccount(ctx, claims);
		if (!account) return { type: "unauthenticated" } as const;
		if (image) {
			const blob = await ctx.db.system.get("_storage", image.storageId);
			if (!blob) return { type: "unavailable" } as const;
			await ctx.db.insert("profileImages", { ...image, fileSize: blob.size });
		}
		const patch = { profileImage: image?.path ?? null, updatedAt: Date.now() };
		await ctx.db.patch("accounts", account._id, patch);
		await removeUnusedProfileImage(ctx, account.profileImage);
		return {
			type: "updated",
			user: profile({ ...account, ...patch }),
		} as const;
	},
});

export const deleteAccount = internalMutation({
	args: {
		...sessionClaims,
		target: v.union(
			v.object({
				type: v.literal("self"),
				passwordHash: v.union(v.string(), v.null()),
			}),
			v.object({ type: v.literal("admin"), userId: v.string() }),
		),
	},
	handler: async (ctx, { target, ...claims }) => {
		const actor = await verifiedAccount(ctx, claims);
		if (!actor) return "unauthenticated";
		if (target.type === "admin" && !actor.isAdmin) return "forbidden";
		if (target.type === "self" && actor.passwordHash !== target.passwordHash)
			return "invalid-password";
		const account =
			target.type === "self"
				? actor
				: await accountFor(ctx, actor.issuer, target.userId);
		if (!account) return "missing";
		if (account.isAdmin) {
			const admins = await ctx.db
				.query("accounts")
				.withIndex("by_issuer_admin", (q) =>
					q.eq("issuer", account.issuer).eq("isAdmin", true),
				)
				.take(2);
			if (admins.length === 1) {
				const users = await ctx.db
					.query("accounts")
					.withIndex("by_issuer_id", (q) => q.eq("issuer", account.issuer))
					.take(2);
				if (target.type === "admin" || users.length > 1) return "last-admin";
			}
		}
		await ctx.db.delete("accounts", account._id);
		await removeUnusedProfileImage(ctx, account.profileImage);
		await ctx.scheduler.runAfter(0, internal.accountDeletion.purge, {
			issuer: account.issuer,
			userId: account.id,
			accountId: account._id,
		});
		return "deleted";
	},
});

export const begin = internalMutation({
	args: {
		issuer: v.string(),
		userId: v.string(),
		passwordHash: v.string(),
		digest: v.string(),
	},
	handler: async (ctx, { issuer, userId, passwordHash, digest }) => {
		const account = await accountFor(ctx, issuer, userId);
		if (
			!nativeAuthEnabled() ||
			issuer !== process.env.ANCHOR_AUTH_ISSUER ||
			!account ||
			account.passwordHash !== passwordHash
		)
			return { type: "invalid" } as const;
		if (account.status !== "active") return { type: "pending" } as const;
		if (await localAuthDisabled(ctx, issuer))
			return { type: "local-disabled" } as const;
		const passkey = await passkeysFor(ctx, userId).first();
		if (
			account.totpEnabledAt !== null &&
			account.totpSecretEnc &&
			process.env.TOTP_ENCRYPTION_KEY
		) {
			await ctx.db.insert("loginChallenges", {
				accountId: account._id,
				accountUpdatedAt: account.updatedAt,
				factorResetVersion: account.factorResetVersion ?? 0,
				digest,
				attempts: 0,
				expiresAt: Date.now() + 5 * 60_000,
			});
			return { type: "challenge" } as const;
		}
		if (passkey && passkeyRelyingParty()) return { type: "passkey" } as const;
		if (
			account.totpEnabledAt !== null ||
			account.totpSecretEnc !== null ||
			passkey
		)
			return { type: "factor-required" } as const;
		if (requiresFactor(await accountPolicy(ctx, issuer), account)) {
			const totp = authenticatorConfigured();
			const passkey = Boolean(passkeyRelyingParty());
			if (!totp && !passkey) return { type: "unavailable" } as const;
			await createEnrollmentChallenge(ctx, account, digest);
			return { type: "enroll", methods: { totp, passkey } } as const;
		}
		return issueSession(ctx, account, digest);
	},
});

async function createEnrollmentChallenge(
	ctx: MutationCtx,
	account: Doc<"accounts">,
	digest: string,
) {
	await ctx.db.insert("loginChallenges", {
		accountId: account._id,
		accountUpdatedAt: account.updatedAt,
		factorResetVersion: account.factorResetVersion ?? 0,
		digest,
		attempts: 0,
		expiresAt: Date.now() + 15 * 60_000,
		enroll: true,
	});
}

export async function issueSession(
	ctx: MutationCtx,
	account: Doc<"accounts">,
	digest: string,
	totpVerified?: true,
	method?: "oidc" | "passkey",
) {
	const expiresAt = Date.now() + sessionLifetime;
	const sessionId = await ctx.db.insert("sessions", {
		issuer: account.issuer,
		userId: account.id,
		expiresAt,
		factorResetVersion: account.factorResetVersion ?? 0,
		...(totpVerified ? { totpVerified } : {}),
		...(method === "oidc" ? { method } : {}),
		...(method === "passkey" ? { passkeyVerified: true as const } : {}),
	});
	await ctx.db.insert("refreshTokens", { digest, sessionId, expiresAt });
	return {
		type: "session",
		issuer: account.issuer,
		sessionId,
		user: profile(account),
	} as const;
}

export async function openChallenge(ctx: QueryCtx, digest: string, enroll = false) {
	if (!nativeAuthEnabled()) return null;
	const challenge = await ctx.db
		.query("loginChallenges")
		.withIndex("by_digest", (q) => q.eq("digest", digest))
		.unique();
	if (
		!challenge ||
		Boolean(challenge.enroll) !== enroll ||
		challenge.expiresAt <= Date.now() ||
		challenge.attempts >= 5
	)
		return null;
	const account = await ctx.db.get("accounts", challenge.accountId);
	if (
		!account ||
		account.issuer !== process.env.ANCHOR_AUTH_ISSUER ||
		account.status !== "active" ||
		(await localAuthDisabled(ctx, account.issuer)) ||
		(enroll
			? account.totpEnabledAt !== null || account.totpSecretEnc !== null
			: account.totpEnabledAt === null || !account.totpSecretEnc) ||
		(account.factorResetVersion ?? 0) !== (challenge.factorResetVersion ?? 0) ||
		account.updatedAt !== challenge.accountUpdatedAt ||
		(account.sessionsRevokedAt !== null &&
			account.sessionsRevokedAt > challenge._creationTime)
	)
		return null;
	if (
		enroll &&
		(await passkeysFor(ctx, account.id).first())
	)
		return null;
	return { challenge, account };
}

export const factor = internalQuery({
	args: { digest: v.string() },
	handler: async (ctx, { digest }) => {
		const request = await openChallenge(ctx, digest);
		if (!request) return null;
		const { account } = request;
		if ((account.twoFactorLockedUntil ?? 0) > Date.now())
			return { type: "locked" } as const;
		return { type: "ready", secret: account.totpSecretEnc! } as const;
	},
});

const factorProof = v.union(
	v.null(),
	v.object({ step: v.number() }),
	v.object({ recoveryHash: v.string() }),
);

async function claimFactor(
	ctx: MutationCtx,
	account: Doc<"accounts">,
	proof: Infer<typeof factorProof>,
) {
	const now = Date.now();
	if ((account.twoFactorLockedUntil ?? 0) > now) return "locked";
	const counter = Math.floor(now / 30_000);
	const step =
		proof &&
		"step" in proof &&
		Number.isSafeInteger(proof.step) &&
		Math.abs(proof.step - counter) <= 1 &&
		proof.step > (account.totpLastStep ?? -1)
			? proof.step
			: null;
	const recovery =
		proof && "recoveryHash" in proof
			? await ctx.db
					.query("recoveryCodes")
					.withIndex("by_user_hash", (q) =>
						q.eq("userId", account.id).eq("codeHash", proof.recoveryHash),
					)
					.unique()
			: null;
	if (step === null && (!recovery || recovery.usedAt !== null)) {
		const failures =
			(account.twoFactorLockedUntil === null
				? account.twoFactorFailedAttempts
				: 0) + 1;
		await ctx.db.patch("accounts", account._id, {
			twoFactorFailedAttempts: failures,
			twoFactorLockedUntil: failures >= 5 ? now + 10 * 60_000 : null,
		});
		return "invalid";
	}
	if (recovery)
		await ctx.db.patch("recoveryCodes", recovery._id, { usedAt: now });
	await ctx.db.patch("accounts", account._id, {
		twoFactorFailedAttempts: 0,
		twoFactorLockedUntil: null,
		...(step === null ? {} : { totpLastStep: step, totpLastUsedAt: now }),
	});
	return "accepted";
}

export const finishFactor = internalMutation({
	args: {
		digest: v.string(),
		refreshDigest: v.string(),
		secret: v.string(),
		proof: factorProof,
	},
	handler: async (ctx, { digest, refreshDigest, secret, proof }) => {
		const request = await openChallenge(ctx, digest);
		if (!request || request.account.totpSecretEnc !== secret)
			return { type: "invalid" } as const;
		const { account, challenge } = request;
		const outcome = await claimFactor(ctx, account, proof);
		if (outcome === "invalid")
			await ctx.db.patch("loginChallenges", challenge._id, {
				attempts: challenge.attempts + 1,
			});
		if (outcome !== "accepted") return { type: outcome } as const;

		await ctx.db.delete("loginChallenges", challenge._id);
		return issueSession(ctx, account, refreshDigest, true);
	},
});

export const rotate = internalMutation({
	args: { digest: v.string(), nextDigest: v.string() },
	handler: async (
		ctx,
		{ digest, nextDigest },
	): Promise<{
		issuer: string;
		userId: string;
		sessionId: Id<"sessions">;
	} | null> => {
		const token = await refreshByDigest(ctx, digest);
		const now = Date.now();
		if (!nativeAuthEnabled() || !token || token.expiresAt <= now) return null;
		const session = await ctx.db.get("sessions", token.sessionId);
		if (!session || !(await activeAccount(ctx, session))) return null;
		if (token.successor !== undefined && token.successor !== nextDigest)
			return null;
		if (token.successor === undefined) {
			const expiresAt = now + sessionLifetime;
			await ctx.db.patch("refreshTokens", token._id, {
				expiresAt: Math.min(token.expiresAt, now + day),
				successor: nextDigest,
			});
			await ctx.db.insert("refreshTokens", {
				digest: nextDigest,
				sessionId: session._id,
				expiresAt,
			});
			await ctx.db.patch("sessions", session._id, { expiresAt });
		}
		return {
			issuer: session.issuer,
			userId: session.userId,
			sessionId: session._id,
		};
	},
});

export const revoke = internalMutation({
	args: { digest: v.string() },
	handler: async (ctx, { digest }) => {
		if (!nativeAuthEnabled()) return;
		const token = await refreshByDigest(ctx, digest);
		if (!token || token.expiresAt <= Date.now()) return;
		const session = await ctx.db.get("sessions", token.sessionId);
		if (session) await ctx.db.delete("sessions", session._id);
	},
});

export const collectExpired = internalMutation({
	args: {},
	handler: async (ctx): Promise<void> => {
		const now = Date.now();
		const sessions = await ctx.db
			.query("sessions")
			.withIndex("by_expires_at", (q) => q.lte("expiresAt", now))
			.take(128);
		const tokens = await ctx.db
			.query("refreshTokens")
			.withIndex("by_expires_at", (q) => q.lte("expiresAt", now))
			.take(128);
		const challenges = await ctx.db
			.query("loginChallenges")
			.withIndex("by_expires_at", (q) => q.lte("expiresAt", now))
			.take(128);
		const passkeys = await ctx.db
			.query("passkeyChallenges")
			.withIndex("by_expires_at", (q) => q.lte("expiresAt", now))
			.take(128);
		for (const challenge of passkeys) await ctx.db.delete(challenge._id);
		for (const session of sessions)
			await ctx.db.delete("sessions", session._id);
		for (const token of tokens) await ctx.db.delete("refreshTokens", token._id);
		for (const challenge of challenges)
			await ctx.db.delete("loginChallenges", challenge._id);
		if (
			sessions.length === 128 ||
			tokens.length === 128 ||
			challenges.length === 128 ||
			passkeys.length === 128
		)
			await ctx.scheduler.runAfter(0, internal.sessions.collectExpired, {});
	},
});

export function passkeySummary(
	{ id, name, createdAt, lastUsedAt, deviceType, backedUp }:
		Pick<Doc<"passkeys">, "id" | "name" | "createdAt" | "lastUsedAt" | "deviceType" | "backedUp">,
) {
	return {
		id,
		name,
		createdAt: new Date(createdAt).toISOString(),
		lastUsedAt: lastUsedAt === null ? null : new Date(lastUsedAt).toISOString(),
		deviceType,
		backedUp,
	};
}

export const authenticatorStatus = internalQuery({
	args: sessionClaims,
	handler: async (ctx, claims) => {
		const account = await verifiedAccount(ctx, claims);
		if (!account) return null;
		const passkeys = await passkeysFor(ctx, account.id).collect();
		const recovery = await ctx.db
			.query("recoveryCodes")
			.withIndex("by_user", (q) => q.eq("userId", account.id))
			.collect();
		const policy = await accountPolicy(ctx, account.issuer);
		return {
			available: {
				totp: Boolean(process.env.TOTP_ENCRYPTION_KEY),
				passkeys: await passkeysAvailable(ctx, account.issuer),
			},
			policy,
			required:
				requiresFactor(policy, account) &&
				account.totpEnabledAt === null &&
				passkeys.length === 0,
			totp: {
				enabled: account.totpEnabledAt !== null,
				enabledAt:
					account.totpEnabledAt === null
						? null
						: new Date(account.totpEnabledAt).toISOString(),
				lastUsedAt:
					account.totpLastUsedAt === null
						? null
						: new Date(account.totpLastUsedAt).toISOString(),
				recoveryCodesRemaining: recovery.filter((row) => row.usedAt === null)
					.length,
			},
			passkeys: passkeys.map(passkeySummary),
		};
	},
});

export const authenticatorEnrollment = internalQuery({
	args: sessionClaims,
	handler: async (ctx, claims) => {
		const account = await verifiedAccount(ctx, claims);
		return account
			? {
					email: account.email,
					enabled:
						account.totpEnabledAt !== null || account.totpSecretEnc !== null,
					pending: account.totpPendingSecretEnc,
					current: account.totpSecretEnc,
					passwordHash: account.passwordHash,
				}
			: null;
	},
});

export const saveAuthenticator = internalMutation({
	args: { ...sessionClaims, encrypted: v.string() },
	handler: async (ctx, { encrypted, ...claims }) => {
		const account = await verifiedAccount(ctx, claims);
		if (
			!account ||
			account.totpEnabledAt !== null ||
			account.totpSecretEnc !== null
		)
			return false;
		await ctx.db.patch("accounts", account._id, {
			totpPendingSecretEnc: encrypted,
		});
		return true;
	},
});

export const enableAuthenticator = internalMutation({
	args: {
		...sessionClaims,
		encrypted: v.string(),
		step: v.union(v.number(), v.null()),
		digest: v.string(),
		codes: v.array(v.object({ id: v.string(), hash: v.string() })),
	},
	handler: async (ctx, { encrypted, step, digest, codes, ...claims }) => {
		const account = await verifiedAccount(ctx, claims);
		if (!account || account.totpPendingSecretEnc !== encrypted)
			return { type: "invalid" } as const;
		return completeEnrollment(ctx, account, encrypted, step, digest, codes);
	},
});

const recoveryCodesInput = v.array(
	v.object({ id: v.string(), hash: v.string() }),
);

async function completeEnrollment(
	ctx: MutationCtx,
	account: Doc<"accounts">,
	encrypted: string,
	step: number | null,
	digest: string,
	codes: Infer<typeof recoveryCodesInput>,
) {
	const now = Date.now();
	if ((account.twoFactorLockedUntil ?? 0) > now)
		return { type: "locked" } as const;
	if (step === null || Math.abs(step - Math.floor(now / 30_000)) > 1) {
		const failures =
			(account.twoFactorLockedUntil === null
				? account.twoFactorFailedAttempts
				: 0) + 1;
		await ctx.db.patch("accounts", account._id, {
			twoFactorFailedAttempts: failures,
			twoFactorLockedUntil: failures >= 5 ? now + 10 * 60_000 : null,
		});
		return { type: "invalid" } as const;
	}
	await ctx.db.patch("accounts", account._id, {
		totpSecretEnc: encrypted,
		totpPendingSecretEnc: null,
		totpEnabledAt: now,
		totpLastStep: step,
		totpLastUsedAt: now,
		sessionsRevokedAt: now,
		twoFactorFailedAttempts: 0,
		twoFactorLockedUntil: null,
		updatedAt: now,
	});
	await replaceRecoveryCodes(ctx, account.id, codes, now);
	return issueSession(ctx, { ...account, updatedAt: now }, digest, true);
}

export const pendingEnrollment = internalQuery({
	args: { digest: v.string() },
	handler: async (ctx, { digest }) => {
		const request = await openChallenge(ctx, digest, true);
		return request
			? {
					email: request.account.email,
					pending: request.challenge.pending ?? null,
				}
			: null;
	},
});

export const prepareEnrollment = internalMutation({
	args: { digest: v.string(), encrypted: v.string() },
	handler: async (ctx, { digest, encrypted }) => {
		const request = await openChallenge(ctx, digest, true);
		if (!request) return false;
		await ctx.db.patch("loginChallenges", request.challenge._id, {
			pending: encrypted,
		});
		return true;
	},
});

export const finishEnrollment = internalMutation({
	args: {
		challenge: v.string(),
		encrypted: v.string(),
		step: v.union(v.number(), v.null()),
		digest: v.string(),
		codes: recoveryCodesInput,
	},
	handler: async (ctx, { challenge, encrypted, step, digest, codes }) => {
		const request = await openChallenge(ctx, challenge, true);
		if (!request || request.challenge.pending !== encrypted)
			return { type: "closed" } as const;
		const result = await completeEnrollment(
			ctx,
			request.account,
			encrypted,
			step,
			digest,
			codes,
		);
		if (result.type === "session")
			await ctx.db.delete("loginChallenges", request.challenge._id);
		return result;
	},
});

async function replaceRecoveryCodes(
	ctx: MutationCtx,
	userId: string,
	codes: Infer<typeof recoveryCodesInput>,
	now: number,
) {
	const old = await ctx.db
		.query("recoveryCodes")
		.withIndex("by_user", (q) => q.eq("userId", userId))
		.collect();
	for (const row of old) await ctx.db.delete("recoveryCodes", row._id);
	for (const code of codes)
		await ctx.db.insert("recoveryCodes", {
			id: code.id,
			userId: userId,
			codeHash: code.hash,
			usedAt: null,
			createdAt: now,
		});
}

export const manageAuthenticator = internalMutation({
	args: {
		...sessionClaims,
		secret: v.string(),
		passwordHash: v.optional(v.string()),
		proof: factorProof,
		change: v.union(
			v.object({ type: v.literal("replace"), encrypted: v.string() }),
			v.object({ type: v.literal("rotate"), codes: recoveryCodesInput }),
			v.object({ type: v.literal("disable") }),
		),
	},
	handler: async (ctx, { secret, passwordHash, proof, change, ...claims }) => {
		const account = await verifiedAccount(ctx, claims);
		if (
			!account ||
			account.totpEnabledAt === null ||
			account.totpSecretEnc !== secret
		)
			return "invalid";
		if (
			change.type !== "replace" &&
			(!passwordHash || account.passwordHash !== passwordHash)
		)
			return "invalid";
		if (
			change.type === "disable" &&
			requiresFactor(await accountPolicy(ctx, account.issuer), account) &&
			!(await passkeysAvailable(ctx, account.issuer) && await passkeysFor(ctx, account.id).first())
		)
			return "policy" as const;
		const outcome = await claimFactor(ctx, account, proof);
		if (outcome !== "accepted") return outcome;
		if (change.type === "replace") {
			await ctx.db.patch("accounts", account._id, {
				totpPendingSecretEnc: change.encrypted,
			});
			return outcome;
		}
		const now = Date.now();
		if (change.type === "disable") {
			await ctx.db.patch("accounts", account._id, {
				totpSecretEnc: null,
				totpPendingSecretEnc: null,
				totpEnabledAt: null,
				totpLastStep: null,
				totpLastUsedAt: null,
				updatedAt: now,
			});
		}
		await replaceRecoveryCodes(
			ctx,
			account.id,
			change.type === "rotate" ? change.codes : [],
			now,
		);
		return outcome;
	},
});

const managedPolicy = v.union(
	v.literal("optional"),
	v.literal("admins"),
	v.literal("everyone"),
);

export function authenticatorConfigured() {
	try {
		return atob(process.env.TOTP_ENCRYPTION_KEY ?? "").length === 32;
	} catch {
		return false;
	}
}

export const publicCapabilities = internalQuery({
	args: {},
	handler: async (ctx) => {
		const issuer = process.env.ANCHOR_AUTH_ISSUER;
		return {
			totp: Boolean(
				issuer &&
					nativeAuthEnabled() &&
					authenticatorConfigured() &&
					!(await localAuthDisabled(ctx, issuer)),
			),
			passkeys: issuer ? await passkeysAvailable(ctx, issuer) : false,
		};
	},
});

export const adminPolicyPage = internalQuery({
	args: { ...sessionClaims, cursor: v.union(v.string(), v.null()) },
	handler: async (ctx, { cursor, ...claims }) => {
		const admin = await verifiedAccount(ctx, claims);
		if (!admin) return { type: "unauthenticated" } as const;
		if (!admin.isAdmin) return { type: "forbidden" } as const;
		const accounts = await ctx.db
			.query("accounts")
			.withIndex("by_issuer_id", (q) => q.eq("issuer", admin.issuer))
			.paginate({ cursor, numItems: 64 });
		let covered = 0;
		let total = 0;
		for (const account of accounts.page) {
			if (account.status !== "active" || !account.passwordHash) continue;
			total++;
			if (
				account.totpEnabledAt !== null ||
				(await ctx.db
					.query("passkeys")
					.withIndex("by_user", (q) => q.eq("userId", account.id))
					.first())
			)
				covered++;
		}
		return {
			type: "page",
			next: accounts.isDone ? null : accounts.continueCursor,
			policy: await accountPolicy(ctx, admin.issuer),
			totp: authenticatorConfigured(),
			passkeys: await passkeysAvailable(ctx, admin.issuer),
			covered,
			total,
		} as const;
	},
});

export const setAdminPolicy = internalMutation({
	args: { ...sessionClaims, policy: managedPolicy },
	handler: async (ctx, { policy, ...claims }) => {
		const admin = await verifiedAccount(ctx, claims);
		if (!admin) return "unauthenticated" as const;
		if (!admin.isAdmin) return "forbidden" as const;
		if (policy !== "optional") {
			const totp = authenticatorConfigured();
			const passkeys = await passkeysAvailable(ctx, admin.issuer);
			if (!totp && !passkeys) return "unavailable" as const;
			if (
				!(totp && admin.totpEnabledAt !== null && admin.totpSecretEnc) &&
				!(passkeys && await passkeysFor(ctx, admin.id).first())
			)
				return "enroll-first" as const;
		}
		const previous = await ctx.db
			.query("authPolicies")
			.withIndex("by_issuer", (q) => q.eq("issuer", admin.issuer))
			.unique();
		if (previous) await ctx.db.patch("authPolicies", previous._id, { policy });
		else await ctx.db.insert("authPolicies", { issuer: admin.issuer, policy });
		return "updated" as const;
	},
});

export const resetAccountFactors = internalMutation({
	args: { ...sessionClaims, userId: v.string() },
	handler: async (ctx, { userId, ...claims }) => {
		const admin = await verifiedAccount(ctx, claims);
		if (!admin) return "unauthenticated" as const;
		if (!admin.isAdmin) return "forbidden" as const;
		const account = await accountFor(ctx, admin.issuer, userId);
		if (!account) return "missing" as const;
		const now = Date.now();
		await ctx.db.patch("accounts", account._id, {
			totpSecretEnc: null,
			totpPendingSecretEnc: null,
			totpEnabledAt: null,
			totpLastStep: null,
			totpLastUsedAt: null,
			twoFactorFailedAttempts: 0,
			twoFactorLockedUntil: null,
			updatedAt: now,
			sessionsRevokedAt: now,
			factorResetVersion: (account.factorResetVersion ?? 0) + 1,
		});
		await replaceRecoveryCodes(ctx, account.id, [], now);
		const passkeys = await passkeysFor(ctx, account.id).collect();
		for (const passkey of passkeys)
			await ctx.db.delete("passkeys", passkey._id);
		return "reset" as const;
	},
});

export const adminDirectoryPage = internalQuery({
	args: {
		...sessionClaims,
		cursor: v.union(v.string(), v.null()),
		skip: v.number(),
		take: v.number(),
		search: v.string(),
		status: v.optional(v.union(v.literal("active"), v.literal("pending"))),
		pendingOnly: v.boolean(),
	},
	handler: async (
		ctx,
		{ cursor, skip, take, search, status, pendingOnly, ...claims },
	) => {
		const admin = await verifiedAccount(ctx, claims);
		if (!admin) return { type: "unauthenticated" } as const;
		if (!admin.isAdmin) return { type: "forbidden" } as const;
		const accounts = await ctx.db
			.query("accounts")
			.withIndex("by_issuer_created_at", (q) => q.eq("issuer", admin.issuer))
			.order("desc")
			.paginate({ cursor, numItems: 32 });
		const matches = accounts.page.filter(
			(account) =>
				(!status || account.status === status) &&
				(!search ||
					account.name.toLowerCase().includes(search) ||
					account.email.toLowerCase().includes(search)),
		);
		const users = await Promise.all(
			matches.slice(skip, skip + take).map(async (account) => {
				const authMethod = account.oidcSubject ? "oidc" : "local";
				const person = { ...profile(account), authMethod };
				if (pendingOnly) {
					const { hasPassword: _hasPassword, ...pending } = person;
					return pending;
				}
				const passkey = await ctx.db
					.query("passkeys")
					.withIndex("by_user", (q) => q.eq("userId", account.id))
					.first();
				const totp = account.totpEnabledAt !== null;
				return {
					...person,
					twoFactor: totp
						? passkey
							? "both"
							: "totp"
						: passkey
							? "passkey"
							: "none",
				};
			}),
		);
		return {
			type: "page",
			users,
			matched: matches.length,
			next: accounts.isDone ? null : accounts.continueCursor,
		} as const;
	},
});

export const adminDirectoryCountPage = internalQuery({
	args: {
		...sessionClaims,
		cursor: v.union(v.string(), v.null()),
		userId: v.optional(v.string()),
		resource: v.union(
			v.literal("accounts"),
			v.literal("notes"),
			v.literal("tags"),
		),
	},
	handler: async (ctx, { cursor, userId, resource, ...claims }) => {
		const admin = await verifiedAccount(ctx, claims);
		if (!admin) return { type: "unauthenticated" } as const;
		if (!admin.isAdmin) return { type: "forbidden" } as const;
		const page =
			resource === "accounts"
				? await ctx.db
						.query("accounts")
						.withIndex("by_issuer_id", (q) => q.eq("issuer", admin.issuer))
						.paginate({ cursor, numItems: 64 })
				: resource === "notes"
					? await ctx.db
							.query("notes")
							.withIndex("by_owner_id", (q) => {
								const instance = q.eq("issuer", admin.issuer);
								return userId === undefined
									? instance
									: instance.eq("owner", userId);
							})
							.paginate({ cursor, numItems: 64, maximumBytesRead: 2_000_000 })
					: await ctx.db
							.query("tags")
							.withIndex("by_owner_id", (q) => {
								const instance = q.eq("issuer", admin.issuer);
								return userId === undefined
									? instance
									: instance.eq("owner", userId).eq("isDeleted", false);
							})
							.paginate({ cursor, numItems: 64 });
		const count = page.page.filter(
			(row) =>
				(!("state" in row) || row.state !== "deleted") &&
				(!("isDeleted" in row) || !row.isDeleted),
		).length;
		return {
			type: "page",
			count,
			next: page.isDone ? null : page.continueCursor,
		} as const;
	},
});

export const approveAccount = internalMutation({
	args: { ...sessionClaims, userId: v.string() },
	handler: async (ctx, { userId, ...claims }) => {
		const admin = await verifiedAccount(ctx, claims);
		if (!admin) return { type: "unauthenticated" } as const;
		if (!admin.isAdmin) return { type: "forbidden" } as const;
		const account = await accountFor(ctx, admin.issuer, userId);
		if (!account) return { type: "missing" } as const;
		if (account.status !== "pending") return { type: "not-pending" } as const;
		const updatedAt = Date.now();
		await ctx.db.patch("accounts", account._id, {
			status: "active",
			updatedAt,
		});
		return {
			type: "approved",
			user: {
				...adminAccountUpdateView({ ...account, updatedAt }),
				status: "active",
			},
		} as const;
	},
});

function adminAccountUpdateView(account: Doc<"accounts">) {
	return {
		id: account.id,
		email: account.email,
		name: account.name,
		isAdmin: account.isAdmin,
		createdAt: new Date(account.createdAt).toISOString(),
		updatedAt: new Date(account.updatedAt).toISOString(),
	};
}

export const updateAdminAccount = internalMutation({
	args: {
		...sessionClaims,
		userId: v.string(),
		patch: v.object({
			email: v.optional(v.string()),
			name: v.optional(v.string()),
			isAdmin: v.optional(v.boolean()),
		}),
	},
	handler: async (ctx, { userId, patch, ...claims }) => {
		const admin = await verifiedAccount(ctx, claims);
		if (!admin) return { type: "unauthenticated" } as const;
		if (!admin.isAdmin) return { type: "forbidden" } as const;
		const account = await accountFor(ctx, admin.issuer, userId);
		if (!account) return { type: "missing" } as const;
		if (admin.id === userId && patch.isAdmin === false)
			return { type: "self-demotion" } as const;
		if (patch.email && patch.email !== account.email) {
			const duplicate = await ctx.db
				.query("accounts")
				.withIndex("by_issuer_email", (q) =>
					q.eq("issuer", admin.issuer).eq("email", patch.email!),
				)
				.first();
			if (duplicate) return { type: "email-conflict" } as const;
		}
		const updatedAt = Date.now();
		await ctx.db.patch("accounts", account._id, { ...patch, updatedAt });
		return {
			type: "updated",
			user: adminAccountUpdateView({ ...account, ...patch, updatedAt }),
		} as const;
	},
});

async function passwordResetTarget(
	ctx: QueryCtx,
	claims: Infer<typeof sessionClaimsValidator>,
	userId: string,
) {
	const admin = await verifiedAccount(ctx, claims);
	if (!admin) return { type: "unauthenticated" } as const;
	if (!admin.isAdmin) return { type: "forbidden" } as const;
	const account = await accountFor(ctx, admin.issuer, userId);
	return account
		? ({ type: "account", account } as const)
		: ({ type: "missing" } as const);
}

const sessionClaimsValidator = v.object(sessionClaims);

export const canResetAccountPassword = internalQuery({
	args: { ...sessionClaims, userId: v.string() },
	handler: async (ctx, { userId, ...claims }) =>
		(await passwordResetTarget(ctx, claims, userId)).type,
});

export const resetAccountPassword = internalMutation({
	args: { ...sessionClaims, userId: v.string(), hash: v.string() },
	handler: async (ctx, { userId, hash, ...claims }) => {
		const target = await passwordResetTarget(ctx, claims, userId);
		if (target.type !== "account") return target.type;
		const { account } = target;
		const now = Date.now();
		await ctx.db.patch("accounts", account._id, {
			passwordHash: hash,
			updatedAt: now,
			sessionsRevokedAt: now,
			factorResetVersion: (account.factorResetVersion ?? 0) + 1,
			totpPendingSecretEnc: null,
		});
		return "reset" as const;
	},
});

const registrationMode = v.union(
	v.literal("enabled"),
	v.literal("review"),
	v.literal("disabled"),
);

function registrationByIssuer(ctx: QueryCtx, issuer: string) {
	return ctx.db
		.query("registrationPolicies")
		.withIndex("by_issuer", (q) => q.eq("issuer", issuer))
		.unique();
}

async function signupSettings(ctx: QueryCtx, issuer: string) {
	const env = process.env.USER_SIGNUP;
	if (env === "enabled" || env === "review" || env === "disabled")
		return { mode: env, isLocked: true, source: "env" } as const;
	const saved = await registrationByIssuer(ctx, issuer);
	return saved
		? ({ mode: saved.mode, isLocked: false, source: "database" } as const)
		: ({ mode: "enabled", isLocked: false, source: "default" } as const);
}

export const publicRegistrationMode = internalQuery({
	args: {},
	handler: async (ctx) => {
		const issuer = process.env.ANCHOR_AUTH_ISSUER;
		return issuer ? (await signupSettings(ctx, issuer)).mode : null;
	},
});

export const adminRegistrationSettings = internalQuery({
	args: sessionClaims,
	handler: async (ctx, claims) => {
		const admin = await verifiedAccount(ctx, claims);
		if (!admin) return { type: "unauthenticated" } as const;
		if (!admin.isAdmin) return { type: "forbidden" } as const;
		return {
			type: "settings",
			settings: await signupSettings(ctx, admin.issuer),
		} as const;
	},
});

export const updateRegistrationSettings = internalMutation({
	args: { ...sessionClaims, mode: registrationMode },
	handler: async (ctx, { mode, ...claims }) => {
		const admin = await verifiedAccount(ctx, claims);
		if (!admin) return { type: "unauthenticated" } as const;
		if (!admin.isAdmin) return { type: "forbidden" } as const;
		if ((await signupSettings(ctx, admin.issuer)).isLocked)
			return { type: "locked" } as const;
		const previous = await registrationByIssuer(ctx, admin.issuer);
		if (previous)
			await ctx.db.patch("registrationPolicies", previous._id, { mode });
		else
			await ctx.db.insert("registrationPolicies", {
				issuer: admin.issuer,
				mode,
			});
		return {
			type: "settings",
			settings: await signupSettings(ctx, admin.issuer),
		} as const;
	},
});

async function insertPasswordAccount(
	ctx: MutationCtx,
	{
		id, issuer, email, name, isAdmin, status, hash,
	}: {
		id: string;
		issuer: string;
		email: string;
		name: string;
		isAdmin: boolean;
		status: "active" | "pending";
		hash: string;
	},
) {
	const now = Date.now();
	const document = {
		id,
		issuer,
		email,
		name,
		isAdmin,
		status,
		passwordHash: hash,
		profileImage: null,
		apiTokenHash: null,
		oidcSubject: null,
		totpSecretEnc: null,
		totpPendingSecretEnc: null,
		totpEnabledAt: null,
		totpLastStep: null,
		totpLastUsedAt: null,
		twoFactorFailedAttempts: 0,
		twoFactorLockedUntil: null,
		sessionsRevokedAt: null,
		createdAt: now,
		updatedAt: now,
	} as const;
	const _id = await ctx.db.insert("accounts", document);
	return { ...document, _id, _creationTime: now };
}

export const createAdminManagedAccount = internalMutation({
	args: {
		...sessionClaims,
		id: v.string(),
		email: v.string(),
		name: v.string(),
		hash: v.string(),
	},
	handler: async (ctx, { id, email, name, hash, ...claims }) => {
		const admin = await verifiedAccount(ctx, claims);
		if (!admin) return { type: "unauthenticated" } as const;
		if (!admin.isAdmin) return { type: "forbidden" } as const;
		const issuer = admin.issuer;
		const duplicate = await ctx.db
			.query("accounts")
			.withIndex("by_issuer_email", (q) =>
				q.eq("issuer", issuer).eq("email", email),
			)
			.first();
		if (duplicate) return { type: "duplicate" } as const;
		const account = await insertPasswordAccount(ctx, {
			id,
			issuer,
			email,
			name,
			hash,
			isAdmin: false,
			status: "active",
		});
		return { type: "created", user: profile(account) } as const;
	},
});

export const createRegisteredAccount = internalMutation({
	args: {
		id: v.string(),
		email: v.string(),
		name: v.string(),
		hash: v.string(),
		digest: v.string(),
	},
	handler: async (ctx, { id, email, name, hash, digest }) => {
		const issuer = process.env.ANCHOR_AUTH_ISSUER;
		if (!nativeAuthEnabled() || !issuer)
			return { type: "unavailable" } as const;
		const { mode } = await signupSettings(ctx, issuer);
		if (
			mode === "disabled" ||
			process.env.DISABLE_INTERNAL_AUTH?.toLowerCase() === "true" ||
			(await localAuthDisabled(ctx, issuer))
		)
			return { type: "disabled" } as const;
		const duplicate = await ctx.db
			.query("accounts")
			.withIndex("by_issuer_email", (q) =>
				q.eq("issuer", issuer).eq("email", email),
			)
			.first();
		if (duplicate) return { type: "duplicate" } as const;
		const isAdmin = !(await ctx.db
			.query("accounts")
			.withIndex("by_issuer_admin", (q) =>
				q.eq("issuer", issuer).eq("isAdmin", true),
			)
			.first());
		const status = mode === "review" ? "pending" : "active";
		const policy = await accountPolicy(ctx, issuer);
		const enroll =
			status === "active" &&
			(policy === "everyone" || (policy === "admins" && isAdmin));
		const methods = {
			totp: authenticatorConfigured(),
			passkey: Boolean(passkeyRelyingParty()),
		};
		if (enroll && !methods.totp && !methods.passkey)
			return { type: "unavailable" } as const;
		const account = await insertPasswordAccount(ctx, {
			id,
			issuer,
			email,
			name,
			hash,
			isAdmin,
			status,
		});
		if (status === "pending")
			return { type: "pending", user: profile(account) } as const;
		if (enroll) {
			await createEnrollmentChallenge(ctx, account, digest);
			return { type: "enroll", user: profile(account), methods } as const;
		}
		return issueSession(ctx, account, digest);
	},
});
