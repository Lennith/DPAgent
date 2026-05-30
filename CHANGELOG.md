# Changelog

## 2.3.1

- Polished Arena transcript readability with source-history and branch detail log improvements.
- Sanitized Arena branch detail transcripts on the server to avoid exposing hidden branch thinking, tool calls, and tool results.
- Improved mobile source-history sheet layering and rounded styling.
- Adjusted desktop user prompt bubble width for better Arena log readability.

## 2.2.15

- Added provider vendor dialect policies for Xiaomi MiMo, DeepSeek, Anthropic, and official MiniMax/OpenAI-compatible routing.
- Enabled Xiaomi MiMo Anthropic replay of unsigned thinking blocks while keeping signed-thinking replay required for standard Anthropic.
- Added Xiaomi MiMo OpenAI-compatible reasoning request/replay handling without changing other provider protocol shapes.
- Hardened provider endpoint host matching so official gateways and vendor-specific domains stay isolated.
- Added Xiaomi to the release toolcall context gate and pinned the release eval to a write-capable toolset for GitHub-safe defaults.

## 2.2.14

- Migrated the public repository baseline to DPAgent with MIT licensing.
- Removed private registry defaults from public package configuration.
- Replaced committed local `config.yaml` with `config.example.yaml` and ignored real local config.
- Changed the default runtime toolset to `windows-safe` and disabled shell, web, and MCP by default.
- Added public GitHub contribution, security threat model, CI, and release documentation.
