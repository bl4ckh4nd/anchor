import { beforeEach, describe, expect, it, vi } from "vitest";

const saved = new Map<string, string>();

beforeEach(() => {
  saved.clear();
  vi.resetModules();
  const localStorage = {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
    removeItem: (key: string) => saved.delete(key),
  };
  vi.stubGlobal("window", { localStorage });
  vi.stubGlobal("localStorage", localStorage);
});

describe("preferences store", () => {
  it("shows pictures on cards for preferences saved before the setting", async () => {
    saved.set(
      "preferences",
      JSON.stringify({ state: { notes: { viewMode: "list" } }, version: 0 }),
    );
    const { usePreferencesStore } = await import("./store");

    const { notes } = usePreferencesStore.getState();
    expect(notes.viewMode).toBe("list");
    expect(notes.showCardPictures).toBe(true);
  });
});
