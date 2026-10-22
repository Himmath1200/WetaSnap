// Started by `npm run dev`. The preview host appends its own `--port <n>`, which
// Vite's CLI reads as a stray positional root; booting the API directly ignores
// those args and keeps the port stable for cloudflared.
import { createServer } from 'vite';

const server = await createServer();
await server.listen();
server.printUrls();
