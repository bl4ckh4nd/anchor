"use node";

import * as oidc from "openid-client";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";

const provider = {
	issuerUrl: v.string(),
	clientId: v.string(),
	clientSecret: v.string(),
	callbackUrl: v.string(),
};

const publicClientAuth: oidc.ClientAuth = (_, client, body) => {
	body.set("client_id", client.client_id);
	body.set("client_secret", "");
};

async function discover({
	issuerUrl,
	clientId,
	clientSecret,
	callbackUrl,
}: {
	issuerUrl: string;
	clientId: string;
	clientSecret: string;
	callbackUrl: string;
}) {
	const config = await oidc.discovery(
		new URL(issuerUrl),
		clientId,
		{
			redirect_uris: [callbackUrl],
			response_types: ["code"],
		},
		clientSecret ? oidc.ClientSecretPost(clientSecret) : publicClientAuth,
		{
			execute: [oidc.enableNonRepudiationChecks],
		},
	);
	config.timeout = 10;
	return config;
}

function verifiedIdentity(claims: {
	sub?: unknown;
	email?: unknown;
	email_verified?: unknown;
	name?: unknown;
}) {
	const { sub: subject, email } = claims;
	if (
		typeof subject !== "string" ||
		!subject.trim() ||
		subject.length > 255 ||
		claims.email_verified !== true ||
		typeof email !== "string" ||
		email.length > 254 ||
		!/^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$/.test(email)
	)
		return null;
	const name = typeof claims.name === "string" ? claims.name.trim() : "";
	return { subject, email, name: (name || email.split("@")[0]).slice(0, 100) };
}

export const prepare = internalAction({
	args: provider,
	handler: async (_, args) => {
		const config = await discover(args);
		const state = oidc.randomState();
		const nonce = oidc.randomNonce();
		const verifier = oidc.randomPKCECodeVerifier();
		const url = oidc.buildAuthorizationUrl(config, {
			redirect_uri: args.callbackUrl,
			response_type: "code",
			scope: "openid email profile",
			state,
			nonce,
			code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
			code_challenge_method: "S256",
		});
		return { url: url.href, state, nonce, verifier };
	},
});

export const authenticate = internalAction({
	args: {
		...provider,
		url: v.string(),
		state: v.string(),
		nonce: v.string(),
		verifier: v.string(),
	},
	handler: async (_, args) => {
		const config = await discover(args);
		const result = await oidc.authorizationCodeGrant(
			config,
			new URL(args.url),
			{
				expectedState: args.state,
				expectedNonce: args.nonce,
				pkceCodeVerifier: args.verifier,
			},
		);
		const claims = result.claims();
		if (!claims?.sub || claims.sub.length > 255) return null;
		const info =
			claims.email_verified !== true &&
			config.serverMetadata().userinfo_endpoint
				? await oidc.fetchUserInfo(config, result.access_token, claims.sub)
				: null;
		return verifiedIdentity(info?.email_verified === true ? info : claims);
	},
});

export const authenticateLegacyMobile = internalAction({
	args: { ...provider, accessToken: v.string() },
	handler: async (_, args) => {
		const config = await discover(args);
		const metadata = config.serverMetadata();
		if (!metadata.introspection_endpoint || !metadata.userinfo_endpoint)
			return null;
		const token = await oidc.tokenIntrospection(config, args.accessToken, {
			token_type_hint: "access_token",
		});
		if (
			token.active !== true ||
			token.client_id !== args.clientId ||
			(typeof token.iss === "string" && token.iss !== metadata.issuer) ||
			typeof token.sub !== "string" ||
			!token.sub.trim() ||
			token.sub.length > 255
		)
			return null;
		const info = await oidc.fetchUserInfo(config, args.accessToken, token.sub);
		return verifiedIdentity(info);
	},
});
