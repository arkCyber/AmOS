import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects the frontend to listen on a fixed port in dev (`devUrl`) and
// write static output to `frontendDist` for production. Keep 1420 (Tauri default).
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "es2021",
    outDir: "dist",
  },
});
