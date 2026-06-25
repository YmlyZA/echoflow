import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createConfig } from "./config.js";
import { createServer } from "./server.js";

// Dev convenience: the backend has no dotenv, and provider credentials live in
// the repo-root .env (gitignored). Load it before reading config so a plain
// `pnpm --filter @echoflow/backend dev` picks up Volcengine keys. No-op when the
// file is absent (CI / production), and shell-provided env vars still win.
const repoRootEnv = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env");
if (existsSync(repoRootEnv)) {
  process.loadEnvFile(repoRootEnv);
  console.log(`Loaded environment from ${repoRootEnv}`);
}

const config = createConfig();
const server = createServer(config);

await server.listen({ port: config.port, host: "127.0.0.1" });

console.log(`EchoFlow backend listening on http://127.0.0.1:${config.port}`);
