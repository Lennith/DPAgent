import { createWebServer } from './WebServer.js';
import { resolve } from 'path';
import * as fs from 'fs';
import { resolveWebServerPort } from './port-config.js';

let port: number;
try {
  port = resolveWebServerPort(process.env.MINIMAX_PORT);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
const configPath = resolve(process.cwd(), 'config.yaml');

if (!fs.existsSync(configPath)) {
  console.error(`[WebServer] Missing config.yaml: ${configPath}`);
  process.exit(1);
}

console.log(`[WebServer] Starting with config: ${configPath}`);

const server = createWebServer({
  port,
  configPath,
  allowMissingApiKeyAtBoot: process.env.MINIMAX_ALLOW_MISSING_API_KEY_AT_BOOT === '1',
});

server.start().catch((error) => {
  console.error('[WebServer] Failed to start:', error);
  process.exit(1);
});

process.on('SIGINT', async () => {
  console.log('\n[WebServer] Shutting down...');
  await server.stop();
  process.exit(0);
});

 
