import { v, type Infer } from "convex/values";
import {
	internalMutation,
	internalQuery,
	type QueryCtx,
} from "./_generated/server";
import { passkeyRelyingParty } from "./passkeyConfig";
import {
	accountFor,
	accountPolicy,
	authenticatorConfigured,
	issueSession,
	openChallenge,
	passkeysAvailable,
	passkeysFor,
	passkeySummary,
	requiresFactor,
	sessionClaims,
	verifiedAccount,
} from "./sessions";

const maxPasskeys = 10;
const maxLoginChallenges = 5000;
const registration = v.union(
	v.object({ type: v.literal("register"), ...sessionClaims }),
	v.object({ type: v.literal("enroll"), digest: v.string() }),
);
const flow = v.union(v.object({ type: v.literal("login") }), registration);
export type PasskeyFlow = Infer<typeof flow>;
const registrationProof = v.object({
	credentialId: v.string(),
	publicKey: v.string(),
	counter: v.string(),
	transports: v.array(v.string()),
	deviceType: v.string(),
	backedUp: v.boolean(),
});

async function registrationAccount(
	ctx: QueryCtx,
	binding: Infer<typeof registration>,
) {
	const enrollment =
		binding.type === "enroll"
			? await openChallenge(ctx, binding.digest, true)
			: null;
	const account =
		binding.type === "register"
			? await verifiedAccount(ctx, binding)
			: enrollment?.account;
	if (!account?.passwordHash || !(await passkeysAvailable(ctx, account.issuer)))
		return null;
	return { account, enrollment };
}

function challengeFor(ctx: QueryCtx, key: string) {
	return ctx.db
		.query("passkeyChallenges")
		.withIndex("by_key", (q) => q.eq("key", key))
		.unique();
}

function credentialFor(ctx: QueryCtx, id: string) {
	return ctx.db
		.query("passkeys")
		.withIndex("by_credential", (q) => q.eq("credentialId", id))
		.unique();
}

export const registrationOptionsAccount = internalQuery({
	args: { binding: registration },
	handler: async (ctx, { binding }) => {
		const registration = await registrationAccount(ctx, binding);
		if (!registration) return { type: "closed" } as const;
		const { account } = registration;
		const keys = await passkeysFor(ctx, account.id).take(maxPasskeys);
		if (keys.length === maxPasskeys) return { type: "limit" } as const;
		return {
			type: "account",
			user: { id: account.id, email: account.email, name: account.name },
			excluded: keys.map(({ credentialId, transports }) => ({
				credentialId,
				transports,
			})),
		} as const;
	},
});

export const saveChallenge = internalMutation({
	args: { binding: flow, challenge: v.string(), origin: v.string() },
	handler: async (ctx, { binding, challenge, origin }) => {
		const issuer = process.env.ANCHOR_AUTH_ISSUER;
		if (
			!issuer ||
			!(await passkeysAvailable(ctx, issuer)) ||
			passkeyRelyingParty()?.origin !== origin
		)
			return "disabled" as const;
		const mode = binding.type;
		if (mode === "login") {
			const open = await ctx.db
				.query("passkeyChallenges")
				.withIndex("by_mode_expiry", (q) =>
					q.eq("mode", mode).gt("expiresAt", Date.now()),
				)
				.take(maxLoginChallenges);
			if (open.length === maxLoginChallenges) return "limit" as const;
		} else if (!(await registrationAccount(ctx, binding)))
			return "closed" as const;
		const key = mode === "enroll" ? binding.digest : challenge;
		const previous = mode === "enroll" ? await challengeFor(ctx, key) : null;
		if (previous) await ctx.db.delete(previous._id);
		await ctx.db.insert("passkeyChallenges", {
			key,
			challenge,
			origin,
			mode,
			expiresAt: Date.now() + 5 * 60_000,
			...(mode === "register" ? { sessionId: binding.sessionId } : {}),
		});
		return "saved" as const;
	},
});

export const consumeChallenge = internalMutation({
	args: {
		binding: flow,
		key: v.string(),
		credentialId: v.optional(v.string()),
	},
	handler: async (ctx, { binding, key, credentialId }) => {
		const issuer = process.env.ANCHOR_AUTH_ISSUER;
		const rp = passkeyRelyingParty();
		if (!issuer || !rp || !(await passkeysAvailable(ctx, issuer))) return null;
		const row = await challengeFor(
			ctx,
			binding.type === "enroll" ? binding.digest : key,
		);
		if (
			!row ||
			row.mode !== binding.type ||
			row.origin !== rp.origin ||
			row.expiresAt <= Date.now() ||
			(binding.type === "register" && row.sessionId !== binding.sessionId)
		)
			return null;
		if (binding.type !== "login" && !(await registrationAccount(ctx, binding)))
			return null;
		await ctx.db.delete(row._id);
		if (binding.type !== "login")
			return { type: "register", challenge: row.challenge, ...rp } as const;
		const keyRow = credentialId ? await credentialFor(ctx, credentialId) : null;
		const account = keyRow
			? await accountFor(ctx, issuer, keyRow.userId)
			: null;
		if (!keyRow || !account?.passwordHash || account.status !== "active")
			return null;
		return {
			type: "login",
			challenge: row.challenge,
			...rp,
			credential: {
				id: keyRow.credentialId,
				publicKey: keyRow.publicKey,
				counter: keyRow.counter,
				keyId: keyRow._id,
			},
			factorResetVersion: account.factorResetVersion ?? 0,
		} as const;
	},
});

export const saveRegistration = internalMutation({
	args: {
		binding: registration,
		proof: registrationProof,
		id: v.string(),
		name: v.string(),
		origin: v.string(),
		refreshDigest: v.optional(v.string()),
	},
	handler: async (ctx, { binding, proof, id, name, origin, refreshDigest }) => {
		const registration = await registrationAccount(ctx, binding);
		if (!registration || passkeyRelyingParty()?.origin !== origin)
			return { type: "closed" } as const;
		const { account, enrollment } = registration;
		if (await credentialFor(ctx, proof.credentialId))
			return { type: "duplicate" } as const;
		if (
			(await passkeysFor(ctx, account.id).take(maxPasskeys)).length ===
			maxPasskeys
		)
			return { type: "limit" } as const;
		if (binding.type === "enroll" && (!enrollment || !refreshDigest))
			return { type: "closed" } as const;
		const record = {
			...proof,
			id,
			userId: account.id,
			name,
			createdAt: Date.now(),
			lastUsedAt: null,
		};
		await ctx.db.insert("passkeys", record);
		if (enrollment && refreshDigest) {
			await ctx.db.delete(enrollment.challenge._id);
			return issueSession(ctx, account, refreshDigest, undefined, "passkey");
		}
		if (binding.type === "register") {
			const sessionId = ctx.db.normalizeId("sessions", binding.sessionId);
			if (sessionId) await ctx.db.patch(sessionId, { passkeyVerified: true });
		}
		return { type: "passkey", passkey: passkeySummary(record) } as const;
	},
});

export const finishLogin = internalMutation({
	args: {
		keyId: v.id("passkeys"),
		newCounter: v.number(),
		backedUp: v.boolean(),
		factorResetVersion: v.number(),
		origin: v.string(),
		refreshDigest: v.string(),
	},
	handler: async (
		ctx,
		{ keyId, newCounter, backedUp, factorResetVersion, origin, refreshDigest },
	) => {
		const issuer = process.env.ANCHOR_AUTH_ISSUER;
		if (
			!issuer ||
			!(await passkeysAvailable(ctx, issuer)) ||
			passkeyRelyingParty()?.origin !== origin
		)
			return null;
		const key = await ctx.db.get(keyId);
		const account = key ? await accountFor(ctx, issuer, key.userId) : null;
		if (
			!key ||
			!account?.passwordHash ||
			account.status !== "active" ||
			(account.factorResetVersion ?? 0) !== factorResetVersion ||
			(newCounter === 0
				? key.counter !== "0"
				: newCounter <= Number(key.counter))
		)
			return null;
		await ctx.db.patch(keyId, {
			counter: String(newCounter),
			backedUp,
			lastUsedAt: Date.now(),
		});
		return issueSession(ctx, account, refreshDigest, undefined, "passkey");
	},
});

export const manage = internalMutation({
	args: { ...sessionClaims, id: v.string(), name: v.optional(v.string()) },
	handler: async (ctx, { id, name, ...claims }) => {
		const account = await verifiedAccount(ctx, claims);
		if (!account) return { type: "unauthenticated" } as const;
		const keys = await passkeysFor(ctx, account.id).collect();
		const key = keys.find((item) => item.id === id);
		if (!key) return { type: "missing" } as const;
		if (name !== undefined) {
			await ctx.db.patch(key._id, { name });
			return {
				type: "passkey",
				passkey: passkeySummary({ ...key, name }),
			} as const;
		}
		if (
			keys.length === 1 &&
			!(
				authenticatorConfigured() &&
				account.totpEnabledAt !== null &&
				account.totpSecretEnc
			) &&
			requiresFactor(await accountPolicy(ctx, account.issuer), account)
		)
			return { type: "required" } as const;
		await ctx.db.delete(key._id);
		return { type: "removed" } as const;
	},
});
