import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SkillPackStore } from '../../src/skills/SkillPackStore.js';
import type { SkillCatalogEntry } from '../../src/skills/SkillLoader.js';

function createSkill(name: string): SkillCatalogEntry {
  return {
    name,
    description: `${name} description`,
    path: path.join('virtual', name, 'SKILL.md'),
    source: 'workspace',
    content: `# ${name}\n\nDo the thing.\n`,
    tags: [],
    triggers: [],
    platforms: ['windows'],
    toolsets: ['windows-dev'],
  };
}

function cleanup(tempDir: string): void {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function testNumericVersionOrdering(): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-pack-store-'));
  try {
    const store = new SkillPackStore(tempDir);
    store.publishPack({
      name: 'numeric-pack',
      version: '2',
      scope: 'team',
      skills: [createSkill('numeric-skill')],
    });
    const record = store.publishPack({
      name: 'numeric-pack',
      version: '10',
      scope: 'team',
      skills: [createSkill('numeric-skill')],
    });
    assert.deepEqual(
      record.versions.map((item) => item.version),
      ['2', '10']
    );
    const rolledBack = store.rollbackPack({
      name: 'numeric-pack',
      scope: 'team',
    });
    assert.equal(rolledBack?.activeVersion, '2');
  } finally {
    cleanup(tempDir);
  }
}

function testSemverOrdering(): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-pack-store-'));
  try {
    const store = new SkillPackStore(tempDir);
    store.publishPack({
      name: 'semver-pack',
      version: '1.2.0',
      scope: 'team',
      skills: [createSkill('semver-skill')],
    });
    const record = store.publishPack({
      name: 'semver-pack',
      version: '1.10.0',
      scope: 'team',
      skills: [createSkill('semver-skill')],
    });
    assert.deepEqual(
      record.versions.map((item) => item.version),
      ['1.2.0', '1.10.0']
    );
    const rolledBack = store.rollbackPack({
      name: 'semver-pack',
      scope: 'team',
    });
    assert.equal(rolledBack?.activeVersion, '1.2.0');
  } finally {
    cleanup(tempDir);
  }
}

testNumericVersionOrdering();
testSemverOrdering();
console.log('skill-pack-store tests passed');
