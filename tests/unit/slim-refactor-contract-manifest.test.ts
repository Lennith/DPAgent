import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  getTestManifestEntries,
  REQUIRED_SLIM_REFACTOR_CONTRACT_TAGS,
  TEST_MANIFEST,
} from '../test-manifest.js';

const ROOT = process.cwd();

function listFiles(dir: string, suffix: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir))
    .filter((name) => name.endsWith(suffix))
    .sort()
    .map((name) => `${dir}/${name}`);
}

function testManifestEntriesAreUniqueAndRunnable(): void {
  const seen = new Set<string>();
  for (const entry of TEST_MANIFEST) {
    assert.equal(seen.has(entry.id), false, `duplicate manifest id ${entry.id}`);
    seen.add(entry.id);
    assert.equal(entry.files.length > 0, true, `${entry.id} has no file contract`);
    for (const file of entry.files) {
      assert.equal(fs.existsSync(path.join(ROOT, file)), true, `${entry.id} missing ${file}`);
    }
    assert.equal(entry.command.startsWith('tsx tests/'), true, `${entry.id} must run a concrete test file`);
  }
}

function testUnitManifestIncludesEveryUnitTestFile(): void {
  assert.deepEqual(
    getTestManifestEntries('unit').flatMap((entry) => entry.files).sort(),
    listFiles('tests/unit', '.test.ts')
  );
}

function testIntegrationAndE2eManifestIncludesKnownFiles(): void {
  assert.deepEqual(
    getTestManifestEntries('integration').flatMap((entry) => entry.files).sort(),
    listFiles('tests/integration', '.test.ts')
  );
  assert.deepEqual(
    getTestManifestEntries('e2e').flatMap((entry) => entry.files).sort(),
    listFiles('tests/e2e', '.e2e.ts')
  );
}

function testSlimRefactorContractTagsAreFrozen(): void {
  const tags = new Set(TEST_MANIFEST.flatMap((entry) => entry.tags));
  for (const tag of REQUIRED_SLIM_REFACTOR_CONTRACT_TAGS) {
    assert.equal(tags.has(tag), true, `missing required slim-refactor contract tag ${tag}`);
  }
}

function testPackageScriptsUseManifestRunnerWithoutDroppingDefaultContracts(): void {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  assert.equal(pkg.scripts?.test, 'npm run test:unit && npm run test:integration:default');
  assert.equal(pkg.scripts?.['test:unit'], 'tsx scripts/run-test-manifest.ts unit');
  assert.equal(pkg.scripts?.['test:integration'], 'tsx scripts/run-test-manifest.ts integration');
  assert.equal(pkg.scripts?.['test:integration:default'], 'tsx scripts/run-test-manifest.ts integration --tag default-test');
  assert.ok(
    getTestManifestEntries('integration').some((entry) =>
      entry.id === 'integration:p0-session-transcript-search' && entry.tags.includes('default-test')
    )
  );
  assert.ok(
    getTestManifestEntries('integration').some((entry) =>
      entry.id === 'integration:p1-session-toolset-override' && entry.tags.includes('default-test')
    )
  );
  assert.ok(
    getTestManifestEntries('integration').some((entry) =>
      entry.id === 'integration:p2-governance-lifecycle' && entry.tags.includes('default-test')
    )
  );
}

testManifestEntriesAreUniqueAndRunnable();
testUnitManifestIncludesEveryUnitTestFile();
testIntegrationAndE2eManifestIncludesKnownFiles();
testSlimRefactorContractTagsAreFrozen();
testPackageScriptsUseManifestRunnerWithoutDroppingDefaultContracts();

console.log('slim-refactor-contract-manifest tests passed');
