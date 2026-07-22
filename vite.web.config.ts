import { resolve } from "node:path";
import { defineConfig } from "vite";

const webRoot = resolve(__dirname, "web");

export default defineConfig({
  root: webRoot,
  base: "./",
  build: {
    outDir: resolve(__dirname, "dist-web"),
    emptyOutDir: true,
    sourcemap: true
  },
  server: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4174",
        changeOrigin: true
      }
    }
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4174",
        changeOrigin: true
      }
    }
  }
});
