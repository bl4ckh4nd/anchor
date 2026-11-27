import { stringifyDelta } from "@/features/notes/quill";
import { toWallClock } from "@/features/notes/reminder";
import type { NoteAttachment } from "@/features/notes/types";
import { api } from "@/lib/api/client";
import type {
  CanonicalNote,
  ExportFormat,
  ImportNoteItem,
  ImportNotesResponse,
  ImportTag,
} from "./types";

export const IMPORT_BATCH_SIZE = 25;

export async function downloadExport(
  format: ExportFormat = "anchor",
): Promise<void> {
  // Export can take a while for large accounts; disable the 30s default
  const response = await api.get("api/export", {
    searchParams: { format },
    headers: { "X-Anchor-Export-Parts": "1" },
    timeout: false,
  });
  const blob =
    response.status === 202
      ? await downloadExportParts(response)
      : await response.blob();

  const disposition = response.headers.get("Content-Disposition") ?? "";
  const serverName = disposition.match(/filename="([^"]+)"/)?.[1];
  const fallbackName =
    format === "markdown" ? "anchor-markdown" : "anchor-export";
  const today = toWallClock(new Date()).slice(0, 10);
  // The server dates the name in its own time zone.
  const filename =
    serverName?.replace(/\d{4}-\d{2}-\d{2}/, today) ??
    `${fallbackName}-${today}.zip`;

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  // Revoking synchronously can cancel the download in some browsers
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function downloadExportParts(response: Response): Promise<Blob> {
  const { id, size, chunkSize } = (await response.json()) as {
    id: string;
    size: number;
    chunkSize: number;
  };
  if (
    typeof id !== "string" ||
    !/^[a-z0-9]{1,64}$/.test(id) ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    !Number.isSafeInteger(chunkSize) ||
    chunkSize <= 0 ||
    chunkSize > size
  )
    throw new Error("Invalid export download");

  const parts: Blob[] = [];
  for (let offset = 0; offset < size; offset += chunkSize) {
    const part = await api.get(`api/export/${id}`, {
      searchParams: { offset },
      timeout: false,
    });
    const end = Math.min(offset + chunkSize, size);
    if (
      part.status !== 206 ||
      part.headers.get("Content-Range") !== `bytes ${offset}-${end - 1}/${size}`
    ) {
      await part.body?.cancel();
      throw new Error("Invalid export part");
    }
    const bytes = await part.blob();
    if (bytes.size !== end - offset) throw new Error("Incomplete export part");
    parts.push(bytes);
  }
  return new Blob(parts, { type: "application/zip" });
}

export function toImportNoteItem(
  note: CanonicalNote,
  tagNames: string[] = note.tagNames,
): ImportNoteItem {
  return {
    ref: note.ref,
    id: note.id,
    title: note.title,
    content: stringifyDelta(note.contentDelta),
    isPinned: note.isPinned,
    isArchived: note.isArchived,
    isTrashed: note.isTrashed,
    background: note.background ?? undefined,
    tagNames: tagNames.length ? tagNames : undefined,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
}

export async function importNotes(
  notes: ImportNoteItem[],
  tags: ImportTag[],
  skipExisting: boolean,
): Promise<ImportNotesResponse> {
  const palette = tags.map((tag) => ({
    name: tag.name,
    ...(tag.color ? { color: tag.color } : {}),
  }));
  return api
    .post("api/import/notes", {
      json: { notes, tags: palette, skipExisting },
      timeout: false,
    })
    .json<ImportNotesResponse>();
}

export async function importAttachment(
  noteId: string,
  blob: Blob,
  filename: string,
  mimeType: string,
  position: number,
): Promise<NoteAttachment> {
  const formData = new FormData();
  formData.append("file", new File([blob], filename, { type: mimeType }));
  formData.append("position", String(position));

  return api
    .post(`api/import/notes/${noteId}/attachments`, {
      body: formData,
      timeout: false,
    })
    .json<NoteAttachment>();
}
