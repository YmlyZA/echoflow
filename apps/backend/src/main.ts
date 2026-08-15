import { startServer } from "./startServer.js";

// Production entry point. Unlike dev.ts it does not load a repo-root .env —
// containers receive their environment from --env-file or -e.
await startServer();
