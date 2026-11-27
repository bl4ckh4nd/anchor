import { v } from "convex/values";
import { internal } from "./_generated/api";
import { httpAction, internalQuery } from "./_generated/server";
import { authorizedIdentity, nativeAuthEnabled } from "./sessions";

export const profilePathPrefix = "/uploads/profiles/";
export const profileStorageContentType = "application/vnd.anchor.profile";

export const findImage = internalQuery({
	args: { path: v.string() },
	handler: (ctx, { path }) =>
		ctx.db
			.query("profileImages")
			.withIndex("by_path", (q) => q.eq("path", path))
			.unique(),
});

export const downloadProfileImage = httpAction(async (ctx, request) => {
	const path = new URL(request.url).pathname;
	let filename: string;
	try {
		filename = decodeURIComponent(path.slice(profilePathPrefix.length));
	} catch {
		return new Response(null, { status: 404 });
	}
	if (!filename || filename.includes("/") || filename.includes("\\")) {
		return new Response(null, { status: 404 });
	}
	const image = await ctx.runQuery(internal.profiles.findImage, {
		path: profilePathPrefix + filename,
	});
	const file = image && (await ctx.storage.get(image.storageId));
	if (!image || !file) return new Response(null, { status: 404 });
	return new Response(file.stream(), {
		headers: {
			"Cache-Control": "private, max-age=31536000, immutable",
			"Content-Type": image.mimeType,
			"Content-Length": String(image.fileSize),
			"X-Content-Type-Options": "nosniff",
		},
	});
});

const maxImageBytes = 5 * 1024 * 1024;
const maxFormBytes = maxImageBytes + 16 * 1024;

function matches(bytes: Uint8Array, signature: readonly number[], offset = 0) {
	return signature.every((byte, index) => bytes[offset + index] === byte);
}

async function readPicture(request: Request) {
	const contentType = request.headers.get("content-type") ?? "";
	if (!/^multipart\/form-data\s*;/i.test(contentType) || !request.body)
		return null;
	const reader = request.body.getReader();
	const chunks: ArrayBuffer[] = [];
	let length = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.byteLength;
			if (length > maxFormBytes) return null;
			chunks.push(new Uint8Array(value).buffer);
		}
		const data = await new Response(new Blob(chunks), {
			headers: { "Content-Type": contentType },
		}).formData();
		const entries = [...data.entries()];
		if (entries.length !== 1 || entries[0][0] !== "image") return null;
		const image = entries[0][1];
		if (
			typeof image === "string" ||
			image.size === 0 ||
			image.size > maxImageBytes
		)
			return null;
		return image;
	} catch {
		return null;
	} finally {
		await reader.cancel();
	}
}

async function pictureType(image: Blob) {
	const bytes = new Uint8Array(await image.slice(0, 12).arrayBuffer());
	const permits = (mimeType: string) =>
		image.type === mimeType || image.type === "application/octet-stream";
	if (
		permits("image/png") &&
		matches(bytes, [137, 80, 78, 71, 13, 10, 26, 10])
	)
		return { mimeType: "image/png", extension: "png" } as const;
	if (permits("image/jpeg") && matches(bytes, [255, 216, 255]))
		return { mimeType: "image/jpeg", extension: "jpg" } as const;
	if (
		permits("image/webp") &&
		matches(bytes, [82, 73, 70, 70]) &&
		matches(bytes, [87, 69, 66, 80], 8)
	)
		return { mimeType: "image/webp", extension: "webp" } as const;
	return null;
}

function reply(body: unknown, status: number) {
	return Response.json(body, {
		status,
		headers: { "Cache-Control": "no-store" },
	});
}

export const updateProfileImage = httpAction(async (ctx, request) => {
	if (!nativeAuthEnabled()) return reply({ code: "NOT_FOUND" }, 404);
	const identity = await authorizedIdentity(ctx);
	if (!identity || typeof identity.anchorSession !== "string")
		return reply({ code: "UNAUTHENTICATED" }, 401);
	const claims = {
		issuer: identity.issuer,
		subject: identity.subject,
		sessionId: identity.anchorSession,
	};
	let image = null;
	if (request.method === "POST") {
		const file = await readPicture(request);
		const format = file && (await pictureType(file));
		if (!file || !format)
			return reply(
				{
					code: "INVALID_PROFILE_IMAGE",
					message: "Pick a JPG, PNG or WebP up to 5 MB.",
				},
				400,
			);
		image = {
			path: profilePathPrefix + crypto.randomUUID() + "." + format.extension,
			mimeType: format.mimeType,
			storageId: await ctx.storage.store(
				file.slice(0, file.size, profileStorageContentType),
			),
		};
	}
	const result = await ctx.runMutation(internal.sessions.setProfileImage, {
		...claims,
		image,
	});
	if (result.type === "updated") return reply(result.user, image ? 201 : 200);
	if (image && result.type === "unauthenticated")
		await ctx.storage.delete(image.storageId);
	return result.type === "unauthenticated"
		? reply({ code: "UNAUTHENTICATED" }, 401)
		: reply({ code: "PROFILE_IMAGE_UNAVAILABLE" }, 503);
});
