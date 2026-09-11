import { startServer } from "./startServer.js";

// Production entry point. Unlike dev.ts it does not load a repo-root .env —
// containers receive their environment from --env-file or -e.
//
// The catch is what turns a misconfiguration into a readable failure: a bare
// top-level `await startServer()` rejects, and Node prints the whole
// ERR_UNHANDLED_REJECTION stack right after the configuration report that
// already said exactly what was wrong. One line, exit 1.
await startServer().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
