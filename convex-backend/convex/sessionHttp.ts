import { Effect, Schema } from "effect";
import type { FunctionReturnType } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction, type ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
	authenticatedIdentity,
	authorizedIdentity,
	nativeAuthEnabled,
} from "./sessions";

const loginInput = Schema.Struct({
	email: Schema.String.check(Schema.isBetweenLength(1, 254)),
	password: Schema.String.check(Schema.isBetweenLength(1, 4096)),
});
const tokenInput = Schema.String.check(Schema.isPattern(/^[0-9a-f]{128}$/));
const refreshInput = Schema.Struct({ refresh_token: tokenInput });
const factorValue = Schema.String.check(Schema.isBetweenLength(1, 32));
const factorInput = Schema.Struct({
	challenge: tokenInput,
	code: Schema.optionalKey(factorValue),
	recoveryCode: Schema.optionalKey(factorValue),
});
const logoutInput = Schema.Struct({
	refreshToken: Schema.optionalKey(tokenInput),
});
const profileInput = Schema.Struct({
	name: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const passwordChangeInput = Schema.Struct({
	currentPassword: loginInput.fields.password,
	newPassword: Schema.String.check(Schema.isBetweenLength(8, 72)),
});

export function reply(body: unknown, status = 200) {
	return Response.json(body, {
		status,
		headers: { "Cache-Control": "no-store" },
	});
}

export async function input<T>(
	request: Request,
	schema: Schema.Decoder<T>,
	strict = false,
	maxBytes = 8192,
): Promise<T | null> {
	const reader = request.body?.getReader();
	if (!reader) return null;
	const decoder = new TextDecoder();
	let size = 0;
	let text = "";
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			size += chunk.value.byteLength;
			if (size > maxBytes) return null;
			text += decoder.decode(chunk.value, { stream: true });
		}
		text += decoder.decode();
		return await Effect.runPromise(
			Schema.decodeUnknownEffect(
				schema,
				strict ? { onExcessProperty: "error" } : undefined,
			)(JSON.parse(text)).pipe(Effect.orElseSucceed(() => null)),
		);
	} catch {
		return null;
	} finally {
		await reader.cancel();
	}
}

export const login = httpAction(async (ctx, request) => {
	if (!nativeAuthEnabled()) return reply({ code: "NOT_FOUND" }, 404);
	const body = await input(request, loginInput);
	if (!body) return reply({ code: "INVALID_REQUEST" }, 400);
	const attempt = await ctx.runMutation(internal.sessions.attempt, {
		email: body.email,
		login: true,
	});
	if (attempt.type === "local-disabled")
		return reply({ code: "LOCAL_AUTH_DISABLED" }, 403);
	if (attempt.type === "disabled")
		return reply({ code: "AUTH_UNAVAILABLE" }, 503);
	if (attempt.type === "rate-limit")
		return reply({ code: "TOO_MANY_ATTEMPTS" }, 429);
	const checked = await ctx.runAction(internal.sessionActions.verifyPassword, {
		password: body.password,
		passwordHash: attempt.passwordHash,
	});
	if (checked.type === "disabled")
		return reply({ code: "AUTH_UNAVAILABLE" }, 503);
	if (
		checked.type !== "verified" ||
		!attempt.accountId ||
		!attempt.passwordHash
	)
		return reply({ code: "INVALID_CREDENTIALS" }, 401);
	const result = await ctx.runMutation(internal.sessions.begin, {
		issuer: attempt.issuer,
		userId: attempt.accountId,
		passwordHash: attempt.passwordHash,
		digest: checked.digest,
	});
	if (result.type === "local-disabled")
		return reply({ code: "LOCAL_AUTH_DISABLED" }, 403);
	if (result.type === "invalid")
		return reply({ code: "INVALID_CREDENTIALS" }, 401);
	if (result.type === "pending") return reply({ code: "ACCOUNT_PENDING" }, 403);
	if (result.type === "passkey")
		return reply({ message: "Sign in with your passkey", passkeyRequired: true }, 403);
	if (result.type === "factor-required")
		return reply({ code: "ADDITIONAL_FACTOR_REQUIRED" }, 403);
	if (result.type === "unavailable")
		return reply({ code: "AUTH_UNAVAILABLE" }, 503);
	if (result.type === "enroll")
		return reply(
			{
				statusCode: 403,
				message: "Two-factor setup required",
				error: "Forbidden",
				twoFactorSetupRequired: true,
				challenge: checked.token,
				methods: result.methods,
			},
			403,
		);
	if (result.type === "challenge")
		return reply(
			{
				statusCode: 401,
				message: "Two-factor code required",
				error: "Unauthorized",
				twoFactorRequired: true,
				challenge: checked.token,
			},
			401,
		);
	return signedSession(ctx, result, checked.token);
});

export async function signedSession<T extends { id: string }>(
	ctx: ActionCtx,
	result: { issuer: string; sessionId: Id<"sessions">; user: T },
	refresh: string,
	recoveryCodes?: string[],
	status = 200,
	redirectUrl?: string,
) {
	const token = await ctx.runAction(internal.sessionActions.signAccess, {
		issuer: result.issuer,
		userId: result.user.id,
		sessionId: result.sessionId,
	});
	return token
		? reply(
				{
					access_token: token,
					refresh_token: refresh,
					user: result.user,
					recoveryCodes,
					redirectUrl,
				},
				status,
			)
		: reply({ code: "AUTH_UNAVAILABLE" }, 503);
}

export const loginFactor = httpAction(async (ctx, request) => {
	if (!nativeAuthEnabled()) return reply({ code: "NOT_FOUND" }, 404);
	const body = await input(request, factorInput);
	if (!body || (body.code === undefined) === (body.recoveryCode === undefined))
		return reply({ code: "INVALID_REQUEST" }, 400);
	const { challenge, ...code } = body;
	const digest = await ctx.runAction(internal.sessionActions.refreshDigest, {
		token: challenge,
	});
	const factor = await ctx.runQuery(internal.sessions.factor, { digest });
	if (!factor) return reply({ code: "INVALID_CHALLENGE" }, 401);
	if (factor.type === "locked")
		return reply({ code: "TOO_MANY_ATTEMPTS" }, 429);
	const verified = await ctx.runAction(internal.sessionActions.verifyFactor, {
		...code,
		secret: factor.secret,
	});
	if (!verified) return reply({ code: "AUTH_UNAVAILABLE" }, 503);
	const result = await ctx.runMutation(internal.sessions.finishFactor, {
		digest,
		secret: factor.secret,
		proof: verified.proof,
		refreshDigest: verified.refreshDigest,
	});
	if (result.type === "locked")
		return reply({ code: "TOO_MANY_ATTEMPTS" }, 429);
	if (result.type !== "session") return reply({ code: "INVALID_CODE" }, 401);
	return signedSession(ctx, result, verified.token);
});

export const clipperSession = httpAction(async (ctx) => {
	if (!nativeAuthEnabled()) return reply({ code: "NOT_FOUND" }, 404);
	const identity = await authenticatedIdentity(ctx);
	if (!identity || typeof identity.anchorSession !== "string")
		return reply({ code: "UNAUTHENTICATED" }, 401);
	const prepared = await ctx.runAction(internal.sessionActions.prepareSession, {});
	if (!prepared) return reply({ code: "AUTH_UNAVAILABLE" }, 503);
	const session = await ctx.runMutation(internal.sessions.createClipperSession, {
		issuer: identity.issuer,
		subject: identity.subject,
		sessionId: identity.anchorSession,
		refreshDigest: prepared.digest,
	});
	return session
		? signedSession(ctx, session, prepared.token)
		: reply({ code: "UNAUTHENTICATED" }, 401);
});

export const refresh = httpAction(async (ctx, request) => {
	if (!nativeAuthEnabled()) return reply({ code: "NOT_FOUND" }, 404);
	const body = await input(request, refreshInput);
	if (!body) return reply({ code: "INVALID_REQUEST" }, 400);
	const computed = await ctx.runAction(internal.sessionActions.deriveRefresh, {
		token: body.refresh_token,
	});
	if (!computed) return reply({ code: "AUTH_UNAVAILABLE" }, 503);
	const session = await ctx.runMutation(internal.sessions.rotate, {
		digest: computed.digest,
		nextDigest: computed.nextDigest,
	});
	if (!session) return reply({ code: "INVALID_REFRESH_TOKEN" }, 401);
	const token = await ctx.runAction(
		internal.sessionActions.signAccess,
		session,
	);
	return token
		? reply({ access_token: token, refresh_token: computed.next })
		: reply({ code: "AUTH_UNAVAILABLE" }, 503);
});

export const logout = httpAction(async (ctx, request) => {
	if (!nativeAuthEnabled()) return reply({ code: "NOT_FOUND" }, 404);
	const body = await input(request, logoutInput);
	if (!body) return reply({ code: "INVALID_REQUEST" }, 400);
	if (body.refreshToken) {
		const digest = await ctx.runAction(internal.sessionActions.refreshDigest, {
			token: body.refreshToken,
		});
		await ctx.runMutation(internal.sessions.revoke, { digest });
	}
	return new Response(null, { headers: { "Cache-Control": "no-store" } });
});

export const me = httpAction(async (ctx) => {
	if (!nativeAuthEnabled()) return reply({ code: "NOT_FOUND" }, 404);
	const identity = await authenticatedIdentity(ctx);
	if (!identity || typeof identity.anchorSession !== "string")
		return reply({ code: "UNAUTHENTICATED" }, 401);
	const profile = await ctx.runQuery(internal.sessions.me, {
		issuer: identity.issuer,
		subject: identity.subject,
		sessionId: identity.anchorSession,
	});
	return profile ? reply(profile) : reply({ code: "UNAUTHENTICATED" }, 401);
});

export const exchange = httpAction(async (ctx, request) => {
	if (!nativeAuthEnabled()) return reply({ code: "NOT_FOUND" }, 404);
	if (!(await authorizedIdentity(ctx)))
		return reply({ code: "UNAUTHENTICATED" }, 401);
	return reply({ token: request.headers.get("Authorization")?.split(" ")[1] });
});

export async function authenticatorClaims(ctx: ActionCtx) {
	const identity = await authenticatedIdentity(ctx);
	return typeof identity?.anchorSession === "string"
		? {
				issuer: identity.issuer,
				subject: identity.subject,
				sessionId: identity.anchorSession,
			}
		: null;
}

export const updateProfile = httpAction(async (ctx, request) => {
	if (!nativeAuthEnabled()) return reply({ code: "NOT_FOUND" }, 404);
	const claims = await authenticatorClaims(ctx);
	if (!claims) return reply({ code: "UNAUTHENTICATED" }, 401);
	const body = await input(request, profileInput);
	const name = body?.name ? body.name.trim() : undefined;
	if (!body || (name !== undefined && Array.from(name).length > 100))
		return reply(
			{
				code: "INVALID_REQUEST",
				message: "Enter a name of up to 100 characters.",
			},
			400,
		);
	const profile = await ctx.runMutation(internal.sessions.updateProfile, {
		...claims,
		...(name === undefined ? {} : { name }),
	});
	return profile ? reply(profile) : reply({ code: "UNAUTHENTICATED" }, 401);
});

export const changePassword = httpAction(async (ctx, request) => {
	if (!nativeAuthEnabled()) return reply({ code: "NOT_FOUND" }, 404);
	const claims = await authenticatorClaims(ctx);
	if (!claims) return reply({ code: "UNAUTHENTICATED" }, 401);
	const body = await input(request, passwordChangeInput);
	if (!body || new TextEncoder().encode(body.newPassword).length > 72)
		return reply(
			{
				code: "INVALID_REQUEST",
				message:
					"Enter your current password and a new password between 8 characters and 72 bytes.",
			},
			400,
		);
	const attempt = await ctx.runMutation(
		internal.sessions.accountPasswordAttempt,
		claims,
	);
	if (attempt.type === "unauthenticated")
		return reply({ code: "UNAUTHENTICATED" }, 401);
	if (attempt.type === "passwordless")
		return reply(
			{
				code: "PASSWORD_MANAGED_BY_PROVIDER",
				message: "Change your password through your identity provider.",
			},
			400,
		);
	if (attempt.type === "rate-limit")
		return reply({ code: "TOO_MANY_ATTEMPTS" }, 429);
	const result = await ctx.runAction(
		internal.sessionActions.preparePasswordChange,
		{
			...body,
			passwordHash: attempt.passwordHash,
		},
	);
	if (result.type === "invalid")
		return reply(
			{ code: "INVALID_PASSWORD", message: "Current password is incorrect" },
			403,
		);
	if (result.type === "unchanged")
		return reply(
			{
				code: "PASSWORD_UNCHANGED",
				message: "New password must be different from current password",
			},
			400,
		);
	const outcome = await ctx.runMutation(
		internal.sessions.finishPasswordChange,
		{
			...claims,
			passwordHash: attempt.passwordHash,
			replacement: result.replacement,
		},
	);
	if (outcome === "unauthenticated")
		return reply({ code: "UNAUTHENTICATED" }, 401);
	if (outcome === "conflict")
		return reply(
			{
				code: "PASSWORD_CHANGED",
				message: "Your password changed while this request was in progress.",
			},
			409,
		);
	return reply({ message: "Password changed successfully" });
});

const accountDeletionInput = Schema.Struct({
	password: Schema.optionalKey(loginInput.fields.password),
});

export const deleteAccount = httpAction(async (ctx, request) => {
	if (!nativeAuthEnabled()) return reply({ code: "NOT_FOUND" }, 404);
	const claims = await authenticatorClaims(ctx);
	if (!claims) return reply({ code: "UNAUTHENTICATED" }, 401);
	const body = await input(request, accountDeletionInput);
	if (!body) return reply({ code: "INVALID_REQUEST" }, 400);
	const attempt = await ctx.runMutation(
		internal.sessions.accountPasswordAttempt,
		claims,
	);
	if (attempt.type === "unauthenticated")
		return reply({ code: "UNAUTHENTICATED" }, 401);
	if (attempt.type === "rate-limit")
		return reply({ code: "TOO_MANY_ATTEMPTS" }, 429);
	let passwordHash: string | null;
	if (attempt.type === "passwordless") {
		passwordHash = null;
	} else {
		const check =
			body.password &&
			(await ctx.runAction(internal.sessionActions.verifyPassword, {
				password: body.password,
				passwordHash: attempt.passwordHash,
			}));
		if (check && check.type === "disabled")
			return reply({ code: "AUTH_UNAVAILABLE" }, 503);
		if (!check || check.type !== "verified")
			return reply(
				{ code: "INVALID_PASSWORD", message: "Current password is incorrect" },
				403,
			);
		passwordHash = attempt.passwordHash;
	}
	const result = await ctx.runMutation(internal.sessions.deleteAccount, {
		...claims,
		target: { type: "self", passwordHash },
	});
	if (result === "deleted") return reply({ message: "Account deleted" });
	if (result === "last-admin")
		return reply(
			{
				code: "LAST_ADMIN",
				message: "Make someone else an admin before deleting this account",
			},
			409,
		);
	if (result === "invalid-password")
		return reply(
			{ code: "INVALID_PASSWORD", message: "Current password is incorrect" },
			403,
		);
	return adminAccountFailure(result);
});

export const authenticatorStatus = httpAction(async (ctx) => {
	if (!nativeAuthEnabled()) return reply({ code: "NOT_FOUND" }, 404);
	const claims = await authenticatorClaims(ctx);
	const status =
		claims &&
		(await ctx.runQuery(internal.sessions.authenticatorStatus, claims));
	return status ? reply(status) : reply({ code: "UNAUTHENTICATED" }, 401);
});

export const setupAuthenticator = httpAction(async (ctx, request) => {
	if (!nativeAuthEnabled()) return reply({ code: "NOT_FOUND" }, 404);
	const claims = await authenticatorClaims(ctx);
	const account =
		claims &&
		(await ctx.runQuery(internal.sessions.authenticatorEnrollment, claims));
	if (!claims || !account) return reply({ code: "UNAUTHENTICATED" }, 401);
	const body = await input(request, currentFactor);
	if (account.enabled && (!account.current || !oneFactor(body)))
		return reply({ code: "CURRENT_FACTOR_REQUIRED" }, 403);
	const setup = await ctx.runAction(
		internal.sessionActions.prepareAuthenticator,
		{ email: account.email },
	);
	if (!setup) return reply({ code: "AUTH_UNAVAILABLE" }, 503);
	if (account.current && oneFactor(body)) {
		const proof = await ctx.runAction(internal.sessionActions.verifyFactor, {
			...body,
			secret: account.current,
		});
		if (!proof) return reply({ code: "AUTH_UNAVAILABLE" }, 503);
		const outcome = await ctx.runMutation(
			internal.sessions.manageAuthenticator,
			{
				...claims,
				secret: account.current,
				proof: proof.proof,
				change: { type: "replace", encrypted: setup.encrypted },
			},
		);
		if (outcome !== "accepted") return factorFailure(outcome);
		return reply({ secret: setup.secret, otpauthUri: setup.otpauthUri });
	}
	const saved = await ctx.runMutation(internal.sessions.saveAuthenticator, {
		...claims,
		encrypted: setup.encrypted,
	});
	return saved
		? reply({ secret: setup.secret, otpauthUri: setup.otpauthUri })
		: reply({ code: "SETUP_CHANGED" }, 409);
});

export const enableAuthenticator = httpAction(async (ctx, request) => {
	if (!nativeAuthEnabled()) return reply({ code: "NOT_FOUND" }, 404);
	const claims = await authenticatorClaims(ctx);
	const account =
		claims &&
		(await ctx.runQuery(internal.sessions.authenticatorEnrollment, claims));
	if (!claims || !account) return reply({ code: "UNAUTHENTICATED" }, 401);
	if (!account.pending) return reply({ code: "START_SETUP_FIRST" }, 400);
	const body = await input(request, Schema.Struct({ code: factorValue }));
	if (!body) return reply({ code: "INVALID_REQUEST" }, 400);
	const verified = await ctx.runAction(
		internal.sessionActions.verifyEnrollment,
		{ encrypted: account.pending, code: body.code },
	);
	if (verified.type === "unavailable")
		return reply({ code: "AUTH_UNAVAILABLE" }, 503);
	const codes = verified.type === "verified" ? verified.codes : [];
	const result = await ctx.runMutation(internal.sessions.enableAuthenticator, {
		...claims,
		encrypted: account.pending,
		step: verified.type === "verified" ? verified.step : null,
		digest: verified.type === "verified" ? verified.digest : "",
		codes: codes.map(({ id, hash }) => ({ id, hash })),
	});
	if (result.type === "locked")
		return reply({ code: "TOO_MANY_ATTEMPTS" }, 429);
	if (result.type === "invalid" || verified.type !== "verified")
		return reply({ code: "INVALID_CODE" }, 400);
	return signedSession(
		ctx,
		result,
		verified.token,
		codes.map(({ code }) => code),
	);
});

const currentFactor = Schema.Struct({
	code: Schema.optionalKey(factorValue),
	recoveryCode: Schema.optionalKey(factorValue),
});
const factorManagementInput = Schema.Struct({
	password: loginInput.fields.password,
	...currentFactor.fields,
});

function oneFactor(
	body: { code?: string; recoveryCode?: string } | null,
): body is { code?: string; recoveryCode?: string } {
	return (
		body !== null &&
		(body.code !== undefined) !== (body.recoveryCode !== undefined)
	);
}

function factorFailure(outcome: "locked" | "invalid" | "policy") {
	if (outcome === "policy")
		return reply({ code: "TWO_FACTOR_POLICY_REQUIRED" }, 403);
	return outcome === "locked"
		? reply({ code: "TOO_MANY_ATTEMPTS" }, 429)
		: reply({ code: "INVALID_CODE" }, 400);
}

async function manageAuthenticator(
	ctx: ActionCtx,
	request: Request,
	type: "disable" | "rotate",
) {
	if (!nativeAuthEnabled()) return reply({ code: "NOT_FOUND" }, 404);
	const claims = await authenticatorClaims(ctx);
	const account =
		claims &&
		(await ctx.runQuery(internal.sessions.authenticatorEnrollment, claims));
	if (!claims || !account) return reply({ code: "UNAUTHENTICATED" }, 401);
	const body = await input(request, factorManagementInput);
	if (!body || !oneFactor(body) || (type === "rotate" && !body.code))
		return reply({ code: "INVALID_REQUEST" }, 400);
	const attempt = await ctx.runMutation(internal.sessions.attempt, {
		email: account.email,
	});
	if (attempt.type === "disabled" || attempt.type === "local-disabled")
		return reply({ code: "AUTH_UNAVAILABLE" }, 503);
	if (attempt.type === "rate-limit")
		return reply({ code: "TOO_MANY_ATTEMPTS" }, 429);
	const checked = await ctx.runAction(internal.sessionActions.verifyPassword, {
		password: body.password,
		passwordHash: account.passwordHash,
	});
	if (checked.type === "disabled")
		return reply({ code: "AUTH_UNAVAILABLE" }, 503);
	if (checked.type !== "verified" || !account.passwordHash)
		return reply({ code: "INVALID_PASSWORD" }, 403);
	if (!account.current) return reply({ code: "INVALID_CODE" }, 400);
	const proof = await ctx.runAction(internal.sessionActions.verifyFactor, {
		secret: account.current,
		...(body.code ? { code: body.code } : { recoveryCode: body.recoveryCode! }),
	});
	if (!proof) return reply({ code: "AUTH_UNAVAILABLE" }, 503);
	const codes =
		type === "rotate"
			? await ctx.runAction(internal.sessionActions.rotateRecoveryCodes, {})
			: [];
	if (!codes) return reply({ code: "AUTH_UNAVAILABLE" }, 503);
	const outcome = await ctx.runMutation(internal.sessions.manageAuthenticator, {
		...claims,
		secret: account.current,
		passwordHash: account.passwordHash,
		proof: proof.proof,
		change:
			type === "rotate"
				? { type, codes: codes.map(({ id, hash }) => ({ id, hash })) }
				: { type },
	});
	if (outcome !== "accepted") return factorFailure(outcome);
	return type === "rotate"
		? reply({ recoveryCodes: codes.map(({ code }) => code) })
		: reply({ message: "Two-factor turned off" });
}

export const disableAuthenticator = httpAction((ctx, request) =>
	manageAuthenticator(ctx, request, "disable"),
);
export const regenerateRecoveryCodes = httpAction((ctx, request) =>
	manageAuthenticator(ctx, request, "rotate"),
);

const enrollmentInput = Schema.Struct({ challenge: tokenInput });
const enrollmentConfirmation = Schema.Struct({
	challenge: tokenInput,
	code: factorValue,
});

export const setupRequiredAuthenticator = httpAction(async (ctx, request) => {
	if (!nativeAuthEnabled()) return reply({ code: "NOT_FOUND" }, 404);
	const body = await input(request, enrollmentInput);
	if (!body) return reply({ code: "INVALID_REQUEST" }, 400);
	const digest = await ctx.runAction(internal.sessionActions.refreshDigest, {
		token: body.challenge,
	});
	const account = await ctx.runQuery(internal.sessions.pendingEnrollment, {
		digest,
	});
	if (!account) return reply({ code: "INVALID_CHALLENGE" }, 401);
	const setup = await ctx.runAction(
		internal.sessionActions.prepareAuthenticator,
		{ email: account.email },
	);
	if (!setup) return reply({ code: "AUTH_UNAVAILABLE" }, 503);
	const saved = await ctx.runMutation(internal.sessions.prepareEnrollment, {
		digest,
		encrypted: setup.encrypted,
	});
	return saved
		? reply({ secret: setup.secret, otpauthUri: setup.otpauthUri })
		: reply({ code: "INVALID_CHALLENGE" }, 401);
});

export const enableRequiredAuthenticator = httpAction(async (ctx, request) => {
	if (!nativeAuthEnabled()) return reply({ code: "NOT_FOUND" }, 404);
	const body = await input(request, enrollmentConfirmation);
	if (!body) return reply({ code: "INVALID_REQUEST" }, 400);
	const challenge = await ctx.runAction(internal.sessionActions.refreshDigest, {
		token: body.challenge,
	});
	const account = await ctx.runQuery(internal.sessions.pendingEnrollment, {
		digest: challenge,
	});
	if (!account) return reply({ code: "INVALID_CHALLENGE" }, 401);
	if (!account.pending) return reply({ code: "START_SETUP_FIRST" }, 400);
	const verified = await ctx.runAction(
		internal.sessionActions.verifyEnrollment,
		{ encrypted: account.pending, code: body.code },
	);
	if (verified.type === "unavailable")
		return reply({ code: "AUTH_UNAVAILABLE" }, 503);
	const codes = verified.type === "verified" ? verified.codes : [];
	const result = await ctx.runMutation(internal.sessions.finishEnrollment, {
		challenge,
		encrypted: account.pending,
		step: verified.type === "verified" ? verified.step : null,
		digest: verified.type === "verified" ? verified.digest : "",
		codes: codes.map(({ id, hash }) => ({ id, hash })),
	});
	if (result.type === "closed")
		return reply({ code: "INVALID_CHALLENGE" }, 401);
	if (result.type === "locked")
		return reply({ code: "TOO_MANY_ATTEMPTS" }, 429);
	if (result.type === "invalid" || verified.type !== "verified")
		return reply({ code: "INVALID_CODE" }, 400);
	return signedSession(
		ctx,
		result,
		verified.token,
		codes.map(({ code }) => code),
	);
});

const adminPolicyInput = Schema.Struct({
	policy: Schema.Literals(["optional", "admins", "everyone"]),
});

export const adminTwoFactorPolicy = httpAction(async (ctx, request) => {
	if (!nativeAuthEnabled()) return reply({ code: "NOT_FOUND" }, 404);
	const claims = await authenticatorClaims(ctx);
	if (!claims) return reply({ code: "UNAUTHENTICATED" }, 401);

	if (request.method === "PATCH") {
		const body = await input(request, adminPolicyInput);
		if (!body) return reply({ code: "INVALID_REQUEST" }, 400);
		const result = await ctx.runMutation(internal.sessions.setAdminPolicy, {
			...claims,
			policy: body.policy,
		});
		if (result === "unauthenticated")
			return reply({ code: "UNAUTHENTICATED" }, 401);
		if (result === "forbidden") return reply({ code: "FORBIDDEN" }, 403);
		if (result === "unavailable")
			return reply(
				{
					code: "TWO_FACTOR_UNAVAILABLE",
					message: "Two-factor is not available on this server",
				},
				409,
			);
		if (result === "enroll-first")
			return reply(
				{
					code: "ADMIN_FACTOR_REQUIRED",
					message: "Set up two-factor for your own account first",
				},
				409,
			);
	}

	let covered = 0;
	let total = 0;
	let cursor: string | null = null;
	for (;;) {
		const page: FunctionReturnType<typeof internal.sessions.adminPolicyPage> =
			await ctx.runQuery(internal.sessions.adminPolicyPage, {
				...claims,
				cursor,
			});
		if (page.type === "unauthenticated")
			return reply({ code: "UNAUTHENTICATED" }, 401);
		if (page.type === "forbidden") return reply({ code: "FORBIDDEN" }, 403);
		covered += page.covered;
		total += page.total;
		if (page.next === null)
			return reply({
				policy: page.policy,
				isLocked: false,
				available: { totp: page.totp, passkeys: page.passkeys },
				coverage: { covered, total },
			});
		cursor = page.next;
	}
});

export const adminAccountPost = httpAction(async (ctx, request) => {
	if (!nativeAuthEnabled()) return reply({ code: "NOT_FOUND" }, 404);
	const match =
		/^\/api\/admin\/users\/([^/]{1,128})\/(reset-2fa|approve|reset-password)$/.exec(
			new URL(request.url).pathname,
		);
	if (!match) return reply({ code: "NOT_FOUND" }, 404);
	const claims = await authenticatorClaims(ctx);
	if (!claims) return reply({ code: "UNAUTHENTICATED" }, 401);
	let userId: string;
	try {
		userId = decodeURIComponent(match[1]);
	} catch {
		return reply({ code: "NOT_FOUND" }, 404);
	}
	if (match[2] === "reset-password")
		return adminPasswordReset(ctx, request, claims, userId);
	if (match[2] === "approve") {
		const approved = await ctx.runMutation(internal.sessions.approveAccount, {
			...claims,
			userId,
		});
		if (approved.type === "approved") return reply(approved.user, 201);
		if (approved.type === "not-pending")
			return reply(
				{ code: "USER_NOT_PENDING", message: "User is not pending approval" },
				400,
			);
		return adminAccountFailure(approved.type);
	}
	const result = await ctx.runMutation(internal.sessions.resetAccountFactors, {
		...claims,
		userId,
	});
	if (result === "unauthenticated")
		return reply({ code: "UNAUTHENTICATED" }, 401);
	if (result === "forbidden") return reply({ code: "FORBIDDEN" }, 403);
	if (result === "missing")
		return reply({ code: "USER_NOT_FOUND", message: "User not found" }, 404);
	return reply({ message: "Two-factor reset" });
});

type DirectoryPage = Extract<
	FunctionReturnType<typeof internal.sessions.adminDirectoryPage>,
	{ type: "page" }
>;
type DirectoryClaims = NonNullable<
	Awaited<ReturnType<typeof authenticatorClaims>>
>;

async function directoryCount(
	ctx: ActionCtx,
	claims: DirectoryClaims,
	resource: "accounts" | "notes" | "tags",
	userId?: string,
) {
	let count = 0;
	let cursor: string | null = null;
	for (;;) {
		const page: FunctionReturnType<
			typeof internal.sessions.adminDirectoryCountPage
		> = await ctx.runQuery(internal.sessions.adminDirectoryCountPage, {
			...claims,
			cursor,
			...(userId === undefined ? {} : { userId }),
			resource,
		});
		if (page.type !== "page") return page;
		count += page.count;
		if (page.next === null) return { type: "count", count } as const;
		cursor = page.next;
	}
}

export const adminStats = httpAction(async (ctx) => {
	if (!nativeAuthEnabled()) return reply({ code: "NOT_FOUND" }, 404);
	const claims = await authenticatorClaims(ctx);
	if (!claims) return reply({ code: "UNAUTHENTICATED" }, 401);
	const [users, notes, tags] = await Promise.all([
		directoryCount(ctx, claims, "accounts"),
		directoryCount(ctx, claims, "notes"),
		directoryCount(ctx, claims, "tags"),
	]);
	if (users.type !== "count") return adminAccountFailure(users.type);
	if (notes.type !== "count") return adminAccountFailure(notes.type);
	if (tags.type !== "count") return adminAccountFailure(tags.type);
	return reply({
		totalUsers: users.count,
		totalNotes: notes.count,
		totalTags: tags.count,
	});
});

export const adminDirectory = httpAction(async (ctx, request) => {
	if (!nativeAuthEnabled()) return reply({ code: "NOT_FOUND" }, 404);
	const claims = await authenticatorClaims(ctx);
	if (!claims) return reply({ code: "UNAUTHENTICATED" }, 401);
	const url = new URL(request.url);
	const pendingOnly = url.pathname.endsWith("/pending");
	const numeric = (field: string, fallback: number) => {
		const raw = url.searchParams.get(field);
		return raw ? Number.parseInt(raw, 10) : fallback;
	};
	const skip = pendingOnly ? 0 : numeric("skip", 0);
	const take = pendingOnly ? Number.MAX_SAFE_INTEGER : numeric("take", 50);
	if (
		![skip, take, skip + take].every(Number.isSafeInteger) ||
		skip < 0 ||
		take < 0
	)
		return reply({ code: "INVALID_REQUEST" }, 400);
	const filter = url.searchParams.get("status");
	const status: "active" | "pending" | undefined = pendingOnly
		? "pending"
		: filter === "pending" || filter === "active"
			? filter
			: undefined;
	const search = pendingOnly
		? ""
		: (url.searchParams.get("q") ?? "").trim().toLowerCase();
	const users: DirectoryPage["users"] = [];
	let total = 0;
	let cursor: string | null = null;
	for (;;) {
		const page: FunctionReturnType<
			typeof internal.sessions.adminDirectoryPage
		> = await ctx.runQuery(internal.sessions.adminDirectoryPage, {
			...claims,
			cursor,
			status,
			search,
			pendingOnly,
			skip: Math.max(skip - total, 0),
			take: take - users.length,
		});
		if (page.type === "unauthenticated")
			return reply({ code: "UNAUTHENTICATED" }, 401);
		if (page.type === "forbidden") return reply({ code: "FORBIDDEN" }, 403);
		users.push(...page.users);
		total += page.matched;
		if (page.next === null) break;
		cursor = page.next;
	}
	if (pendingOnly) return reply(users);
	const result = [];
	for (const user of users) {
		const [notes, tags] = await Promise.all([
			directoryCount(ctx, claims, "notes", user.id),
			directoryCount(ctx, claims, "tags", user.id),
		]);
		if (notes.type === "unauthenticated" || tags.type === "unauthenticated")
			return reply({ code: "UNAUTHENTICATED" }, 401);
		if (notes.type !== "count" || tags.type !== "count")
			return reply({ code: "FORBIDDEN" }, 403);
		result.push({ ...user, _count: { notes: notes.count, tags: tags.count } });
	}
	return reply({ users: result, total, skip, take });
});

const adminAccountPatchInput = Schema.Struct({
	email: Schema.optionalKey(
		Schema.String.check(
			Schema.isBetweenLength(3, 254),
			Schema.isPattern(/^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$/),
		),
	),
	name: Schema.optionalKey(Schema.Trim.check(Schema.isBetweenLength(1, 100))),
	isAdmin: Schema.optionalKey(Schema.Boolean),
});

function adminAccountFailure(
	type: "unauthenticated" | "forbidden" | "missing",
) {
	if (type === "unauthenticated")
		return reply({ code: "UNAUTHENTICATED" }, 401);
	if (type === "forbidden") return reply({ code: "FORBIDDEN" }, 403);
	return reply({ code: "USER_NOT_FOUND", message: "User not found" }, 404);
}

export const adminAccountDelete = httpAction(async (ctx, request) => {
	if (!nativeAuthEnabled()) return reply({ code: "NOT_FOUND" }, 404);
	const match = /^\/api\/admin\/users\/([^/]{1,128})$/.exec(
		new URL(request.url).pathname,
	);
	if (!match) return reply({ code: "NOT_FOUND" }, 404);
	const claims = await authenticatorClaims(ctx);
	if (!claims) return reply({ code: "UNAUTHENTICATED" }, 401);
	let userId: string;
	try {
		userId = decodeURIComponent(match[1]);
	} catch {
		return reply({ code: "NOT_FOUND" }, 404);
	}
	const result = await ctx.runMutation(internal.sessions.deleteAccount, {
		...claims,
		target: { type: "admin", userId },
	});
	if (result === "deleted")
		return reply({ message: "User deleted successfully" });
	if (result === "last-admin")
		return reply(
			{ code: "LAST_ADMIN", message: "Cannot delete the last admin user" },
			400,
		);
	if (result === "invalid-password")
		return reply({ code: "INVALID_PASSWORD" }, 403);
	return adminAccountFailure(result);
});

export const adminAccountPatch = httpAction(async (ctx, request) => {
	if (!nativeAuthEnabled()) return reply({ code: "NOT_FOUND" }, 404);
	const match = /^\/api\/admin\/users\/([^/]{1,128})$/.exec(
		new URL(request.url).pathname,
	);
	if (!match) return reply({ code: "NOT_FOUND" }, 404);
	const claims = await authenticatorClaims(ctx);
	if (!claims) return reply({ code: "UNAUTHENTICATED" }, 401);
	let userId: string;
	try {
		userId = decodeURIComponent(match[1]);
	} catch {
		return reply({ code: "NOT_FOUND" }, 404);
	}
	const patch = await input(request, adminAccountPatchInput, true);
	if (!patch) return reply({ code: "INVALID_REQUEST" }, 400);
	const result = await ctx.runMutation(internal.sessions.updateAdminAccount, {
		...claims,
		userId,
		patch,
	});
	if (result.type === "updated") return reply(result.user);
	if (result.type === "self-demotion")
		return reply(
			{ code: "SELF_DEMOTION", message: "Cannot change your own admin status" },
			400,
		);
	if (result.type === "email-conflict")
		return reply(
			{ code: "EMAIL_CONFLICT", message: "Email already in use" },
			409,
		);
	return adminAccountFailure(result.type);
});

const adminPasswordInput = Schema.Struct({
	newPassword: Schema.optionalKey(
		Schema.String.check(Schema.isBetweenLength(8, 72)),
	),
});

async function adminPasswordReset(
	ctx: ActionCtx,
	request: Request,
	claims: DirectoryClaims,
	userId: string,
) {
	const args = { ...claims, userId };
	const target = await ctx.runQuery(
		internal.sessions.canResetAccountPassword,
		args,
	);
	if (target !== "account") return adminAccountFailure(target);
	const body = await input(request, adminPasswordInput, true);
	if (
		!body ||
		(body.newPassword !== undefined &&
			new TextEncoder().encode(body.newPassword).length > 72)
	)
		return reply(
			{
				code: "INVALID_REQUEST",
				message:
					"Enter a password of at least eight characters and at most 72 bytes.",
			},
			400,
		);
	const prepared = await ctx.runAction(
		internal.sessionActions.preparePasswordReset,
		{ password: body.newPassword },
	);
	const result = await ctx.runMutation(internal.sessions.resetAccountPassword, {
		...args,
		hash: prepared.hash,
	});
	if (result !== "reset") return adminAccountFailure(result);
	return prepared.generated === null
		? reply({ message: "Password reset successfully" }, 201)
		: reply(
				{
					newPassword: prepared.generated,
					message: "Password reset successfully. New password generated.",
				},
				201,
			);
}

const registrationInput = Schema.Struct({
	email: Schema.String.check(
		Schema.isBetweenLength(3, 254),
		Schema.isPattern(/^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$/),
	),
	name: Schema.Trim.check(Schema.isBetweenLength(1, 100)),
	password: Schema.String.check(Schema.isBetweenLength(8, 72)),
});

export const adminAccountCreate = httpAction(async (ctx, request) => {
	if (!nativeAuthEnabled()) return reply({ code: "NOT_FOUND" }, 404);
	const claims = await authenticatorClaims(ctx);
	if (!claims) return reply({ code: "UNAUTHENTICATED" }, 401);
	const admin = await ctx.runQuery(internal.sessions.me, claims);
	if (!admin) return adminAccountFailure("unauthenticated");
	if (!admin.isAdmin) return adminAccountFailure("forbidden");
	const body = await input(request, registrationInput, true);
	if (!body || new TextEncoder().encode(body.password).length > 72)
		return reply(
			{
				code: "INVALID_REQUEST",
				message: "Check the name, email address and password.",
			},
			400,
		);
	const { hash } = await ctx.runAction(
		internal.sessionActions.preparePasswordReset,
		{ password: body.password },
	);
	const result = await ctx.runMutation(internal.sessions.createAdminManagedAccount, {
		...claims,
		id: crypto.randomUUID(),
		email: body.email,
		name: body.name,
		hash,
	});
	if (result.type === "created") return reply(result.user, 201);
	if (result.type === "duplicate")
		return reply(
			{ code: "EMAIL_CONFLICT", message: "User already exists" },
			409,
		);
	return adminAccountFailure(result.type);
});

const registrationModeInput = Schema.Struct({
	mode: Schema.Literals(["enabled", "review", "disabled"]),
});

export const capabilities = httpAction(async (ctx) =>
	reply(await ctx.runQuery(internal.sessions.publicCapabilities)),
);

export const registrationMode = httpAction(async (ctx) => {
	if (!nativeAuthEnabled()) return reply({ code: "NOT_FOUND" }, 404);
	const mode = await ctx.runQuery(internal.sessions.publicRegistrationMode);
	return mode ? reply({ mode }) : reply({ code: "AUTH_UNAVAILABLE" }, 503);
});

export const adminSignupSettings = httpAction(async (ctx, request) => {
	if (!nativeAuthEnabled()) return reply({ code: "NOT_FOUND" }, 404);
	const claims = await authenticatorClaims(ctx);
	if (!claims) return reply({ code: "UNAUTHENTICATED" }, 401);
	if (request.method === "PATCH") {
		const body = await input(request, registrationModeInput, true);
		if (!body) return reply({ code: "INVALID_REQUEST" }, 400);
		const result = await ctx.runMutation(
			internal.sessions.updateRegistrationSettings,
			{ ...claims, mode: body.mode },
		);
		if (result.type === "settings") return reply(result.settings);
		if (result.type === "locked")
			return reply(
				{
					code: "REGISTRATION_MODE_LOCKED",
					message:
						"Registration mode is locked by USER_SIGNUP environment variable",
				},
				403,
			);
		return adminAccountFailure(result.type);
	}
	const result = await ctx.runQuery(
		internal.sessions.adminRegistrationSettings,
		claims,
	);
	return result.type === "settings"
		? reply(result.settings)
		: adminAccountFailure(result.type);
});

export const register = httpAction(async (ctx, request) => {
	if (!nativeAuthEnabled()) return reply({ code: "NOT_FOUND" }, 404);
	const body = await input(request, registrationInput);
	if (!body || new TextEncoder().encode(body.password).length > 72)
		return reply(
			{
				code: "INVALID_REQUEST",
				message: "Check the name, email address and password.",
			},
			400,
		);
	const mode = await ctx.runQuery(internal.sessions.publicRegistrationMode);
	if (!mode) return reply({ code: "AUTH_UNAVAILABLE" }, 503);
	if (
		mode === "disabled" ||
		process.env.DISABLE_INTERNAL_AUTH?.toLowerCase() === "true"
	)
		return reply(
			{ code: "REGISTRATION_DISABLED", message: "Registration is disabled" },
			403,
		);
	const attempt = await ctx.runMutation(internal.sessions.attempt, {
		email: "",
	});
	if (attempt.type === "disabled" || attempt.type === "local-disabled")
		return reply({ code: "AUTH_UNAVAILABLE" }, 503);
	if (attempt.type === "rate-limit")
		return reply({ code: "TOO_MANY_ATTEMPTS" }, 429);
	const credentials = await ctx.runAction(
		internal.sessionActions.prepareRegistration,
		{ password: body.password },
	);
	if (!credentials) return reply({ code: "AUTH_UNAVAILABLE" }, 503);
	const result = await ctx.runMutation(
		internal.sessions.createRegisteredAccount,
		{
			id: credentials.id,
			hash: credentials.hash,
			digest: credentials.digest,
			email: body.email,
			name: body.name,
		},
	);
	if (result.type === "unavailable")
		return reply({ code: "AUTH_UNAVAILABLE" }, 503);
	if (result.type === "disabled")
		return reply(
			{ code: "REGISTRATION_DISABLED", message: "Registration is disabled" },
			403,
		);
	if (result.type === "duplicate")
		return reply(
			{ code: "EMAIL_CONFLICT", message: "User already exists" },
			409,
		);
	if (result.type === "pending")
		return reply(
			{
				user: result.user,
				message: "Registration successful. Your account is pending approval.",
			},
			201,
		);
	if (result.type === "enroll")
		return reply(
			{
				user: result.user,
				twoFactorSetupRequired: true,
				challenge: credentials.token,
				methods: result.methods,
			},
			201,
		);
	return signedSession(ctx, result, credentials.token, undefined, 201);
});
