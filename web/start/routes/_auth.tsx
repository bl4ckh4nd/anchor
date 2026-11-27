import { createFileRoute, Outlet } from "@tanstack/react-router";
import AuthLayout from "@/app/(auth)/layout";

export const Route = createFileRoute("/_auth")({
  component: Layout,
});

function Layout() {
  return (
    <AuthLayout>
      <Outlet />
    </AuthLayout>
  );
}
