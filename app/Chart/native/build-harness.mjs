import { build } from "vite";
import react from "@vitejs/plugin-react-swc";
import { fileURLToPath } from "node:url";
await build({
  configFile: false,
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL("../../src", import.meta.url)) } },
  build: {
    target: "esnext",
    outDir: "/tmp/kavla-viz-app",
    emptyOutDir: true,
    reportCompressedSize: false,
    rollupOptions: { input: fileURLToPath(new URL("browser-harness.html", import.meta.url)) },
  },
});
