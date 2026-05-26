import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface IntegrationHarness {
  tempDir: string;
  workspaceDir: string;
  runtimeDir: string;
  contextDir: string;
  configPath: string;
  extraDirs: Record<string, string>;
}

export interface CreateIntegrationHarnessOptions {
  configYaml?: string | string[];
  extraDirs?: Record<string, string>;
}

export function createIntegrationHarness(
  prefix: string,
  options: CreateIntegrationHarnessOptions = {}
): IntegrationHarness {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const workspaceDir = path.join(tempDir, 'workspace');
  const runtimeDir = path.join(tempDir, 'runtime');
  const contextDir = path.join(tempDir, 'contexts');
  const configPath = path.join(tempDir, 'config.yaml');
  const extraDirs: Record<string, string> = {};

  for (const dir of [workspaceDir, runtimeDir, contextDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  for (const [name, relativePath] of Object.entries(options.extraDirs ?? {})) {
    const dir = path.join(tempDir, relativePath);
    fs.mkdirSync(dir, { recursive: true });
    extraDirs[name] = dir;
  }

  if (options.configYaml !== undefined) {
    const lines = Array.isArray(options.configYaml) ? options.configYaml : [options.configYaml];
    fs.writeFileSync(configPath, `${lines.join('\n')}\n`, 'utf-8');
  }

  return { tempDir, workspaceDir, runtimeDir, contextDir, configPath, extraDirs };
}

export function cleanupIntegrationHarness(harness: Pick<IntegrationHarness, 'tempDir'>): void {
  fs.rmSync(harness.tempDir, { recursive: true, force: true });
}
