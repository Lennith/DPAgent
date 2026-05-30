# DPAgent Release Notes: 2.3.1

## Highlights

- Polish Arena transcript readability with a dedicated source-history entry and branch detail log view.
- Sanitize Arena branch detail transcripts on the server so hidden branch thinking, tool calls, and tool results are not exposed through the read-only API.
- Improve Arena mobile source-history sheet layering and rounded styling.
- Adjust desktop user prompt bubble width for better Arena log readability.

## Verification Scope

- Verified normal Arena and finalized-plan Arena E2E with DeepSeek Flash, MiniMax M2.7, and Mimo v2.5.
- Ran targeted Arena route/UI/workspace tests, session fork, execution tool registry gating, web chat message tests, build, web build, and npm pack dry run.
