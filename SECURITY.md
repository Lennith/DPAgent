# Security Policy

## Threat Model

DPAgent is a local automation runtime, not a sandbox. It can be configured to read files, write files, run shell commands, start MCP servers, and expose a Web UI. Treat it as code execution under the account that starts the process.

## Main Boundaries

- Shell is not sandboxed. `shell_execute` runs through the configured host shell and has the same OS privileges as the DPAgent process.
- Shell commands inherit environment variables unless the host shell or command changes that behavior. Tokens in the environment may be visible to child processes.
- `full-access` disables workspace sandbox checks and allows unknown MCP tools. It is a maintainer escape hatch, not a beginner default.
- MCP servers are executable processes. A malicious or compromised MCP server can perform actions outside DPAgent's tool descriptions.
- File write/edit tools can modify the configured workspace and any extra writable paths granted by runtime policy.
- Remote access expands the trust boundary from loopback to the network. Enable it only with authentication and a trusted network path.

## Safer Operation

Start with `windows-safe`. Use it for repository reading, plan generation, grep/glob, context management, memory lookup, Todo planning, and read-only reviews.

Only opt in to `windows-dev` when the user approves implementation in a trusted workspace. Enable `tools.enableShell: true` only when shell is required and the command has been inspected.

Use `research` only when web access is needed. Keep MCP disabled until the server command, package source, and required environment variables are known.

Avoid committing:

- `config.yaml`
- API keys, npm tokens, cookies, session secrets, or remote auth passwords
- `runtime/`, `contexts/`, `sessions/`, `logs/`, `workspace/`, and build outputs

## Reporting

For public GitHub use, open a private security advisory or contact the maintainers before publishing exploit details. Include affected version, configuration, toolset, reproduction steps, and whether shell, MCP, or remote access was enabled.
