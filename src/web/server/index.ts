import { createWebServer } from './WebServer.js';
import { resolve } from 'path';
import * as fs from 'fs';
import { resolveWebServerPort } from './port-config.js';

let port: number;
try {
  port = resolveWebServerPort(process.env.DPAGENT_PORT);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
const configPath = resolve(process.env.DPAGENT_CONFIG_PATH || resolve(process.cwd(), 'config.yaml'));

if (!fs.existsSync(configPath)) {
  console.error(`[WebServer] Missing config.yaml: ${configPath}`);
  process.exit(1);
}

console.log(`[WebServer] Starting with config: ${configPath}`);

const server = createWebServer({
  port,
  configPath,
  allowMissingApiKeyAtBoot: process.env.DPAGENT_ALLOW_MISSING_API_KEY_AT_BOOT === '1',
});

process.on('uncaughtException', (error) => {
  console.error('[WebServer] Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[WebServer] Unhandled rejection:', reason);
  process.exit(1);
});

process.on('exit', (code) => {
  console.log(`[WebServer] Process exit code=${code}`);
});

server.start().catch((error) => {
  console.error('[WebServer] Failed to start:', error);
  process.exit(1);
});

async function shutdown(signal: 'SIGINT' | 'SIGTERM'): Promise<void> {
  console.log(`\n[WebServer] Shutting down after ${signal}...`);
  try {
    await server.stop();
    process.exit(0);
  } catch (error) {
    console.error('[WebServer] Failed during shutdown:', error);
    process.exit(1);
  }
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

 
