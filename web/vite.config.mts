import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import packageJson from "./package.json" with { type: "json" };

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), ["SERVER_URL"]);
  const api =
    process.env.SERVER_URL ?? env.SERVER_URL ?? "http://127.0.0.1:3001";

  return {
    define: {
      "import.meta.env.VITE_APP_VERSION": JSON.stringify(packageJson.version),
    },
    plugins: [tailwindcss(), tanstackStart({ srcDirectory: "start" }), react()],
    resolve: { tsconfigPaths: true },
    server: {
      port: 3000,
      strictPort: true,
      proxy: {
        "^/(api|uploads)(/|$)": { target: api, changeOrigin: true },
      },
    },
  };
});
