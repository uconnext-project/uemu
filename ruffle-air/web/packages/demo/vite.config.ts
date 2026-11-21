import { createReadStream, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Connect, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const demoDirectory = fileURLToPath(new URL(".", import.meta.url));
// The repository's test applications, including AIR application descriptors.
const testAppsDirectory = resolve(demoDirectory, "../../../../TEST_APPS");

const contentTypes: Record<string, string> = {
    ".xml": "application/xml",
    ".swf": "application/x-shockwave-flash",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".json": "application/json",
};

/**
 * Serves the repository's `TEST_APPS` directory under `/test-apps/` in the
 * Vite dev and preview servers. This makes it easy to try the AIR application
 * descriptor in `TEST_APPS` without setting up a second web server.
 */
function testApps(): Plugin {
    const middleware: Connect.NextHandleFunction = (req, res, next) => {
        const url = req.url;
        if (
            url === undefined ||
            !url.startsWith("/test-apps/") ||
            (req.method !== "GET" && req.method !== "HEAD")
        ) {
            next();
            return;
        }

        const relativePath = decodeURIComponent(
            url.slice("/test-apps/".length).split("?", 1)[0]!,
        );
        const filePath = resolve(testAppsDirectory, relativePath);
        if (
            filePath !== testAppsDirectory &&
            !filePath.startsWith(testAppsDirectory + sep)
        ) {
            res.statusCode = 403;
            res.end("Forbidden");
            return;
        }

        let stats;
        try {
            stats = statSync(filePath);
        } catch {
            next();
            return;
        }
        if (!stats.isFile()) {
            next();
            return;
        }

        res.setHeader(
            "Content-Type",
            contentTypes[extname(filePath).toLowerCase()] ??
                "application/octet-stream",
        );
        res.setHeader("Content-Length", stats.size);
        res.setHeader("Cache-Control", "no-cache");
        if (req.method === "HEAD") {
            res.end();
            return;
        }
        createReadStream(filePath).pipe(res);
    };

    return {
        name: "ruffle-test-apps",
        configureServer(server) {
            server.middlewares.use(middleware);
        },
        configurePreviewServer(server) {
            server.middlewares.use(middleware);
        },
    };
}

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [react(), testApps()],
    base: "",
});
