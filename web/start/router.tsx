import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  return createRouter({
    routeTree,
    // Search text and authentication callbacks use ordinary URL query strings.
    parseSearch(search) {
      const values: Record<string, string[]> = Object.create(null);
      for (const [key, value] of new URLSearchParams(search)) {
        values[key] ??= [];
        values[key].push(value);
      }
      return values;
    },
    stringifySearch(search) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(search)) {
        if (value === undefined) continue;
        for (const entry of Array.isArray(value) ? value : [value]) {
          params.append(key, String(entry));
        }
      }
      const query = params.toString();
      return query ? `?${query}` : "";
    },
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
