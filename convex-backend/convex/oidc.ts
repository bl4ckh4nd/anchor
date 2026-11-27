import { v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import { type Doc } from "./_generated/dataModel";
import {
	internalMutation,
	internalQuery,
	type MutationCtx,
	type QueryCtx,
} from "./_generated/server";
import { configuredOidc, effectiveOidc } from "./oidcConfig";
import {
	accountPolicy,
	issueSession,
	nativeAuthEnabled,
	requiresFactor,
} from "./sessions";

async function currentProvider(ctx: QueryCtx) {
	const issuer = process.env.ANCHOR_AUTH_ISSUER;
	if (!issuer || !nativeAuthEnabled()) return null;
	const config = await effectiveOidc(ctx, issuer);
	return configuredOidc(config) ? { issuer, ...config } : null;
}

export const configuration = internalQuery({
	args: {},
	handler: currentProvider,
});

const flow = {
	issuer: v.string(),
	providerIssuer: v.string(),
	clientId: v.string(),
	digest: v.string(),
	browserDigest: v.string(),
	mobileChallenge: v.optional(v.string()),
	redirect: v.string(),
};
const identity = {
	subject: v.string(),
	email: v.string(),
	name: v.string(),
};

export const save = internalMutation({
	args: {
		...flow,
		payload: v.union(
			v.object({
				type: v.literal("state"),
				nonce: v.string(),
				verifier: v.string(),
			}),
			v.object({ type: v.literal("exchange"), ...identity }),
		),
	},
	handler: async (ctx, args) => {
		const config = await currentProvider(ctx);
		if (!config || !matches(config, args)) return false;
		await ctx.db.insert("oidcFlows", {
			...args,
			expiresAt:
				Date.now() + (args.payload.type === "state" ? 10 * 60_000 : 60_000),
		});
		return true;
	},
});

function matches(
	config: { issuer: string; issuerUrl: string; clientId: string },
	flow: Pick<Doc<"oidcFlows">, "issuer" | "providerIssuer" | "clientId">,
) {
	return (
		config.issuer === flow.issuer &&
		config.issuerUrl === flow.providerIssuer &&
		config.clientId === flow.clientId
	);
}

const claim = { digest: v.string(), browserDigest: v.string() };

async function take(
	ctx: MutationCtx,
	digest: string,
	type: Doc<"oidcFlows">["payload"]["type"],
	matchesProof: (flow: Doc<"oidcFlows">) => boolean,
) {
	const saved = await ctx.db
		.query("oidcFlows")
		.withIndex("by_digest", (q) => q.eq("digest", digest))
		.unique();
	if (
		!saved ||
		saved.payload.type !== type ||
		!matchesProof(saved) ||
		saved.expiresAt <= Date.now()
	)
		return null;
	const config = await currentProvider(ctx);
	if (!config || !matches(config, saved)) return null;
	await ctx.db.delete("oidcFlows", saved._id);
	return { saved, config };
}

export const consumeState = internalMutation({
	args: claim,
	handler: async (ctx, args) => {
		const found = await take(
			ctx,
			args.digest,
			"state",
			(flow) => flow.browserDigest === args.browserDigest,
		);
		if (!found || found.saved.payload.type !== "state") return null;
		return { ...found, proof: found.saved.payload };
	},
});

export const exchange = internalMutation({
	args: {
		digest: v.string(),
		proof: v.union(
			v.object({ type: v.literal("browser"), browserDigest: v.string() }),
			v.object({ type: v.literal("mobile"), mobileChallenge: v.string() }),
		),
		refreshDigest: v.string(),
		newUserId: v.string(),
	},
	handler: async (ctx, { refreshDigest, newUserId, digest, proof }) => {
		const result = await take(ctx, digest, "exchange", (flow) =>
			proof.type === "mobile"
				? flow.mobileChallenge === proof.mobileChallenge
				: flow.mobileChallenge === undefined &&
					flow.browserDigest === proof.browserDigest,
		);
		if (!result || result.saved.payload.type !== "exchange")
			return { type: "invalid" } as const;
		const {
			issuer,
			providerIssuer,
			redirect,
			payload: { subject, email, name },
		} = result.saved;

		return issueOidcSession(ctx, {
			issuer,
			providerIssuer,
			subject,
			email,
			name,
			redirect,
			refreshDigest,
			newUserId,
		});
	},
});

const legacyExchange = {
	issuer: v.string(),
	providerIssuer: v.string(),
	clientId: v.string(),
	...identity,
	refreshDigest: v.string(),
	newUserId: v.string(),
};

const legacyExchangeInput = v.object(legacyExchange);

export const exchangeLegacyMobile = internalMutation({
	args: legacyExchange,
	handler: async (ctx, args) => {
		const config = await currentProvider(ctx);
		if (!config || !matches(config, args)) return { type: "invalid" } as const;
		return issueOidcSession(ctx, { ...args, redirect: "/" });
	},
});

async function issueOidcSession(
	ctx: MutationCtx,
	{
		issuer,
		providerIssuer,
		subject,
		email,
		name,
		redirect,
		refreshDigest,
		newUserId,
	}: Omit<Infer<typeof legacyExchangeInput>, "clientId"> & { redirect: string },
) {
	let account = await ctx.db
		.query("accounts")
		.withIndex("by_oidc_subject", (q) =>
			q
				.eq("issuer", issuer)
				.eq("oidcIssuer", providerIssuer)
				.eq("oidcSubject", subject),
		)
		.unique();
	if (!account && process.env.OIDC_LEGACY_ISSUER_URL === providerIssuer) {
		account = await ctx.db
			.query("accounts")
			.withIndex("by_oidc_subject", (q) =>
				q
					.eq("issuer", issuer)
					.eq("oidcIssuer", undefined)
					.eq("oidcSubject", subject),
			)
			.unique();
	}
	account ??= await ctx.db
		.query("accounts")
		.withIndex("by_issuer_email", (q) =>
			q.eq("issuer", issuer).eq("email", email),
		)
		.unique();

	if (
		account?.oidcSubject &&
		(account.oidcSubject !== subject ||
			(account.oidcIssuer ?? process.env.OIDC_LEGACY_ISSUER_URL) !==
				providerIssuer)
	)
		return { type: "conflict" } as const;
	if (account?.status === "pending") return { type: "pending" } as const;
	if (
		account?.passwordHash &&
		(account.totpEnabledAt !== null ||
			account.totpSecretEnc !== null ||
			requiresFactor(await accountPolicy(ctx, issuer), account) ||
			(await ctx.db
				.query("passkeys")
				.withIndex("by_user", (q) => q.eq("userId", account!.id))
				.first()))
	)
		return { type: "factor-required" } as const;
	const link = {
		oidcSubject: subject,
		oidcIssuer: providerIssuer,
		updatedAt: Date.now(),
	};
	if (account) {
		if (
			account.oidcIssuer !== providerIssuer ||
			account.oidcSubject !== subject
		) {
			await ctx.db.patch("accounts", account._id, link);
			account = { ...account, ...link };
		}
	} else {
		const admin = await ctx.db
			.query("accounts")
			.withIndex("by_issuer_admin", (q) =>
				q.eq("issuer", issuer).eq("isAdmin", true),
			)
			.first();
		const row = await ctx.db.insert("accounts", {
			id: newUserId,
			issuer,
			email,
			name,
			status: "active",
			isAdmin: !admin,
			profileImage: null,
			passwordHash: null,
			apiTokenHash: null,
			totpSecretEnc: null,
			totpPendingSecretEnc: null,
			totpEnabledAt: null,
			totpLastStep: null,
			totpLastUsedAt: null,
			twoFactorFailedAttempts: 0,
			twoFactorLockedUntil: null,
			sessionsRevokedAt: null,
			createdAt: link.updatedAt,
			...link,
		});
		account = await ctx.db.get("accounts", row);
		if (!account) throw new Error("Missing new OIDC account");
	}
	return {
		...(await issueSession(ctx, account, refreshDigest, undefined, "oidc")),
		redirect,
	};
}

export const collectExpired = internalMutation({
	args: {},
	handler: async (ctx): Promise<void> => {
		const now = Date.now();
		const expired = await ctx.db
			.query("oidcFlows")
			.withIndex("by_expires_at", (q) => q.lte("expiresAt", now))
			.take(128);
		for (const flow of expired) await ctx.db.delete("oidcFlows", flow._id);
		if (expired.length === 128)
			await ctx.scheduler.runAfter(0, internal.oidc.collectExpired, {});
	},
});
