# DPAgent Release Notes: 2.3.1

## Highlights

- Polish Arena transcript readability with a dedicated source-history entry and branch detail log view.
- Sanitize Arena branch detail transcripts on the server so hidden branch thinking, tool calls, and tool results are not exposed through the read-only API.
- Improve Arena mobile source-history sheet layering and rounded styling.
- Adjust desktop user prompt bubble width for better Arena log readability.
- Add user-guide coverage for session Fork and Arena, including winner proposal/apply flow.
- Fix Arena no-git workspace branch preparation for workspaces containing symlinks.
- Add Settings-gated Workspace Timeline test capture that stores turn deltas in runtime CAS without creating Git-visible checkpoint commits; when enabled, the API-only rollback route can restore retained blob-backed revisions and records the resulting context patch metadata.

## Verification Scope

- Verified normal Arena and finalized-plan Arena E2E with DeepSeek Flash, MiniMax M2.7, and Mimo v2.5.
- Added a duel-style Arena route regression that applies the selected winner's frontend edits back to the source workspace while leaving loser-only files out.
- Added Workspace Timeline store/route coverage for add/modify/delete capture, Git-observed non-mutating behavior, unborn repos, 5-stage retention, committed context metadata, rollback apply boundaries, and continuous rollback/forward restore E2E.
- Ran targeted Arena route/UI/workspace tests, session fork, execution tool registry gating, web chat message tests, build, web build, and npm pack dry run.
