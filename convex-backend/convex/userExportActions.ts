"use node";

import { ZipArchive, type ZipEntryData } from "archiver";
import { once } from "node:events";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FunctionReturnType } from "convex/server";
import { v } from "convex/values";
import {
	buildManifest,
	type ExportNoteRow,
	type ExportManifestTag,
} from "../../server/src/import-export/export-manifest.util";
import { planMarkdownExport } from "../../server/src/import-export/markdown/markdown-export.util";
import type { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { storageUrl } from "./attachmentActions";
import { exportStorageContentType } from "./attachmentFiles";

const maxExportBytes = 100 * 1024 * 1024;
const safeId = /^[a-zA-Z0-9_-]+$/;
class ExportTooLarge extends Error {}
type ExportResult =
	| { type: "too-large" }
	| { type: "archive"; storageId: Id<"_storage"> };

type NoteRows = NonNullable<
	FunctionReturnType<typeof internal.notes.exportLibraryPage>
>["rows"];
type ExportPage =
	| { source: "tags"; rows: ExportManifestTag[] }
	| { source: "owned" | "shared"; rows: NoteRows };

async function readLibrary(
	urls: string[],
	user: { id: string; email: string },
	signal: AbortSignal,
) {
	const tags: ExportManifestTag[] = [];
	const notes = { owned: [] as ExportNoteRow[], shared: [] as ExportNoteRow[] };
	const sources = new Map<string, { url: string; size: number }>();
	const warnings: string[] = [];
	let metadataBytes = 0;
	for (const url of urls) {
		const response = await fetch(storageUrl(url), {
			redirect: "error",
			signal,
		});
		if (!response.ok) throw new Error("Export staging page unavailable");
		const { source, rows } = (await response.json()) as ExportPage;
		if (source === "tags") {
			tags.push(...rows);
			continue;
		}

		for (const { note, media } of rows) {
			metadataBytes += Buffer.byteLength(JSON.stringify(note));
			if (metadataBytes > maxExportBytes) throw new ExportTooLarge();
			const attachments: ExportNoteRow["attachments"] = [];
			for (const { downloadUrl: url, ...entry } of media) {
				if (!safeId.test(note.id) || !safeId.test(entry.id))
					throw new Error("Invalid ID in archive path");
				if (!url) {
					warnings.push(
						`Attachment file missing: ${entry.originalFilename} (note ${note.id})`,
					);
					continue;
				}
				sources.set(`${note.id}/${entry.id}`, { url, size: entry.fileSize });
				attachments.push({
					...entry,
					storedFilename: entry.originalFilename,
				});
			}
			notes[source].push({
				id: note.id,
				title: note.title,
				content: note.content,
				state: note.state,
				background: note.background,
				createdAt: new Date(note.createdAt),
				updatedAt: new Date(note.updatedAt),
				tags: note.tagIds.map((id) => ({ id, userId: user.id })),
				pins: note.isPinned ? [{ userId: user.id }] : [],
				archives: note.isArchived ? [{ userId: user.id }] : [],
				reminders: note.reminder ? [{ ...note.reminder, userId: user.id }] : [],
				attachments,
				sharedWith: note.sharedBy
					? [{ sharedWithUserId: user.id, sharedByUser: note.sharedBy }]
					: [],
			});
		}
	}
	return {
		manifest: buildManifest({
			user,
			tags,
			ownedNotes: notes.owned,
			sharedNotes: notes.shared,
			warnings,
			serverVersion: null,
		}),
		sources,
	};
}

export const assemble = internalAction({
	args: {
		user: v.object({ id: v.string(), email: v.string() }),
		pageUrls: v.array(v.string()),
		uploadUrl: v.string(),
		allowLarge: v.boolean(),
		format: v.union(v.literal("anchor"), v.literal("markdown")),
	},
	handler: async (
		_ctx,
		{ user, pageUrls, format, uploadUrl, allowLarge },
	): Promise<ExportResult> => {
		const abort = new AbortController();
		let tooLarge = false;
		try {
			const prepared = await readLibrary(pageUrls, user, abort.signal);
			const { manifest, sources } = prepared;
			const archive = new ZipArchive({ zlib: { level: 6 } });
			archive.on("warning", (error) => archive.destroy(error));
			const append = async (data: string | Readable, entry: ZipEntryData) => {
				const archived = once(archive, "entry");
				archive.append(data, entry);
				await archived;
			};
			const appendMedia = async (
				noteId: string,
				attachmentId: string,
				path: string,
			) => {
				const source = sources.get(`${noteId}/${attachmentId}`);
				if (!source) throw new Error("Missing export attachment");
				const stream = Readable.from(
					(async function* () {
						const response = await fetch(storageUrl(source.url), {
							redirect: "error",
							signal: abort.signal,
						});
						if (!response.ok || !response.body)
							throw new Error("Could not read export attachment");
						const reader = response.body.getReader();
						let bytes = 0;
						try {
							for (;;) {
								const chunk = await reader.read();
								if (chunk.done) break;
								bytes += chunk.value.length;
								if (bytes > source.size)
									throw new Error("Export attachment exceeds its stored size");
								yield chunk.value;
							}
							if (bytes !== source.size)
								throw new Error("Export attachment size mismatch");
						} finally {
							await reader.cancel();
						}
					})(),
					{ objectMode: false },
				);
				await append(stream, { name: path, store: true });
			};
			const writeEntries = async () => {
				if (format === "anchor") {
					await append(JSON.stringify(manifest, null, 2), {
						name: "manifest.json",
					});
					for (const note of manifest.notes)
						for (const item of note.attachments)
							await appendMedia(note.id, item.id, item.archivePath);
				} else {
					const { entries } = planMarkdownExport(manifest);
					const notes = manifest.notes.filter(
						(note) => note.state !== "trashed",
					);
					for (const [index, entry] of entries.entries()) {
						await append(entry.markdown, {
							name: entry.path,
							date: new Date(entry.updatedAt),
						});
						for (const item of entry.attachments)
							await appendMedia(
								notes[index].id,
								item.attachmentId,
								item.archivePath,
							);
					}
				}
				await archive.finalize();
			};

			let bytes = 0;
			const bounded = new Transform({
				transform(chunk, _encoding, callback) {
					bytes += chunk.length;
					if (!allowLarge && bytes > maxExportBytes) {
						tooLarge = true;
						return callback(new ExportTooLarge());
					}
					callback(null, chunk);
				},
			});
			const upload = fetch(storageUrl(uploadUrl), {
				method: "POST",
				headers: { "Content-Type": exportStorageContentType },
				body: Readable.toWeb(bounded) as ReadableStream<Uint8Array>,
				duplex: "half",
				redirect: "error",
				signal: abort.signal,
			} as RequestInit);
			const [response] = await Promise.all([
				upload,
				pipeline(archive, bounded),
				writeEntries(),
			]);
			if (!response.ok) throw new Error("Could not store export");
			const { storageId } = (await response.json()) as {
				storageId: Id<"_storage">;
			};
			return { type: "archive", storageId } as const;
		} catch (error) {
			if (tooLarge || error instanceof ExportTooLarge)
				return { type: "too-large" } as const;
			throw error;
		} finally {
			abort.abort();
		}
	},
});
