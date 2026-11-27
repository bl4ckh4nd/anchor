import { createFileRoute } from "@tanstack/react-router";
import ArchivePage from "@/app/(app)/archive/page";

export const Route = createFileRoute("/_app/archive")({
  component: ArchivePage,
});
