---
name: dpagent-share-client
description: Connect to a DPAgent share link as an external AI client, fetch text-only session history, send a text prompt, and return only the DPAgent text reply.
---

# DPAgent Share Client

Use this skill when you need to join a DPAgent shared session through a `/dpagent-share/<token>` link.

You are talking to another agent. Treat its answers as useful but fallible:
ask for concrete evidence, exact file paths, commands run, logs, or test output
when the task depends on correctness. Do not treat unsupported claims as proof.

You may ask the DPAgent session to send files to the user. For multiple files,
ask it to create a zip archive and send that zip. Download links returned by the
server are included in the `ask` output under `Files:`. When `--download-dir`
is set, returned files are saved locally and listed under `Downloaded files:`.

The client has two operations:

- Get recent text history:
  ```bash
  node skills/dpagent-share-client/scripts/dpagent_share_client.mjs get_history --share-link <share-link> --turns 3
  ```
- Ask DPAgent one text prompt and wait for the final text answer:
  ```bash
  node skills/dpagent-share-client/scripts/dpagent_share_client.mjs ask --share-link <share-link> --text "<prompt>"
  ```
- Ask DPAgent to send a file or zip and download returned file links:
  ```bash
  node skills/dpagent-share-client/scripts/dpagent_share_client.mjs ask --share-link <share-link> --text "Create hello.py, send it to me, and cite the exact path." --download-dir <local-dir>
  ```

Default history depth is 3 turns. History contains only user and assistant body text. It excludes thinking, tool calls, tool results, and runtime events.

For `ask`, return the script output directly as DPAgent's answer. Do not echo fetched history unless the user explicitly asked for it.
