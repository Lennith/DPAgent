# Windows Easy-run Handoff

## Purpose
The Windows easy-run bundle is for users who want a direct local startup path
without working inside the source repository.

## User Entry
Run:

```bat
Run-DPAgent.bat
```

The bundle starts the local Web server and attempts to open:

```text
http://localhost:53721
```

## Expected Bundle Contents
The bundle must include the built server/client and startup files needed by the
packaging script, including:

```text
Run-DPAgent.bat
start-easy.js
dist/
README.md
```

The bundle may create local runtime files on first run.

## Runtime Outputs
Easy-run may create:

```text
config.yaml
contexts/
runtime/
logs/
workspace/
```

These are user-local outputs, not source artifacts.

## Common Issues
- Browser did not open: manually visit `http://localhost:53721`.
- Port `53721` is in use: stop the existing process or configure another port.
- API key missing: open Settings and save provider credentials.
- Access denied: move the bundle to a user-writable directory.

## Handoff Rule
Do not use old `docs/WINDOWS_EASY_RUN.md` content as the source of truth. This
document is the current easy-run handoff specification.
