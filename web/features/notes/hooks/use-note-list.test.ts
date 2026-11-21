import { describe, expect, it } from "vitest";
import type { Note } from "../types";
import { findAndSort } from "./use-note-list";

const note = (id: string, title: string, tagIds: string[] = []): Note => ({
  id,
  title,
  content: null,
  isPinned: false,
  isArchived: false,
  state: "active",
  version: 1,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  userId: "u1",
  tagIds,
  permission: "owner",
});

describe("findAndSort", () => {
  const tags = new Map([
    ["t1", { id: "t1", name: "Work" }],
    ["t2", { id: "t2", name: "Recipes" }],
  ]);
  const notes = [
    note("a", "Standup", ["t1"]),
    note("b", "Pancakes", ["t2"]),
    note("c", "Networking event"),
  ];
  const ids = (term: string, tagMap = tags) =>
    findAndSort(notes, term, "title", "asc", tagMap).map((n) => n.id);

  it("finds notes by the name of a tag they carry, any case", () => {
    expect(ids("recipe")).toEqual(["b"]);
    expect(ids("work")).toEqual(["c", "a"]);
  });

  it("matches the tag's current name after a rename", () => {
    expect(ids("recipe")).toEqual(["b"]);
    const renamed = new Map([...tags, ["t2", { id: "t2", name: "Baking" }]]);
    expect(ids("recipe", renamed)).toEqual([]);
    expect(ids("baking", renamed)).toEqual(["b"]);
  });
});
