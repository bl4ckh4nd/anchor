import { createFileRoute, notFound } from "@tanstack/react-router";
import MissingPage from "@/app/(app)/[...missing]/page";

export const Route = createFileRoute("/_app/$")({
  loader: () => {
    throw notFound();
  },
  notFoundComponent: MissingPage,
});
