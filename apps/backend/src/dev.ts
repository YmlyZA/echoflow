import { createServer } from "./server.js";

const port = Number(process.env.PORT ?? 8787);
const server = createServer({ port });

await server.listen({ port, host: "127.0.0.1" });

console.log(`EchoFlow backend listening on http://127.0.0.1:${port}`);
