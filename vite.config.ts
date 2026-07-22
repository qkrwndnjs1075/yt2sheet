import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vite";

const outDir = resolve(__dirname, "dist");
const contentScriptEntries = new Set(["src/content/roi-selector.js", "src/content/video-probe.js"]);

function copyExtensionStaticFiles() {
  return {
    name: "copy-extension-static-files",
    closeBundle() {
      const files = [
        ["manifest.json", "manifest.json"],
        ["src/content/roi-selector.css", "src/content/roi-selector.css"],
        ["src/debug/debug.html", "src/debug/debug.html"],
        ["src/offscreen/offscreen.html", "src/offscreen/offscreen.html"]
      ];

      for (const [from, to] of files) {
        const target = resolve(outDir, to);
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(resolve(__dirname, from), target);
      }
    }
  };
}

function wrapContentScripts() {
  return {
    name: "wrap-content-scripts",
    renderChunk(code: string, chunk: { fileName: string }) {
      if (!contentScriptEntries.has(chunk.fileName)) {
        return null;
      }

      return {
        code: `(() => {\n${code}\n})();\n`,
        map: null
      };
    }
  };
}

export default defineConfig({
  publicDir: false,
  build: {
    outDir,
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        "src/background/index": resolve(__dirname, "src/background/index.ts"),
        "src/content/roi-selector": resolve(__dirname, "src/content/roi-selector.ts"),
        "src/content/video-probe": resolve(__dirname, "src/content/video-probe.ts"),
        "src/debug/debug": resolve(__dirname, "src/debug/debug.ts"),
        "src/offscreen/offscreen": resolve(__dirname, "src/offscreen/offscreen.ts")
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]"
      }
    },
  },
  plugins: [wrapContentScripts(), copyExtensionStaticFiles()]
});
