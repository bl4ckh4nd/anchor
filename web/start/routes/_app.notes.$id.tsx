import { createFileRoute } from "@tanstack/react-router";
import NoteEditorPage from "@/app/(app)/notes/[id]/page";

export const Route = createFileRoute("/_app/notes/$id")({
  component: Editor,
});

function Editor() {
  const { id } = Route.useParams();
  return <NoteEditorPage routeId={id} />;
}
