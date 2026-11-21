import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

/**
 * Builds only the control-panel bundle.
 *
 * Ruffle and the backend stay plain ES modules; the panel gets Tailwind +
 * Basecoat and is minified into stable filenames so `index.html` can load it
 * without a dev server:
 *
 *   assets/panel/panel.css
 *   assets/panel/panel.js
 *   assets/panel/fonts/inclusive-sans-*.woff2
 */
export default defineConfig({
    plugins: [tailwindcss()],
    publicDir: false,
    // Emit relative asset URLs so the bundle works when the site is served
    // from a subdirectory (and so `panel.css` finds `fonts/` next to itself).
    base: "./",
    build: {
        outDir: "assets/panel",
        emptyOutDir: true,
        target: ["chrome108", "firefox111"],
        cssCodeSplit: false,
        minify: true,
        rollupOptions: {
            input: resolve(import.meta.dirname, "frontend/panel.js"),
            output: {
                entryFileNames: "panel.js",
                chunkFileNames: "chunk-[name].js",
                assetFileNames: (assetInfo) => {
                    const name =
                        assetInfo.names?.[0] ?? assetInfo.name ?? "asset";
                    if (name.endsWith(".css")) {
                        return "panel.css";
                    }
                    if (name.endsWith(".woff2")) {
                        return "fonts/[name][extname]";
                    }
                    return "[name][extname]";
                },
            },
        },
    },
});
