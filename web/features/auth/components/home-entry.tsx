"use client";

import { useEffect } from "react";
import { SplashScreen } from "@/components/layout/splash-screen";
import { SessionCheck } from "@/features/auth/components/session-check";
import { useAuthStore } from "@/features/auth/store";

export function HomeEntry({
  replace,
}: {
  replace: (path: "/login" | "/notes") => void;
}) {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const isInitialized = useAuthStore((state) => state.isInitialized);

  useEffect(() => {
    if (!isInitialized) return;

    replace(isAuthenticated ? "/notes" : "/login");
  }, [isInitialized, isAuthenticated, replace]);

  return (
    <SessionCheck>
      <SplashScreen checking={false} />
    </SessionCheck>
  );
}
