# Contributing

DPAgent uses GitHub flow for public collaboration.

1. Fork or branch from `main`.
2. Keep changes focused on one behavior, doc area, or bug fix.
3. Run the closest checks before opening a PR.
4. Open a GitHub pull request with the problem, approach, tests, and risk notes.
5. Keep secrets, local config, runtime outputs, and generated artifacts out of commits.

## Common Checks

```bash
npm install
npm run build
npm run build:web
npm test
```

For narrow changes, run the closest package script, for example:

```bash
npm run test:toolset-registry
npm run test:execution-tool-registry-gating
```

## Branches And Commits

Use clear branch names such as `fix/safe-default-toolset` or `docs/threat-model`. Commit sign-off is welcome when required by your organization, but Gerrit `Change-Id` footers are not part of the public GitHub contribution path.

## Documentation

Update docs when changing user-visible behavior, configuration, commands, security boundaries, or release flow. Current docs live under `doc/`; do not add current behavior docs under a legacy `docs/` tree.

## Pull Request Checklist

- The PR states the user-visible change.
- Tests or verification commands are listed.
- New defaults are safe for public users.
- No local `config.yaml`, logs, runtime state, or private registry defaults are included.
- Security-sensitive changes mention toolset, shell, MCP, or remote access impact.
