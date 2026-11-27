import { createFileRoute } from "@tanstack/react-router";
import AdminPage from "@/app/(app)/admin/page";

export const Route = createFileRoute("/_app/admin")({
  component: AdminPage,
});
