"use client";

import { RotateCw } from "lucide-react";
import * as React from "react";
import { ErrorScreen } from "@/components/layout/error-screen";
import { Button } from "@/components/ui/button";

export default function GlobalError({ error }: { error: unknown }) {
  React.useEffect(() => console.error(error), [error]);

  return (
    <main className="grid min-h-dvh content-center bg-background px-4">
      <ErrorScreen
        illustration="broken"
        title="Something went wrong"
        text="An unexpected error occurred. Reloading the page usually fixes it. Your saved notes are safe."
        actions={
          <Button onClick={() => window.location.reload()}>
            <RotateCw aria-hidden />
            Reload
          </Button>
        }
      />
    </main>
  );
}
