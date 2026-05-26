# DPAgent

DPAgent is DPVR's dedicated local-first Agent runtime. It packages a
TypeScript/Node.js agent core, Web UI, CLI, context storage, tool system, MCP
integration, memory, skills, subagents, automation, Todo governance, and release
gates into one runtime for DPVR product, engineering, operations, and AI
workflow automation scenarios.

DPAgent is released under the MIT License.

## What It Is

DPAgent is designed as a DPVR-specific Agent platform rather than a generic chat
demo. It focuses on repeatable local workflows, auditable tool execution,
provider-pluggable LLM calls, and long-running task context that can be reused
across engineering and operations work.

Core capabilities:

- Local Web UI and CLI entrypoint for daily Agent work.
- Event-sourced session context with replay, compression, and recovery.
- LLM provider adapters for OpenAI-compatible, Anthropic, MiniMax, and DeepSeek
  style profiles.
- Tool system with permission controls, file/shell/context/memory/todo tools,
  and governed toolset presets.
- MCP integration and shared runtime pooling.
- Subagents, skills, automation scheduling, Plan Mode, Todo governance, and
  release gates.
- DPVR-oriented assistant profiles and packaged skills for setup, debugging,
  update, hooks, user guide generation, and share-client workflows.

## Quick Start

Requirements:

- Node.js 18 or newer.
- npm.
- A provider profile or local configuration for the LLM service you want to use.

Run from source:

```bash
npm install
npm run dev:web
```

Build and start the bundled Web server:

```bash
npm run build:web
npm run start:web
```

Use the CLI after build:

```bash
npm run build
npx dpagent
```

Windows easy-run bundle:

```bat
Run-DPAgent.bat
```

## Common Commands

```bash
npm run build
npm run build:web
npm test
npm run smoke:ui
npm run release:source-gate
```

## Documentation

`doc/` is the current documentation baseline. Start with:

- [Documentation index](doc/README.md)
- [User guide](doc/guide/user-guide.md)
- [Product baseline](doc/prd/product-baseline.md)
- [Architecture baseline](doc/spec/architecture-baseline.md)
- [Code module index](doc/code/README.md)
- [Development playbook](doc/playbook/development-playbook.md)
- [Release gate overview](doc/playbook/release-gate-overview.md)
- [NPM official publish](doc/playbook/npm-official-publish.md)

Do not use the removed legacy `docs/` tree as a current behavior source.

## Repository Layout

```text
src/              Runtime, CLI, tools, providers, server, and Web client.
tests/            Unit, integration, and E2E tests.
agents/           DPAgent assistant and specialist agent profiles.
dpai-skills/      Packaged DPVR/DPAgent skills.
scripts/          Build, release, smoke, diagnostic, and evaluation scripts.
doc/              Current product, guide, design, spec, code, and playbook docs.
android-client/   Android companion client source.
plugin/           Hook and plugin examples.
```

Runtime outputs such as `dist/`, `logs/`, `runtime/`, `contexts/`,
`workspace/`, `workspace-smoke-default/`, and `ux-workspace/` are not source
artifacts for normal commits or GitHub uploads.

## Package Notes

The package name is `@dpvr/dpagent` and the CLI binary is `dpagent`.

Internal package publishing uses DPVR's private registry configuration in
`package.json`. Public GitHub source distribution is covered by the MIT License;
follow the release playbooks before publishing packages.

## License

MIT. See [LICENSE](LICENSE).
