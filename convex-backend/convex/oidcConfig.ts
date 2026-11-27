import type { QueryCtx } from "./_generated/server";

export const defaults = {
	enabled: false,
	providerName: "",
	issuerUrl: "",
	clientId: "",
	clientSecret: "",
	disableInternalAuth: false,
};

export function storedSettings(ctx: QueryCtx, issuer: string) {
	return ctx.db
		.query("oidcSettings")
		.withIndex("by_issuer", (q) => q.eq("issuer", issuer))
		.unique();
}

export function environmentSettings() {
	const env = process.env;
	if (
		env.OIDC_ENABLED === undefined ||
		!env.OIDC_ISSUER_URL ||
		!env.OIDC_CLIENT_ID
	)
		return null;
	return {
		enabled: env.OIDC_ENABLED.toLowerCase() === "true",
		issuerUrl: env.OIDC_ISSUER_URL,
		clientId: env.OIDC_CLIENT_ID,
		providerName: env.OIDC_PROVIDER_NAME ?? "",
		clientSecret: env.OIDC_CLIENT_SECRET ?? "",
		disableInternalAuth: env.DISABLE_INTERNAL_AUTH?.toLowerCase() === "true",
	};
}

export async function effectiveOidc(ctx: QueryCtx, issuer: string) {
	return (
		environmentSettings() ?? (await storedSettings(ctx, issuer)) ?? defaults
	);
}

export function oidcCallbackUrl() {
	const url = new URL(process.env.APP_URL || "http://localhost:3000");
	if (
		!["https:", "http:"].includes(url.protocol) ||
		url.username ||
		url.password
	)
		throw new Error("Invalid APP_URL");
	return new URL("/api/auth/oidc/callback", url).href;
}

export function configuredOidc(settings: typeof defaults) {
	if (!settings.enabled || !settings.clientId) return false;
	try {
		const issuer = new URL(settings.issuerUrl);
		return (
			issuer.protocol === "https:" &&
			!issuer.username &&
			!issuer.password &&
			!issuer.search &&
			!issuer.hash
		);
	} catch {
		return false;
	}
}

export async function localAuthDisabled(ctx: QueryCtx, issuer: string) {
	const settings = await effectiveOidc(ctx, issuer);
	return configuredOidc(settings) && settings.disableInternalAuth;
}
