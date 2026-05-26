import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

interface PackageReleaseModule {
  STANDARD_FILES: string[];
  STANDARD_DIRS: string[];
  EASY_RUN_FILES: string[];
  EASY_RUN_DIRS: string[];
  createReleaseConfigTemplate: () => Record<string, unknown>;
}

function run(): void {
  const filePath = path.resolve(process.cwd(), 'scripts', 'package-release.js');
  const raw = fs.readFileSync(filePath, 'utf8');
  const releaseModule = require(filePath) as PackageReleaseModule;
  const standardFiles = releaseModule.STANDARD_FILES;
  const easyRunFiles = releaseModule.EASY_RUN_FILES;
  const easyRunDirs = releaseModule.EASY_RUN_DIRS;
  const standardDirs = releaseModule.STANDARD_DIRS;
  const template = releaseModule.createReleaseConfigTemplate();

  assert.match(raw, /function writeReleaseConfigTemplate/);
  assert.match(raw, /function assertReleaseConfigIsSanitized/);
  assert.match(raw, /assertReleaseConfigIsSanitized\(path\.join\(targetRoot, 'config\.yaml'\)\)/);
  assert.equal(standardFiles.includes('config.yaml'), false);
  assert.equal(easyRunFiles.includes('config.yaml'), false);
  assert.equal(standardFiles.includes('skill-list.yaml'), false);
  assert.equal(easyRunFiles.includes('skill-list.yaml'), false);
  assert.equal(easyRunFiles.includes('Run-DPAgent.bat'), true);
  assert.equal(easyRunFiles.some((item) => /Run-MiniMax/.test(item)), false);
  assert.ok(fs.existsSync(path.resolve(process.cwd(), 'Run-DPAgent.bat')));
  for (const relativePath of [...standardFiles, ...easyRunFiles]) {
    assert.ok(fs.existsSync(path.resolve(process.cwd(), relativePath)), `release file exists: ${relativePath}`);
  }
  for (const relativePath of standardDirs) {
    assert.ok(typeof relativePath === 'string' && relativePath.length > 0, `standard dir is declared: ${relativePath}`);
  }
  for (const relativePath of easyRunDirs) {
    assert.ok(typeof relativePath === 'string' && relativePath.length > 0, `easy-run dir is declared: ${relativePath}`);
  }
  assert.equal(Object.hasOwn(template.agent as Record<string, unknown>, 'skillListPath'), false);
  assert.match(raw, /apiKey:\s*''/);
  assert.match(raw, /llmProfiles/);
  assert.match(raw, /sk-\[A-Za-z0-9_-]/);
  console.log('package-release sanitized config tests passed');
}

run();
