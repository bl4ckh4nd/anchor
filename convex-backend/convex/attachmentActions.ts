"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import {
	maxSize,
	mimeTypes,
	storageContentType,
	validFilename,
} from "./attachmentFiles";

export const decodeMultipart = internalAction({
	args: { downloadUrl: v.string(), uploadUrl: v.string(), type: v.string(), importing: v.optional(v.boolean()) },
	handler: async (_ctx, { downloadUrl, uploadUrl, type, importing }) => {
		const unavailable = { status: 503, code: "ATTACHMENT_UPLOAD_RETRY" };
		const stored = await fetch(storageUrl(downloadUrl), {
			redirect: "error",
		}).catch(() => null);
		if (!stored?.ok) return unavailable;
		let form: FormData;
		try {
			form = await new Response(stored.body, {
				headers: { "Content-Type": type },
			}).formData();
		} catch {
			return { status: 400, code: "INVALID_ATTACHMENT" };
		}
		const files = form.getAll("file");
		const file = files[0];
		const fields = [...form.entries()].filter(([name]) => name !== "file");
		if (
			files.length !== 1 ||
			!file ||
			typeof file === "string" ||
			fields.length > 16 ||
			fields.some(([, value]) => typeof value !== "string") ||
			!file.size ||
			!validFilename(file.name)
		)
			return { status: 400, code: "INVALID_ATTACHMENT" };
		if (file.size > maxSize)
			return { status: 413, code: "ATTACHMENT_TOO_LARGE" };
		if (!mimeTypes.has(file.type))
			return { status: 415, code: "UNSUPPORTED_ATTACHMENT_TYPE" };
		const positions = form.getAll("position");
		const position = typeof positions[0] === "string" && /^\d+$/.test(positions[0])
			? Number(positions[0]) : NaN;
		if (importing && (positions.length !== 1 || !Number.isSafeInteger(position)))
			return { status: 400, code: "INVALID_ATTACHMENT_POSITION" };
		const uploaded = await fetch(storageUrl(uploadUrl), {
			method: "POST",
			redirect: "error",
			headers: { "Content-Type": storageContentType },
			body: file,
		}).catch(() => null);
		if (!uploaded?.ok) return unavailable;
		const { storageId } = (await uploaded.json()) as {
			storageId: import("./_generated/dataModel").Id<"_storage">;
		};
		return {
			file: {
				storageId,
				originalFilename: file.name,
				mimeType: file.type,
				fileSize: file.size,
				...(importing ? { position } : {}),
			},
		};
	},
});

export function storageUrl(value: string) {
	const url = new URL(value);
	const origin = process.env.ANCHOR_INTERNAL_CONVEX_URL;
	return origin ? new URL(url.pathname + url.search, origin) : url;
}
