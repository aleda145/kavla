import { build } from "vite";
import react from "@vitejs/plugin-react-swc";
import { fileURLToPath } from "node:url";
await build({
  configFile: false,
  plugins: [react()],
  build: {
    target: "esnext",
    ssr: fileURLToPath(new URL("node-benchmark.tsx", import.meta.url)),
    outDir: "/tmp/kavla-viz-node",
    emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: "benchmark.mjs" } },
  },
});
// Resolve external dependencies from the app without installing anything.
const { mkdir, symlink } = await import("node:fs/promises");
await mkdir("/tmp/kavla-viz-node", { recursive: true });
await symlink(fileURLToPath(new URL("../../node_modules", import.meta.url)), "/tmp/kavla-viz-node/node_modules", "dir").catch(error => {
  if (error.code !== "EEXIST") throw error;
});
await import("/tmp/kavla-viz-node/benchmark.mjs");
