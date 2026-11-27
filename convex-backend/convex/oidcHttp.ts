import type { FunctionReturnType } from "convex/server";
import { Schema } from "effect";
import { internal } from "./_generated/api";
import { httpAction, type ActionCtx } from "./_generated/server";
import { oidcCallbackUrl } from "./oidcConfig";
import { input, reply, signedSession } from "./sessionHttp";

function cookieSettings() {
	return new URL(oidcCallbackUrl()).protocol === "https:"
		? { name: "__Host-anchor_oidc", path: "/", secure: "; Secure" }
		: { name: "anchor_oidc", path: "/api/auth/oidc", secure: "" };
}
const hex = (bytes: Uint8Array) =>
	Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const randomToken = () => hex(crypto.getRandomValues(new Uint8Array(32)));
const digest = async (value: string) =>
	hex(
		new Uint8Array(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
		),
	);
const mobileReturn = "com.zhfahim.anchor.compose://oidc/callback";
const tokenPattern = /^[a-f0-9]{64}$/;
const exchangeInput = Schema.Struct({
	code: Schema.String.check(Schema.isPattern(tokenPattern)),
});

function browserToken(request: Request) {
	const { name } = cookieSettings();
	const entry = request.headers
		.get("cookie")
		?.split(";")
		.map((cookie) => cookie.trim())
		.find((cookie) => cookie.startsWith(name + "="));
	const token = entry?.slice(name.length + 1);
	return token && tokenPattern.test(token) ? token : null;
}

function browserCookie(token: string, maxAge: number) {
	const { name, path, secure } = cookieSettings();
	return `${name}=${token}; Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

function redirect(location: string, cookie?: string) {
	return new Response(null, {
		status: 302,
		headers: {
			Location: location,
			"Cache-Control": "no-store",
			"Referrer-Policy": "no-referrer",
			...(cookie ? { "Set-Cookie": cookie } : {}),
		},
	});
}

function safeReturnTo(value: string | null) {
	if (!value || value.length > 2048 || /[\\\x00-\x20\x7f]/.test(value))
		return "/";
	try {
		const callback = new URL(oidcCallbackUrl());
		const location = new URL(value, callback.origin);
		if (
			location.origin !== callback.origin ||
			location.username ||
			location.password ||
			location.pathname.startsWith("//")
		)
			return "/";
		return location.pathname + location.search + location.hash;
	} catch {
		return "/";
	}
}

function provider(config: {
	issuerUrl: string;
	clientId: string;
	clientSecret: string;
}) {
	return {
		issuerUrl: config.issuerUrl,
		clientId: config.clientId,
		clientSecret: config.clientSecret,
		callbackUrl: oidcCallbackUrl(),
	};
}

const mobileExchangeInput = Schema.Struct({
	code: exchangeInput.fields.code,
	verifier: exchangeInput.fields.code,
});

function failure(message: string, status = 400, mobile = false) {
	const target = mobile
		? new URL(mobileReturn)
		: new URL("/login", oidcCallbackUrl());
	target.searchParams.set("error", message);
	target.searchParams.set("status", String(status));
	return redirect(target.href);
}

export const configuration = httpAction(async (ctx) => {
	const config = await ctx.runQuery(internal.oidc.configuration);
	return reply({
		enabled: Boolean(config),
		providerName: config?.providerName || "OIDC Provider",
		issuerUrl: config?.issuerUrl,
		clientId: config?.clientId,
		disableInternalAuth: config?.disableInternalAuth ?? false,
	});
});

export const initiate = httpAction(async (ctx, request) => {
	const query = new URL(request.url).searchParams;
	const challenge = query.get("mobile_challenge");
	if (challenge !== null && !tokenPattern.test(challenge))
		return reply({ code: "INVALID_MOBILE_CHALLENGE" }, 400);
	const mobile = challenge !== null;
	const config = await ctx.runQuery(internal.oidc.configuration);
	if (!config)
		return reply(
			{ code: "OIDC_DISABLED", message: "OIDC is not enabled" },
			400,
		);
	const attempt = await ctx.runMutation(internal.sessions.attempt, {
		email: "",
	});
	if (attempt.type === "rate-limit")
		return reply({ code: "TOO_MANY_ATTEMPTS" }, 429);
	try {
		const action = await ctx.runAction(
			internal.oidcActions.prepare,
			provider(config),
		);
		const browser = randomToken();
		const saved = await ctx.runMutation(internal.oidc.save, {
			issuer: config.issuer,
			providerIssuer: config.issuerUrl,
			clientId: config.clientId,
			digest: await digest(action.state),
			browserDigest: await digest(browser),
			redirect: safeReturnTo(query.get("redirect")),
			...(challenge ? { mobileChallenge: challenge } : {}),
			payload: {
				type: "state",
				nonce: action.nonce,
				verifier: action.verifier,
			},
		});
		if (saved) return redirect(action.url, browserCookie(browser, 600));
	} catch {
		return failure("Could not reach the sign-in provider.", 503, mobile);
	}
	return failure("Sign-in configuration changed. Try again.", 400, mobile);
});

export const callback = httpAction(async (ctx, request) => {
	const browser = browserToken(request);
	const query = new URL(request.url).searchParams;
	const state = query.get("state");
	if (!browser || !state || !/^[\w-]{43}$/.test(state))
		return failure("Invalid or expired sign-in request.");
	const flow = await ctx.runMutation(internal.oidc.consumeState, {
		digest: await digest(state),
		browserDigest: await digest(browser),
	});
	if (!flow) return failure("Invalid or expired sign-in request.");
	const mobile = flow.saved.mobileChallenge !== undefined;
	if (query.has("error"))
		return failure("The sign-in provider declined the request.", 401, mobile);
	const code = query.get("code");
	if (!code || code.length > 4096)
		return failure("Missing or invalid provider code.", 400, mobile);
	try {
		const url = new URL(oidcCallbackUrl());
		url.search = query.toString();
		const identity = await ctx.runAction(internal.oidcActions.authenticate, {
			...provider(flow.config),
			url: url.href,
			state,
			nonce: flow.proof.nonce,
			verifier: flow.proof.verifier,
		});
		if (!identity)
			return failure(
				"The provider did not verify your email address.",
				403,
				mobile,
			);
		const exchange = randomToken();
		const saved = await ctx.runMutation(internal.oidc.save, {
			issuer: flow.saved.issuer,
			providerIssuer: flow.saved.providerIssuer,
			clientId: flow.saved.clientId,
			digest: await digest(exchange),
			browserDigest: flow.saved.browserDigest,
			redirect: flow.saved.redirect,
			...(flow.saved.mobileChallenge
				? { mobileChallenge: flow.saved.mobileChallenge }
				: {}),
			payload: { type: "exchange", ...identity },
		});
		if (!saved)
			return failure("Sign-in configuration changed. Try again.", 400, mobile);
		const target = mobile
			? new URL(mobileReturn)
			: new URL("/login", oidcCallbackUrl());
		target.searchParams.set("code", exchange);
		if (!mobile) target.searchParams.set("redirect", flow.saved.redirect);
		return redirect(
			target.href,
			mobile ? browserCookie("", 0) : browserCookie(browser, 60),
		);
	} catch {
		return failure("Could not verify sign-in with the provider.", 401, mobile);
	}
});

export const exchange = httpAction(async (ctx, request) => {
	const browser = browserToken(request);
	const data = await input(request, exchangeInput, true);
	if (!browser || !data) return reply({ code: "INVALID_LOGIN_CODE" }, 400);
	return completeExchange(ctx, data.code, {
		type: "browser",
		browserDigest: await digest(browser),
	});
});

export const exchangeCompose = httpAction(async (ctx, request) => {
	const data = await input(request, mobileExchangeInput, true);
	if (!data) return reply({ code: "INVALID_LOGIN_CODE" }, 400);
	return completeExchange(ctx, data.code, {
		type: "mobile",
		mobileChallenge: await digest(data.verifier),
	});
});

const legacyMobileInput = Schema.Struct({
	access_token: Schema.String.check(
		Schema.isBetweenLength(1, 16_384),
		Schema.isPattern(/^[A-Za-z0-9._~+\/-]+=*$/),
	),
});

export const exchangeLegacyMobile = httpAction(async (ctx, request) => {
	const data = await input(request, legacyMobileInput, true, 20 * 1024);
	if (!data) return reply({ code: "INVALID_ACCESS_TOKEN" }, 400);
	const invalid = () =>
		reply(
			{
				code: "INVALID_OIDC_TOKEN",
				message: "Invalid or expired OIDC token. Please sign in again.",
			},
			401,
		);
	const config = await ctx.runQuery(internal.oidc.configuration, {});
	if (!config) return invalid();
	const identity = await ctx
		.runAction(internal.oidcActions.authenticateLegacyMobile, {
			issuerUrl: config.issuerUrl,
			clientId: config.clientId,
			clientSecret: config.clientSecret,
			callbackUrl: oidcCallbackUrl(),
			accessToken: data.access_token,
		})
		.catch(() => null);
	if (!identity) return invalid();
	const refresh = randomToken() + randomToken();
	const result = await ctx.runMutation(internal.oidc.exchangeLegacyMobile, {
		issuer: config.issuer,
		providerIssuer: config.issuerUrl,
		clientId: config.clientId,
		...identity,
		refreshDigest: await digest(refresh),
		newUserId: crypto.randomUUID(),
	});
	if (result.type === "invalid") return invalid();
	return exchangeResponse(ctx, result, refresh, "legacy");
});

async function completeExchange(
	ctx: ActionCtx,
	code: string,
	proof:
		| { type: "browser"; browserDigest: string }
		| { type: "mobile"; mobileChallenge: string },
) {
	const refresh = randomToken() + randomToken();
	const result = await ctx.runMutation(internal.oidc.exchange, {
		digest: await digest(code),
		proof,
		refreshDigest: await digest(refresh),
		newUserId: crypto.randomUUID(),
	});
	return exchangeResponse(ctx, result, refresh, proof.type);
}

async function exchangeResponse(
	ctx: ActionCtx,
	result: FunctionReturnType<typeof internal.oidc.exchange>,
	refresh: string,
	channel: "browser" | "mobile" | "legacy",
) {
	switch (result.type) {
		case "invalid":
			return reply(
				{
					code: "INVALID_LOGIN_CODE",
					message: "Invalid or expired login code",
				},
				400,
			);
		case "conflict":
			return reply(
				{
					code: "OIDC_ACCOUNT_CONFLICT",
					message:
						"This email is already linked to a different sign-in account.",
				},
				409,
			);
		case "pending":
			return reply(
				{ code: "ACCOUNT_PENDING", message: "Account pending approval." },
				channel === "legacy" ? 401 : 403,
			);
		case "factor-required":
			return reply(
				{
					code: "ADDITIONAL_FACTOR_REQUIRED",
					message: "Sign in with your password and second factor.",
				},
				403,
			);
		case "session": {
			const response = await signedSession(
				ctx,
				result,
				refresh,
				undefined,
				200,
				channel !== "mobile" ? result.redirect : undefined,
			);
			if (channel === "browser")
				response.headers.set("Set-Cookie", browserCookie("", 0));
			response.headers.set("Referrer-Policy", "no-referrer");
			return response;
		}
	}
}
