#!/usr/bin/env tsx
/* eslint-disable no-console */
import { isDirectCliInvocation } from './lib/script-cli-utils.js';
import { parseReleaseE2EArgs, runReleaseE2EGate } from './lib/release-e2e-gate-core.js';

function main(): void {
  const aggregate = runReleaseE2EGate(parseReleaseE2EArgs(process.argv.slice(2)));
  if (!aggregate.gatePassed) {
    process.exitCode = 1;
  }
}

if (isDirectCliInvocation(import.meta.url)) {
  main();
}
