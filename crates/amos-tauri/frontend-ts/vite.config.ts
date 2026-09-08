import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// Tauri expects the frontend to listen on a fixed port in dev (`devUrl`) and
// write static output to `frontendDist` for production. Keep 1420 (Tauri default).
export default defineConfig({
  plugins: [
    react(),
    // Coexistence migration seam: .svelte files are compiled by this plugin while
    // the rest of the tree stays React. Svelte 5 runes are the default.
    svelte(),
  ],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // Bind all interfaces (0.0.0.0 + [::]). Tauri's desktop WKWebView resolves
    // the devUrl "localhost" to 127.0.0.1 (IPv4); without this vite only listened
    // on [::1] (IPv6) and the native window loaded nothing (blank).
    host: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "es2021",
    outDir: "dist",
    // Two HTML entries: the React main (index.html, ships to Tauri) and the
    // optional pure-Svelte Shell preview (shell.html, Phase-3 ③) — emitted so
    // /shell.html can be served from dist for local/headless acceptance without
    // touching the production entry.
    rollupOptions: {
      input: {
        main: new URL("./index.html", import.meta.url).pathname,
        shell: new URL("./shell.html", import.meta.url).pathname,
      },
    },
  },
});
