import { Schema } from "effect";
import { internal } from "./_generated/api";
import { httpAction, type ActionCtx } from "./_generated/server";
import type { PasskeyFlow } from "./passkeys";
import {
	authenticatorClaims,
	input,
	reply,
	signedSession,
} from "./sessionHttp";

const nameInput = Schema.String.check(Schema.isBetweenLength(1, 60));
const challengeInput = Schema.String.check(
	Schema.isPattern(/^[a-zA-Z0-9_-]{32,128}$/),
);
const proofFields = {
	challenge: challengeInput,
	response: Schema.Record(Schema.String, Schema.Unknown),
};
const enrollmentInput = Schema.Struct({ challenge: challengeInput });
const verificationInput = Schema.Struct({
	...proofFields,
	name: Schema.optionalKey(nameInput),
});
const renameInput = Schema.Struct({ name: nameInput });
const invalid = () => reply({ code: "INVALID_REQUEST" }, 400);
const expired = () =>
	reply({ code: "INVALID_CHALLENGE", message: "Challenge expired" }, 401);

function unavailable() {
	return reply(
		{
			code: "PASSKEYS_UNAVAILABLE",
			message: "Passkeys are not available on this server",
		},
		403,
	);
}

async function options(ctx: ActionCtx, binding: PasskeyFlow) {
	const account =
		binding.type === "login"
			? null
			: await ctx.runQuery(internal.passkeys.registrationOptionsAccount, {
					binding,
				});
	if (account?.type === "closed") return expired();
	if (account?.type === "limit") return reply({ code: "PASSKEY_LIMIT" }, 409);
	const created = await ctx.runAction(internal.passkeyActions.options, {
		account: account?.user,
		excluded: account?.excluded ?? [],
	});
	if (!created) return unavailable();
	const challenge = created.options.challenge;
	const result = await ctx.runMutation(internal.passkeys.saveChallenge, {
		binding,
		challenge,
		origin: created.origin,
	});
	if (result === "closed") return expired();
	if (result === "limit") return reply({ code: "TOO_MANY_ATTEMPTS" }, 429);
	if (result !== "saved") return unavailable();
	return reply(
		binding.type === "enroll"
			? { options: created.options }
			: { options: created.options, challenge },
	);
}

async function verify(
	ctx: ActionCtx,
	binding: PasskeyFlow,
	{ challenge: key, response, name }: typeof verificationInput.Type,
) {
	const id = response.id;
	if (typeof id !== "string" || id.length === 0 || id.length > 2048)
		return invalid();
	const consumed = await ctx.runMutation(internal.passkeys.consumeChallenge, {
		binding,
		key,
		credentialId: id,
	});
	if (!consumed) return expired();
	const { origin, rpID, challenge } = consumed;
	const credential =
		consumed.type === "login" ? consumed.credential : undefined;
	const proof = await ctx.runAction(internal.passkeyActions.verify, {
		response,
		origin,
		rpID,
		challenge,
		credential: credential && {
			id: credential.id,
			publicKey: credential.publicKey,
			counter: credential.counter,
		},
	});
	if (binding.type === "login" && consumed.type === "login") {
		const failed = () =>
			reply(
				{ code: "INVALID_PASSKEY", message: "Passkey sign-in failed" },
				401,
			);
		if (proof?.type !== "login") return failed();
		const fresh = await ctx.runAction(
			internal.sessionActions.prepareSession,
			{},
		);
		if (!fresh) return reply({ code: "AUTH_UNAVAILABLE" }, 503);
		const result = await ctx.runMutation(internal.passkeys.finishLogin, {
			origin,
			keyId: consumed.credential.keyId,
			factorResetVersion: consumed.factorResetVersion,
			newCounter: proof.newCounter,
			backedUp: proof.backedUp,
			refreshDigest: fresh.digest,
		});
		return result ? signedSession(ctx, result, fresh.token) : failed();
	}
	if (binding.type === "login" || proof?.type !== "register")
		return reply(
			{ code: "INVALID_PASSKEY", message: "Passkey could not be verified" },
			400,
		);
	const fresh =
		binding.type === "enroll"
			? await ctx.runAction(internal.sessionActions.prepareSession, {})
			: null;
	if (binding.type === "enroll" && !fresh)
		return reply({ code: "AUTH_UNAVAILABLE" }, 503);
	const result = await ctx.runMutation(internal.passkeys.saveRegistration, {
		binding,
		origin,
		name: name?.trim() || "Passkey",
		id: proof.id,
		proof: proof.proof,
		refreshDigest: fresh?.digest,
	});
	switch (result.type) {
		case "closed":
			return expired();
		case "duplicate":
			return reply({ code: "PASSKEY_EXISTS" }, 409);
		case "limit":
			return reply({ code: "PASSKEY_LIMIT" }, 409);
		case "passkey":
			return reply({ passkey: result.passkey });
		case "session":
			return signedSession(ctx, result, fresh!.token);
	}
}

export const ceremony = httpAction(async (ctx, request) => {
	const path = new URL(request.url).pathname;
	const operation = path.endsWith("/options") ? "options" : "verify";
	const registration = path.startsWith("/api/auth/passkeys/register/");
	const enrollment = path.startsWith("/api/auth/enroll/passkey/");
	const claims = registration ? await authenticatorClaims(ctx) : null;
	if (registration && !claims) return reply({ code: "UNAUTHENTICATED" }, 401);
	if (!(await ctx.runQuery(internal.sessions.publicCapabilities)).passkeys)
		return unavailable();
	let binding: PasskeyFlow = claims
		? { type: "register", ...claims }
		: { type: "login" };
	const body =
		operation === "verify"
			? await input(request, verificationInput, true, 128 * 1024)
			: null;
	if (operation === "verify" && (!body || (registration && !body.name?.trim())))
		return invalid();
	if (enrollment) {
		const challenge =
			body?.challenge ??
			(await input(request, enrollmentInput, true))?.challenge;
		if (!challenge || !/^[0-9a-f]{128}$/.test(challenge)) return invalid();
		const digest = await ctx.runAction(internal.sessionActions.refreshDigest, {
			token: challenge,
		});
		binding = { type: "enroll", digest };
	}
	return body ? verify(ctx, binding, body) : options(ctx, binding);
});

export const manage = httpAction(async (ctx, request) => {
	const claims = await authenticatorClaims(ctx);
	if (!claims) return reply({ code: "UNAUTHENTICATED" }, 401);
	const id = new URL(request.url).pathname.slice("/api/auth/passkeys/".length);
	if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id))
		return reply({ code: "PASSKEY_NOT_FOUND" }, 404);
	const name =
		request.method === "PATCH"
			? (await input(request, renameInput, true))?.name.trim()
			: undefined;
	if (request.method === "PATCH" && !name) return invalid();
	const result = await ctx.runMutation(internal.passkeys.manage, {
		...claims,
		id,
		name,
	});
	switch (result.type) {
		case "unauthenticated":
			return reply({ code: "UNAUTHENTICATED" }, 401);
		case "missing":
			return reply({ code: "PASSKEY_NOT_FOUND" }, 404);
		case "required":
			return reply(
				{
					code: "TWO_FACTOR_REQUIRED",
					message: "Two-factor is required by your admin",
				},
				403,
			);
		case "removed":
			return reply({ message: "Passkey removed" });
		case "passkey":
			return reply({ passkey: result.passkey });
	}
});
