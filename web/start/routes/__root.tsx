import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import GlobalError from "@/app/global-error";
import { Providers } from "@/app/providers";
import { themeColorScript } from "@/lib/theme";
import "@/app/globals.css";

export const Route = createRootRoute({
  head: () => ({
    links: [
      { rel: "icon", href: "/favicon.ico" },
      { rel: "icon", href: "/icon0.svg", type: "image/svg+xml" },
      { rel: "icon", href: "/icon1.png", type: "image/png" },
      { rel: "apple-touch-icon", href: "/apple-icon.png" },
      { rel: "manifest", href: "/manifest.json" },
    ],
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        content:
          "width=device-width, initial-scale=1, interactive-widget=resizes-content",
      },
      { name: "apple-mobile-web-app-title", content: "Bordo" },
      { title: "Bordo" },
      { name: "description", content: "Your thoughts, secured" },
    ],
  }),
  component: Outlet,
  errorComponent: GlobalError,
  shellComponent: Root,
});

function Root({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      {/* biome-ignore lint/style/noHeadElement: TanStack Start owns this document head */}
      <head>
        <HeadContent />
      </head>
      <body>
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: a fixed script
          dangerouslySetInnerHTML={{ __html: themeColorScript }}
        />
        <Providers>{children}</Providers>
        <Scripts />
      </body>
    </html>
  );
}
