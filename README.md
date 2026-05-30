# DPAgent

[![CI](https://github.com/Lennith/DPAgent/actions/workflows/ci.yml/badge.svg)](https://github.com/Lennith/DPAgent/actions/workflows/ci.yml)

DPAgent is DPVR's dedicated local-first Agent runtime for repository-aware work. It combines a Node.js agent core, Web UI, context/event storage, governed tools, MCP, memory, skills, subagents, automation, and release gates for DPVR engineering and operations workflows.

DPAgent is released under the MIT License.

## Core Problem

DPAgent gives teams a controllable local Agent that can read a workspace, keep durable task context, propose plans, and execute tools under explicit capability presets. The default posture is conservative: new users start on `windows-safe`, with read-heavy file tools and no shell, write, web, or MCP execution unless they opt in.

Use DPAgent when you need:

- A repo-aware Agent that can inspect code and maintain long-running context.
- A Web UI and CLI that share the same local runtime and session store.
- Auditable tool execution with named toolsets instead of all-access defaults.
- DPVR-specific profiles, skills, governance, and release checks in one repository.

## Platform Status

DPAgent has been tested on the three mainstream desktop/server platforms: Windows, macOS, and Linux. The runtime target is Node.js 18 or newer.

Windows remains the most exercised local workflow because DPVR's current daily usage includes PowerShell, batch launchers, and Windows easy-run helpers. On macOS or Linux, use the same Node.js commands and adjust local shell configuration when enabling shell tools.

## Minimal Path

### Five-Minute Demo

1. Install dependencies.

```bash
npm install
```

2. Create local config from the safe example and add your provider key.

```bash
cp config.example.yaml config.yaml
```

On Windows PowerShell:

```powershell
Copy-Item config.example.yaml config.yaml
```

Edit `config.yaml` and set `llmProfiles.profiles[0].apiKey`.

3. Start the Web UI.

```bash
npm run dev:web
```

4. Open the local UI shown by the dev server and ask DPAgent to inspect a repository, for example:

```text
Read this repo and produce a change plan for the README and default security posture. Use only read-only tools first.
```

5. Keep the first turn on `windows-safe`. The Agent can read, glob, grep, manage context, search prior sessions, use Todo, and draft a plan without shell/write access.

6. When you are ready to allow implementation, explicitly opt in. Change `agent.defaultToolset` to `windows-dev` and set `tools.enableShell: true` only for a trusted local workspace, or select an equivalent restricted toolset in the UI when available.

### Build And Run

```bash
npm run build
npm run build:web
npm run start:web
```

### CLI

```bash
npm run build
npx dpagent
```

## Advanced Matrix

| Area | What DPAgent Provides | Default Exposure |
| --- | --- | --- |
| Context runtime | Event-sourced sessions, replay, compression, recovery | Enabled |
| Toolsets | `windows-safe`, `windows-dev`, `research`, hidden `full-access` | `windows-safe` |
| File tools | Read/glob/grep by default; write/edit only by opt-in toolset | Read-heavy |
| Shell | PowerShell execution with guardrails but no OS sandbox | Off by default |
| Web tools | Search/fetch capabilities for research workflows | Off by default |
| MCP | Stdio MCP server integration and shared runtime pooling | Off by default |
| Skills | Bundled, global, workspace, and agent-scoped skills | Catalog only by default |
| Memory | Workspace/user/session memory and promotion workflows | Enabled |
| Subagents | Specialist profiles and delegated execution | Toolset-limited |
| Automation | Scheduled follow-ups and runtime jobs | Opt-in toolset |
| Web UI | Chat, settings, workspace governance, remote auth, ASR hooks | Local-first |
| Release gates | Build, tests, smoke, E2E, toolcall context gates | Maintainer-run |

## Known Limitations

- DPAgent is DPVR-first. It is open source and usable outside DPVR, but bundled profiles, examples, and some terminology are optimized for DPVR engineering and operations.
- DPAgent is local-first. It is not a hosted SaaS, not a multi-tenant service, and not a security sandbox.
- Shell, MCP, write tools, automation, and `full-access` are intentionally opt-in because they can execute code or change local files.
- Some helper scripts are Windows-oriented. Cross-platform runtime paths work through Node.js, but shell examples and local launchers may need platform-specific adjustment.
- Full release gates may require maintainer credentials, browser dependencies, and provider profiles. External contributors can still run `npm run build`, `npm run build:web`, and `npm test`.
- GitHub Release evidence should be attached to real releases. Until a release exists for a version, treat `main` plus CI as source verification rather than a published artifact.

## Security Boundary

Read [SECURITY.md](SECURITY.md) before enabling shell, write tools, MCP servers, remote access, or `full-access`. DPAgent is a local automation runtime, not a sandbox. Shell commands inherit the process environment and can affect the host with the same privileges as the user running DPAgent.

## Documentation

`doc/` is the current documentation baseline. Start with:

- [Configuration](CONFIG.md)
- [Security threat model](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Support policy](SUPPORT.md)
- [Documentation index](doc/README.md)
- [User guide](doc/guide/user-guide.md)
- [Product baseline](doc/prd/product-baseline.md)
- [Architecture baseline](doc/spec/architecture-baseline.md)
- [Development playbook](doc/playbook/development-playbook.md)
- [GitHub release playbook](doc/playbook/github-release.md)
- [NPM official publish](doc/playbook/npm-official-publish.md)

Do not use the removed legacy `docs/` tree as a current behavior source.

## Repository Layout

```text
src/              Runtime, CLI, tools, providers, server, and Web client.
tests/            Unit, integration, and E2E tests.
agents/           DPAgent assistant and specialist agent profiles.
scripts/          Build, release, smoke, diagnostic, and evaluation scripts.
doc/              Current product, guide, design, spec, code, and playbook docs.
android-client/   Android companion client source.
plugin/           Hook and plugin examples.
```

Runtime outputs such as `dist/`, `logs/`, `runtime/`, `contexts/`, `workspace/`, `workspace-smoke-default/`, and `ux-workspace/` are not source artifacts for normal commits or GitHub uploads.

## License

MIT. See [LICENSE](LICENSE).
