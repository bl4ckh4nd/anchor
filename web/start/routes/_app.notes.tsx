import { createFileRoute, Outlet } from "@tanstack/react-router";
import NotesLayout from "@/app/(app)/notes/layout";

export const Route = createFileRoute("/_app/notes")({ component: Layout });

function Layout() {
  return (
    <NotesLayout>
      <Outlet />
    </NotesLayout>
  );
}
