import { createFileRoute } from "@tanstack/react-router";
import { HomeEntry } from "@/features/auth/components/home-entry";
import { useRouter } from "@/lib/app-router";

function Home() {
  const { replace } = useRouter();
  return <HomeEntry replace={replace} />;
}

export const Route = createFileRoute("/")({ component: Home });
