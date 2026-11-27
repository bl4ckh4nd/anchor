import type { AuthConfig } from "convex/server";

const issuer = process.env.ANCHOR_AUTH_ISSUER;
const jwks = process.env.ANCHOR_AUTH_JWKS;

if (Boolean(issuer) !== Boolean(jwks)) {
	throw new Error("Configure both ANCHOR_AUTH_ISSUER and ANCHOR_AUTH_JWKS.");
}

export default {
	providers:
		issuer && jwks
			? [
					{
						type: "customJwt",
						issuer,
						jwks,
						algorithm: "RS256",
						applicationID: "anchor",
					},
				]
			: [],
} satisfies AuthConfig;
