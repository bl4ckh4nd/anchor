import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { refreshAfterReorder } from "./use-sync";

describe("refreshAfterReorder", () => {
  it("refreshes notes and tags once the last reorder settles", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["notes", null], []);
    queryClient.setQueryData(["tags"], []);

    refreshAfterReorder(queryClient);

    expect(queryClient.getQueryState(["notes", null])?.isInvalidated).toBe(
      true,
    );
    expect(queryClient.getQueryState(["tags"])?.isInvalidated).toBe(true);
  });
});
