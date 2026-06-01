import { createConfig } from "./config.js";
import { createServer } from "./server.js";

const config = createConfig();
const server = createServer(config);

await server.listen({ port: config.port, host: "127.0.0.1" });

console.log(`EchoFlow backend listening on http://127.0.0.1:${config.port}`);
