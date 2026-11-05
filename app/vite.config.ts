import react from "@vitejs/plugin-react-swc";
import { defineConfig } from "vite";
import path from "path";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(() => {
  return {
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "tldraw-english-only",
        enforce: "pre",
        resolveId(source, importer) {
          // The asset helper imports every locale; resolve them all to the English asset.
          if (
            importer?.endsWith("/@tldraw/assets/imports.vite.js") &&
            /^\.\/translations\/[^/]+\.json\?url$/.test(source)
          ) {
            return path.resolve(path.dirname(importer), "translations/en.json") + "?url";
          }
        },
      },
    ],
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "./src"),
      },
    },
    server: {
      headers: {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "credentialless",
      },
    },
    build: {
      target: "esnext",
      outDir: "dist",
      assetsInlineLimit: 0,
    },
    optimizeDeps: {
      exclude: ["@polyglot-sql/sdk"],
    },
  };
});
