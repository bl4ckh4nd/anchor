import { Schema } from "effect";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { authenticatorClaims, input, reply } from "./sessionHttp";
import { nativeAuthEnabled } from "./sessions";

const patch = Schema.Struct({
	enabled: Schema.optionalKey(Schema.Boolean),
	providerName: Schema.optionalKey(
		Schema.String.check(Schema.isMaxLength(120)),
	),
	issuerUrl: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2048))),
	clientId: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(512))),
	clientSecret: Schema.optionalKey(
		Schema.String.check(Schema.isMaxLength(4096)),
	),
	disableInternalAuth: Schema.optionalKey(Schema.Boolean),
	clearClientSecret: Schema.optionalKey(Schema.Boolean),
});

function validIssuer(value: string) {
	try {
		const url = new URL(value);
		return (
			(url.protocol === "http:" || url.protocol === "https:") &&
			Boolean(url.host) &&
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash
		);
	} catch {
		return false;
	}
}

export const adminOidcSettings = httpAction(async (ctx, request) => {
	if (!nativeAuthEnabled()) return reply({ code: "NOT_FOUND" }, 404);
	const claims = await authenticatorClaims(ctx);
	if (!claims) return reply({ code: "UNAUTHENTICATED" }, 401);
	const body =
		request.method === "PATCH" ? await input(request, patch, true) : undefined;
	if (body === null || (body?.issuerUrl && !validIssuer(body.issuerUrl)))
		return reply({ code: "INVALID_OIDC_SETTINGS" }, 400);
	const outcome = body
		? await ctx.runMutation(internal.oidcSettings.adminUpdate, {
				...claims,
				patch: body,
			})
		: await ctx.runQuery(internal.oidcSettings.adminRead, claims);
	switch (outcome.type) {
		case "settings":
			return reply(outcome.settings);
		case "unauthenticated":
			return reply({ code: "UNAUTHENTICATED" }, 401);
		case "forbidden":
			return reply({ code: "FORBIDDEN" }, 403);
		case "locked":
			return reply(
				{
					code: "OIDC_SETTINGS_LOCKED",
					message: "OIDC settings are locked by environment variables",
				},
				403,
			);
	}
});
