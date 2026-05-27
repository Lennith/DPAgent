# Internal NPM Publish

This page is a DPVR maintainer note for private mirrors. It is not part of the public GitHub contribution or release path.

The public repository no longer defines `publish:standard`, `publish:standard:preflight`, or private-registry npm scripts. Public source and npm release flow lives in:

- [GitHub release](../playbook/github-release.md)
- [NPM official publish](../playbook/npm-official-publish.md)

Private mirrors should keep mirror-specific registry URLs, credentials, package names, and publish commands outside the public source tree. If a mirror still needs the historical private publish gate, keep that wrapper in the mirror configuration and do not add private registry defaults back to `package.json`, `.npmrc`, or public docs.

Public packages must not include:

```text
runtime/
sessions/
contexts/
logs/
workspace/
config.yaml
release-toolcall-profiles.dev.json
release-toolcall-profiles.local.json
.env
```

