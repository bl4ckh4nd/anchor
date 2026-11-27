"use client";

import { type ReactNode, useEffect } from "react";
import { useAuthStore } from "@/features/auth/store";
import { useRouter } from "@/lib/app-router";

interface AdminGuardProps {
  children: ReactNode;
}

export function AdminGuard({ children }: AdminGuardProps) {
  const router = useRouter();
  const isAdmin = useAuthStore((state) => !!state.user?.isAdmin);

  useEffect(() => {
    if (!isAdmin) router.replace("/notes");
  }, [isAdmin, router]);

  return isAdmin ? children : null;
}
