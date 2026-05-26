import { isDirectCliInvocation } from './lib/script-cli-utils.js';
import { parseManifestRunnerArgs, runManifest } from './lib/test-manifest-runner.js';

function main(): void {
  runManifest(parseManifestRunnerArgs(process.argv.slice(2)));
}

if (isDirectCliInvocation(import.meta.url)) {
  main();
}
