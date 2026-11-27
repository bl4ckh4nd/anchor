import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import {
	defaults,
	environmentSettings,
	oidcCallbackUrl,
	storedSettings,
} from "./oidcConfig";
import { oidcFields } from "./schema";
import { sessionClaims, verifiedAccount } from "./sessions";

function view(config: typeof defaults, source: "env" | "database") {
	return {
		enabled: config.enabled,
		providerName: config.providerName || "OIDC Provider",
		issuerUrl: config.issuerUrl || undefined,
		clientId: config.clientId || undefined,
		hasClientSecret: Boolean(config.clientSecret),
		callbackUrl: oidcCallbackUrl(),
		disableInternalAuth: config.disableInternalAuth,
		isLocked: source === "env",
		source,
	};
}

const patch = v.object({
	enabled: v.optional(oidcFields.enabled),
	providerName: v.optional(oidcFields.providerName),
	issuerUrl: v.optional(oidcFields.issuerUrl),
	clientId: v.optional(oidcFields.clientId),
	clientSecret: v.optional(oidcFields.clientSecret),
	disableInternalAuth: v.optional(oidcFields.disableInternalAuth),
	clearClientSecret: v.optional(v.boolean()),
});

export const adminRead = internalQuery({
	args: sessionClaims,
	handler: async (ctx, claims) => {
		const actor = await verifiedAccount(ctx, claims);
		if (!actor) return { type: "unauthenticated" } as const;
		if (!actor.isAdmin) return { type: "forbidden" } as const;
		const env = environmentSettings();
		const settings = env
			? view(env, "env")
			: view((await storedSettings(ctx, actor.issuer)) ?? defaults, "database");
		return { type: "settings", settings } as const;
	},
});

export const adminUpdate = internalMutation({
	args: { ...sessionClaims, patch },
	handler: async (
		ctx,
		{ patch: { clearClientSecret, ...changes }, ...claims },
	) => {
		const actor = await verifiedAccount(ctx, claims);
		if (!actor) return { type: "unauthenticated" } as const;
		if (!actor.isAdmin) return { type: "forbidden" } as const;
		if (environmentSettings()) return { type: "locked" } as const;
		if (clearClientSecret) changes.clientSecret = "";
		const existing = await storedSettings(ctx, actor.issuer);
		if (existing) await ctx.db.patch("oidcSettings", existing._id, changes);
		else
			await ctx.db.insert("oidcSettings", {
				issuer: actor.issuer,
				...defaults,
				...changes,
			});
		return {
			type: "settings",
			settings: view({ ...defaults, ...existing, ...changes }, "database"),
		} as const;
	},
});
