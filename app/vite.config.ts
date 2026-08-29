import react from "@vitejs/plugin-react-swc";
import { defineConfig } from "vite";
import path from "path";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "./src"),
      },
    },
    server: {
      headers: {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
      },
    },
    build: {
      target: "esnext",
      outDir: "dist",
      assetsInlineLimit: 0,
    },
    optimizeDeps: {
      exclude: ["@duckdb/duckdb-wasm", "@polyglot-sql/sdk"],
    },
  };
});
