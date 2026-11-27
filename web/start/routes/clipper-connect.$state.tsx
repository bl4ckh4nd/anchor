import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Brand } from "@/components/layout/brand";
import { Button } from "@/components/ui/button";
import { AuthGuard } from "@/features/auth/components/auth-guard";
import { useAuthStore } from "@/features/auth/store";
import { api } from "@/lib/api/client";

const callback =
  "https://lpangogfgpboibjoafampidakcimppck.chromiumapp.org/bordo";

export const Route = createFileRoute("/clipper-connect/$state")({
  component: () => (
    <AuthGuard>
      <ConnectClipper />
    </AuthGuard>
  ),
});

function ConnectClipper() {
  const { state } = Route.useParams();
  const validRequest = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(
    state,
  );
  const email = useAuthStore((store) => store.user?.email);
  const [status, setStatus] = useState<"ready" | "busy" | "failed">("ready");

  async function connect() {
    if (!validRequest || status === "busy") return;
    setStatus("busy");
    try {
      const session = await api
        .post("api/auth/clipper/session", { retry: 0 })
        .json<{ access_token: string; refresh_token: string }>();
      const fragment = new URLSearchParams({
        state,
        access_token: session.access_token,
        refresh_token: session.refresh_token,
      });
      window.location.replace(`${callback}#${fragment}`);
    } catch {
      setStatus("failed");
    }
  }

  return (
    <main className="mx-auto grid min-h-dvh w-full max-w-lg content-center gap-5 p-6">
      <Brand />
      <h1 className="font-semibold text-title">Connect Bordo for Chrome</h1>
      {validRequest ? (
        <>
          <p className="text-ui text-muted-foreground">
            Use {email ?? "your Bordo account"} to save notes and attachments
            from Chrome. The extension gets its own sign-in session.
          </p>
          {status === "failed" && (
            <p role="alert">Couldn’t connect right now. Try again.</p>
          )}
          <Button onClick={connect} disabled={status === "busy"}>
            {status === "busy" ? "Connecting…" : "Connect extension"}
          </Button>
        </>
      ) : (
        <p className="text-ui text-muted-foreground">
          Start the connection from the Bordo extension in Chrome.
        </p>
      )}
    </main>
  );
}
