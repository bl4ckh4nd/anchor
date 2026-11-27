import {
  Link as RouterLink,
  useLocation,
  useRouter as useTanStackRouter,
} from "@tanstack/react-router";
import { type ComponentPropsWithRef, useMemo } from "react";

export function usePathname() {
  return useLocation({ select: (location) => location.pathname });
}

export function useSearchParams() {
  const search = useLocation({ select: (location) => location.searchStr });
  return useMemo(() => new URLSearchParams(search), [search]);
}

// Notes, filters and sign-in redirects already construct complete paths.
export function useRouter() {
  const router = useTanStackRouter();
  return useMemo(
    () => ({
      push: (href: string) => router.navigate({ href }),
      replace: (href: string, resetScroll = true) =>
        router.navigate({ href, replace: true, resetScroll }),
      back: () => router.history.back(),
    }),
    [router],
  );
}

export function Link({
  href,
  ...props
}: ComponentPropsWithRef<"a"> & { href: string }) {
  return <RouterLink to={href} href={href} {...props} />;
}
