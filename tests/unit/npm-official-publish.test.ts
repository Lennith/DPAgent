import * as assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildOfficialPublishArgs,
  createPlan,
  getNpmOfficialPublishConfig,
  normalizeOfficialPackageName,
  sanitizePackageJsonForOfficial,
} = require('../../scripts/npm-official-publish.js') as {
  buildOfficialPublishArgs: (
    publishTarget: string,
    cfg: { registry: string; access: string },
    publishTag?: string
  ) => string[];
  createPlan: (
    mode: 'preflight' | 'publish',
    publishTag?: string,
    options?: { skipReleaseGate?: boolean }
  ) => {
    verifyReleaseEvidence: boolean;
    buildBeforePublish: boolean;
    packagedSmoke: boolean;
    registrySmoke: boolean;
    publish: boolean;
    publishTag?: string;
  };
  getNpmOfficialPublishConfig: (
    pkg: Record<string, unknown>,
    internalCfg: {
      userSmoke: unknown;
      requiredPackPaths: string[];
      forbiddenPackPaths: string[];
      releaseE2EGate: unknown;
      releaseToolcallGate: unknown;
    }
  ) => {
    packageName: string;
    registry: string;
    access: string;
    userSmoke: unknown;
    requiredPackPaths: string[];
    forbiddenPackPaths: string[];
  };
  normalizeOfficialPackageName: (value: unknown) => string;
  sanitizePackageJsonForOfficial: (
    pkg: Record<string, unknown>,
    cfg: { packageName: string; registry: string; access: string }
  ) => Record<string, unknown>;
};

function baseInternalConfig() {
  return {
    userSmoke: {
      command: 'npx dpagent --no-open',
      timeoutMs: 120000,
      successPattern: 'Starting web server',
    },
    requiredPackPaths: ['dist/', 'README.md'],
    forbiddenPackPaths: ['runtime/', 'logs/', '.env'],
    releaseE2EGate: {
      outputRoot: 'logs/release-gate-e2e',
    },
    releaseToolcallGate: {
      outputRoot: 'logs/release-gate-toolcall-context-session',
    },
  };
}

function testOfficialPublishConfigUsesPublicNpmRegistry(): void {
  const cfg = getNpmOfficialPublishConfig(
    {
      npmOfficialPublish: {
        packageName: '@lennith/dpagent',
        registry: 'https://registry.npmjs.org',
        access: 'public',
      },
    },
    baseInternalConfig()
  );

  assert.equal(cfg.packageName, '@lennith/dpagent');
  assert.equal(cfg.registry, 'https://registry.npmjs.org');
  assert.equal(cfg.access, 'public');
  assert.deepEqual(cfg.requiredPackPaths, ['dist/', 'README.md']);
  assert.deepEqual(cfg.forbiddenPackPaths, ['runtime/', 'logs/', '.env']);
}

function testOfficialPublishConfigRejectsPrivateRegistry(): void {
  assert.throws(
    () =>
      getNpmOfficialPublishConfig(
        {
          npmOfficialPublish: {
            packageName: '@lennith/dpagent',
            registry: 'http://10.100.1.10:4873',
            access: 'public',
          },
        },
        baseInternalConfig()
      ),
    /registry must be https:\/\/registry\.npmjs\.org/i
  );
}

function testOfficialPackageNameMustBeScoped(): void {
  assert.equal(normalizeOfficialPackageName('@lennith/dpagent'), '@lennith/dpagent');
  assert.throws(() => normalizeOfficialPackageName('dpagent'), /scoped npm package name/i);
  assert.throws(() => normalizeOfficialPackageName('@lennith/'), /scoped npm package name/i);
}

function testOfficialPackageJsonIsSanitized(): void {
  const sanitized = sanitizePackageJsonForOfficial(
    {
      name: '@dpvr/dpagent',
      version: '2.2.12',
      description: 'DPAgent toolkit',
      main: 'dist/index.js',
      types: 'dist/index.d.ts',
      bin: {
        dpagent: 'dist/cli/dpagent.js',
      },
      dependencies: {
        express: '^4.18.2',
      },
      devDependencies: {
        typescript: '^5.3.0',
      },
      scripts: {
        'publish:private': 'npm publish --registry http://10.100.1.10:4873',
      },
      publishConfig: {
        registry: 'http://10.100.1.10:4873',
      },
      internalPublish: {
        registry: 'http://10.100.1.10:4873',
      },
    },
    {
      packageName: '@lennith/dpagent',
      registry: 'https://registry.npmjs.org',
      access: 'public',
    }
  );

  assert.equal(sanitized.name, '@lennith/dpagent');
  assert.equal((sanitized.publishConfig as { registry: string }).registry, 'https://registry.npmjs.org');
  assert.equal((sanitized.publishConfig as { access: string }).access, 'public');
  assert.deepEqual(sanitized.dependencies, { express: '^4.18.2' });
  assert.equal(Object.hasOwn(sanitized, 'internalPublish'), false);
  assert.equal(Object.hasOwn(sanitized, 'scripts'), false);
  assert.equal(Object.hasOwn(sanitized, 'devDependencies'), false);
}

function testOfficialPublishPlanAndArgs(): void {
  assert.deepEqual(createPlan('preflight'), {
    verifyReleaseEvidence: true,
    buildBeforePublish: true,
    packagedSmoke: false,
    registrySmoke: false,
    publish: false,
    publishTag: undefined,
  });
  assert.deepEqual(createPlan('publish', 'beta'), {
    verifyReleaseEvidence: true,
    buildBeforePublish: true,
    packagedSmoke: true,
    registrySmoke: true,
    publish: true,
    publishTag: 'beta',
  });
  assert.equal(createPlan('publish', undefined, { skipReleaseGate: true }).verifyReleaseEvidence, false);
  assert.deepEqual(
    buildOfficialPublishArgs(
      'pkg.tgz',
      {
        registry: 'https://registry.npmjs.org',
        access: 'public',
      },
      'beta'
    ),
    ['publish', 'pkg.tgz', '--registry', 'https://registry.npmjs.org', '--access', 'public', '--tag', 'beta']
  );
}

function runAll(): void {
  testOfficialPublishConfigUsesPublicNpmRegistry();
  testOfficialPublishConfigRejectsPrivateRegistry();
  testOfficialPackageNameMustBeScoped();
  testOfficialPackageJsonIsSanitized();
  testOfficialPublishPlanAndArgs();
  console.log('npm-official-publish tests passed');
}

runAll();
