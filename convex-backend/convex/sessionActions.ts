"use node";

import {
	createCipheriv,
	createDecipheriv,
	createHash,
	createHmac,
	createPrivateKey,
	hkdfSync,
	randomBytes,
	randomUUID,
	sign,
} from "node:crypto";
import bcrypt from "bcryptjs";
import { v } from "convex/values";
import {
	generateRecoveryCodes,
	normalizeRecoveryCode,
} from "../../server/src/auth/two-factor/recovery-codes.util";
import {
	base32Decode,
	base32Encode,
	buildOtpauthUri,
	generateTotpSecret,
	verifyTotp,
} from "../../server/src/auth/two-factor/totp.util";
import { internalAction } from "./_generated/server";

const dummyHash =
	"$2b$10$NbNssu/3q62iP5IQjRwimuHYk//tGwgWgYWq4Fzk9oxmX0zGNVJ2u";
const digest = (token: string) =>
	createHash("sha256").update(token).digest("hex");

function config() {
	const pem = process.env.ANCHOR_CONVEX_SIGNING_KEY;
	const secret = process.env.ANCHOR_SESSION_SECRET;
	if (!pem || !secret || !/^[0-9a-f]{64}$/i.test(secret)) return null;
	return {
		signingKey: createPrivateKey(pem),
		keyId: process.env.ANCHOR_CONVEX_SIGNING_KEY_ID || "anchor-convex",
		secret: Buffer.from(secret, "hex"),
	};
}

function accessToken(
	signingKey: ReturnType<typeof createPrivateKey>,
	keyId: string,
	issuer: string,
	subject: string,
	sessionId: string,
) {
	const encode = (data: object) =>
		Buffer.from(JSON.stringify(data)).toString("base64url");
	const now = Math.floor(Date.now() / 1000);
	const claims =
		encode({ alg: "RS256", typ: "JWT", kid: keyId }) +
		"." +
		encode({
			iss: issuer,
			aud: "anchor",
			sub: subject,
			anchorSession: sessionId,
			iat: now,
			exp: now + 15 * 60,
		});
	return (
		claims +
		"." +
		sign("RSA-SHA256", Buffer.from(claims), signingKey).toString("base64url")
	);
}

export const verifyPassword = internalAction({
	args: { password: v.string(), passwordHash: v.union(v.string(), v.null()) },
	handler: async (_, { password, passwordHash }) => {
		if (!config()) return { type: "disabled" } as const;
		if (
			!(await bcrypt.compare(password, passwordHash ?? dummyHash)) ||
			!passwordHash
		)
			return { type: "invalid" } as const;
		const token = randomBytes(64).toString("hex");
		return { type: "verified", token, digest: digest(token) } as const;
	},
});

export const deriveRefresh = internalAction({
	args: { token: v.string() },
	handler: (_, { token }) => {
		const settings = config();
		if (!settings) return null;
		const next = createHmac("sha512", settings.secret)
			.update(token)
			.digest("hex");
		return { digest: digest(token), nextDigest: digest(next), next };
	},
});

export const prepareSession = internalAction({
	args: {},
	handler: () => {
		if (!config()) return null;
		const token = randomBytes(64).toString("hex");
		return { token, digest: digest(token) };
	},
});

export const signAccess = internalAction({
	args: { issuer: v.string(), userId: v.string(), sessionId: v.id("sessions") },
	handler: (_, { issuer, userId, sessionId }) => {
		const settings = config();
		return settings
			? accessToken(
					settings.signingKey,
					settings.keyId,
					issuer,
					userId,
					sessionId,
				)
			: null;
	},
});

export const refreshDigest = internalAction({
	args: { token: v.string() },
	handler: (_, { token }) => digest(token),
});

export const verifyFactor = internalAction({
	args: {
		secret: v.string(),
		code: v.optional(v.string()),
		recoveryCode: v.optional(v.string()),
	},
	handler: (_, { secret, code, recoveryCode }) => {
		const key = authenticatorKeys();
		if (!config() || !key) return null;
		let proof: { step: number } | { recoveryHash: string } | null = null;
		if (code !== undefined) {
			const step = authenticatorStep(key("encrypt"), secret, code);
			if (step === undefined) return null;
			if (step !== null) proof = { step };
		} else if (recoveryCode !== undefined) {
			const normalized = normalizeRecoveryCode(recoveryCode);
			if (normalized)
				proof = {
					recoveryHash: createHmac("sha256", key("mac"))
						.update(normalized)
						.digest("hex"),
				};
		}
		const token = randomBytes(64).toString("hex");
		return { proof, token, refreshDigest: digest(token) };
	},
});

function authenticatorKeys() {
	const configured = process.env.TOTP_ENCRYPTION_KEY;
	const master = configured && Buffer.from(configured, "base64");
	return master && master.length === 32
		? (name: string) =>
				Buffer.from(hkdfSync("sha256", master, "", "anchor/2fa/" + name, 32))
		: null;
}

function authenticatorStep(key: Buffer, secret: string, code: string) {
	const [version, iv, tag, data, extra] = secret.split(".");
	if (version !== "v1" || !iv || !tag || !data || extra !== undefined)
		return undefined;
	try {
		const decipher = createDecipheriv(
			"aes-256-gcm",
			key,
			Buffer.from(iv, "base64url"),
		);
		decipher.setAuthTag(Buffer.from(tag, "base64url"));
		const decoded = Buffer.concat([
			decipher.update(Buffer.from(data, "base64url")),
			decipher.final(),
		]);
		return verifyTotp(base32Decode(decoded.toString("utf8")), code);
	} catch {
		return undefined;
	}
}

export const prepareAuthenticator = internalAction({
	args: { email: v.string() },
	handler: (_, { email }) => {
		const key = authenticatorKeys();
		if (!key) return null;
		const secret = base32Encode(generateTotpSecret());
		const iv = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", key("encrypt"), iv);
		const encrypted = Buffer.concat([
			cipher.update(secret, "utf8"),
			cipher.final(),
		]);
		return {
			encrypted: [
				"v1",
				...[iv, cipher.getAuthTag(), encrypted].map((value) =>
					value.toString("base64url"),
				),
			].join("."),
			secret,
			otpauthUri: buildOtpauthUri({ secret, account: email, issuer: "Anchor" }),
		};
	},
});

export const verifyEnrollment = internalAction({
	args: { encrypted: v.string(), code: v.string() },
	handler: (_, { encrypted, code }) => {
		const key = authenticatorKeys();
		if (!key || !config()) return { type: "unavailable" } as const;
		const step = authenticatorStep(key("encrypt"), encrypted, code);
		if (step === undefined) return { type: "unavailable" } as const;
		if (step === null) return { type: "invalid" } as const;
		const token = randomBytes(64).toString("hex");
		const codes = newRecoveryCodes(key("mac"));
		return {
			type: "verified",
			step,
			token,
			digest: digest(token),
			codes,
		} as const;
	},
});

function newRecoveryCodes(macKey: Buffer) {
	return generateRecoveryCodes().map((code) => ({
		code,
		id: randomBytes(16).toString("hex"),
		hash: createHmac("sha256", macKey)
			.update(normalizeRecoveryCode(code)!)
			.digest("hex"),
	}));
}

export const rotateRecoveryCodes = internalAction({
	args: {},
	handler: () => {
		const key = authenticatorKeys();
		return key ? newRecoveryCodes(key("mac")) : null;
	},
});

export const preparePasswordReset = internalAction({
	args: { password: v.optional(v.string()) },
	handler: async (_, { password }) => {
		const value = password ?? randomBytes(18).toString("base64url");
		return {
			hash: await bcrypt.hash(value, 10),
			generated: password === undefined ? value : null,
		};
	},
});

export const preparePasswordChange = internalAction({
	args: {
		currentPassword: v.string(),
		newPassword: v.string(),
		passwordHash: v.string(),
	},
	handler: async (_, { currentPassword, newPassword, passwordHash }) => {
		if (!(await bcrypt.compare(currentPassword, passwordHash)))
			return { type: "invalid" } as const;
		if (await bcrypt.compare(newPassword, passwordHash))
			return { type: "unchanged" } as const;
		return {
			type: "ready",
			replacement: await bcrypt.hash(newPassword, 10),
		} as const;
	},
});

export const prepareRegistration = internalAction({
	args: { password: v.string() },
	handler: async (_, { password }) => {
		if (!config()) return null;
		const token = randomBytes(64).toString("hex");
		return {
			id: randomUUID(),
			hash: await bcrypt.hash(password, 10),
			token,
			digest: digest(token),
		};
	},
});
