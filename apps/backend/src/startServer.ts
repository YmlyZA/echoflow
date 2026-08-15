import type { FastifyInstance } from "fastify";
import { createConfig, type BackendConfigInput } from "./config.js";
import { createServer } from "./server.js";

/**
 * Shared bootstrap for both entry points (dev.ts loads a repo-root .env first;
 * main.ts does not). Keeping listen + shutdown here means the graceful-shutdown
 * block exists once rather than being copy-pasted into a second entry point.
 */
export async function startServer(
  input: BackendConfigInput = {},
): Promise<FastifyInstance> {
  const config = createConfig(input);
  const server = createServer(config);

  await server.listen({ port: config.port, host: config.host });
  console.log(`EchoFlow backend listening on http://${config.host}:${config.port}`);

  // process.once so a second signal falls through to Node's default handler
  // and kills a hung shutdown.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      console.log(`Received ${signal}, shutting down...`);
      void server.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  }

  return server;
}
