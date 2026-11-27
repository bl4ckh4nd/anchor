import { createFileRoute } from "@tanstack/react-router";
import SettingsPage from "@/app/(app)/settings/page";

export const Route = createFileRoute("/_app/settings")({
  component: SettingsPage,
});
