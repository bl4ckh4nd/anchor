"use node";

import { randomUUID } from "node:crypto";
import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
	type AuthenticationResponseJSON,
	type AuthenticatorTransport,
	type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { passkeyRelyingParty } from "./passkeyConfig";

export const options = internalAction({
	args: {
		account: v.optional(
			v.object({
				id: v.string(),
				email: v.string(),
				name: v.string(),
			}),
		),
		excluded: v.array(
			v.object({ credentialId: v.string(), transports: v.array(v.string()) }),
		),
	},
	handler: async (_, { account, excluded }) => {
		const rp = passkeyRelyingParty();
		if (!rp) return null;
		if (!account)
			return {
				origin: rp.origin,
				options: await generateAuthenticationOptions({
					rpID: rp.rpID,
					userVerification: "required",
				}),
			};
		return {
			origin: rp.origin,
			options: await generateRegistrationOptions({
				rpName: "Anchor",
				rpID: rp.rpID,
				userName: account.email,
				userDisplayName: account.name,
				userID: new TextEncoder().encode(account.id),
				attestationType: "none",
				excludeCredentials: excluded.map(({ credentialId, transports }) => ({
					id: credentialId,
					transports: transports as AuthenticatorTransport[],
				})),
				authenticatorSelection: {
					residentKey: "required",
					userVerification: "required",
				},
			}),
		};
	},
});

export const verify = internalAction({
	args: {
		response: v.any(),
		origin: v.string(),
		rpID: v.string(),
		challenge: v.string(),
		credential: v.optional(
			v.object({ id: v.string(), publicKey: v.string(), counter: v.string() }),
		),
	},
	handler: async (_, { response, origin, rpID, challenge, credential }) => {
		const expected = {
			expectedOrigin: origin,
			expectedRPID: rpID,
			expectedChallenge: challenge,
			requireUserVerification: true,
		};
		try {
			if (credential) {
				const counter = Number(credential.counter);
				if (!Number.isSafeInteger(counter) || counter < 0) return null;
				const result = await verifyAuthenticationResponse({
					...expected,
					response: response as AuthenticationResponseJSON,
					credential: {
						id: credential.id,
						publicKey: new Uint8Array(
							Buffer.from(credential.publicKey, "base64"),
						),
						counter,
					},
				});
				return result.verified
					? ({
							type: "login",
							newCounter: result.authenticationInfo.newCounter,
							backedUp: result.authenticationInfo.credentialBackedUp,
						} as const)
					: null;
			}
			const result = await verifyRegistrationResponse({
				...expected,
				response: response as RegistrationResponseJSON,
			});
			if (!result.verified) return null;
			const {
				credential: registered,
				credentialBackedUp,
				credentialDeviceType,
			} = result.registrationInfo;
			return {
				type: "register",
				id: randomUUID(),
				proof: {
					credentialId: registered.id,
					publicKey: Buffer.from(registered.publicKey).toString("base64"),
					counter: String(registered.counter),
					transports: registered.transports ?? [],
					backedUp: credentialBackedUp,
					deviceType: credentialDeviceType,
				},
			} as const;
		} catch {
			return null;
		}
	},
});
