import { QUERY_PARAM } from "./url-with-query";

/** Where a note dragged out of the columns list can be dropped. */
export type DropTarget =
  | { kind: "tag"; tagId: string }
  | { kind: "archive" }
  | { kind: "trash" };

/** Sidebar rows mark themselves with `data-note-drop`. */
export const DROP_ATTRIBUTE = "data-note-drop";

export function parseDropTarget(value: string | null): DropTarget | null {
  if (value === "archive" || value === "trash") return { kind: value };
  if (value?.startsWith("tag:") && value.length > 4)
    return { kind: "tag", tagId: value.slice(4) };
  return null;
}

/** A picked note takes the whole selection along; any other note goes alone. */
export function draggedNoteIds(
  activeId: string,
  picked: ReadonlySet<string>,
  shownIds: readonly string[],
): string[] {
  if (!picked.has(activeId)) return [activeId];
  return shownIds.filter((id) => picked.has(id));
}

/** The search goes along, so the note can show its matches. */
export function noteHref(id: string, tagId: string | null, query = "") {
  const params = [
    tagId && `tagId=${encodeURIComponent(tagId)}`,
    query.trim() && `${QUERY_PARAM}=${encodeURIComponent(query)}`,
  ].filter(Boolean);
  return params.length ? `/notes/${id}?${params.join("&")}` : `/notes/${id}`;
}
