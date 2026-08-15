import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./startServer.js";

// Dev convenience: the backend has no dotenv, and provider credentials live in
// the repo-root .env (gitignored). Load it before reading config so a plain
// `pnpm --filter @echoflow/backend dev` picks up Volcengine keys. No-op when the
// file is absent (CI / production), and shell-provided env vars still win.
const repoRootEnv = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env");
if (existsSync(repoRootEnv)) {
  process.loadEnvFile(repoRootEnv);
  console.log(`Loaded environment from ${repoRootEnv}`);
}

// Same as main.ts: report the cause on one line instead of an unhandled-rejection
// stack trace stapled to the configuration report.
await startServer().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
