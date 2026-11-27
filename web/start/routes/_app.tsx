import { createFileRoute, Outlet } from "@tanstack/react-router";
import AppError from "@/app/(app)/error";
import AppLayout from "@/app/(app)/layout";

export const Route = createFileRoute("/_app")({
  component: Layout,
  errorComponent: AppError,
});

function Layout() {
  return (
    <AppLayout>
      <Outlet />
    </AppLayout>
  );
}
