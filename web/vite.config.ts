import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  esbuild: {
    legalComments: "none",
  },
  build: {
    // External maps let DevTools resolve production errors without affecting
    // the normal page-load request graph.
    sourcemap: true,
    target: "es2020",
    minify: "esbuild",
    cssMinify: true,
    outDir: "dist",
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        presentation: fileURLToPath(new URL("./presentation/index.html", import.meta.url)),
        windows: fileURLToPath(new URL("./desktop/renderer.html", import.meta.url)),
        lockScreenDetector: fileURLToPath(new URL("./lockscreen-detector.html", import.meta.url)),
      },
    },
  },
});
