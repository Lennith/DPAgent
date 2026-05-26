# Session Origin And Observe-only

## Purpose
DPAgent can be driven from Web, CLI, or automation. The product must make
session ownership visible and prevent one surface from mutating another
surface's active run.

## Concepts
- Session origin: the surface that created or last classified the session for display.
- Run owner: the surface that owns the active run right now.
- Observe-only: a Web interaction state used when an active run is owned by CLI or automation.
- Web-owned active run: a running Web session that remains configurable for the next turn.

## Surface Rules
Web sessions are fully interactive when idle. During a Web-owned active run, the
user may edit the next message draft, change session model selection, adjust
Ralph configuration, and turn Ralph on. These changes do not affect the LLM call
already in flight; they apply to the next manual turn or automatic continuation.

CLI sessions must remain observable from Web. When a CLI-owned run is active,
Web displays the transcript and runtime state but disables mutating actions:
chat send, cancel, delete, rename, model changes, plan exit, Ralph stop/start,
and session settings writes.

Automation-owned runs follow the same Web observe-only product rule as CLI-owned
runs. They do not require a browser to remain open.

## Composer Rules
- During a Web-owned active run, the textarea remains editable as next-turn draft storage.
- The send button remains Stop while the run is active.
- Pressing Enter during an active run must not start a concurrent run in the same session.
- Canceling, hydrating, and observe-only states make the composer read-only.

## Model And Ralph Rules
Session LLM selection is a session-level preference. A Web-owned active run may
save it for later use, but the current provider request is not replaced.

Ralph settings use the existing auto-loop API. Turning Ralph on during a
Web-owned active run schedules the Ralph continuation after the current run
finishes, unless an unfinished Todo or Plan execution loop has higher priority.

## UI Visibility
The session list and active session header must distinguish Web, CLI, and
automation origins. Observe-only state should be visible enough that the user
understands why controls are disabled.

Runtime errors and interrupted artifacts are transcript information, not sticky
modal state. If a next run starts, stale interrupted or canceled error cards
should be suppressed.

## Acceptance Checks
- Web-owned active run: textarea, model selection, and Ralph controls remain usable; send remains Stop.
- CLI-owned active run: Web cannot mutate, cancel, or send; transcript remains observable.
- Automation-owned active run: Web is observe-only and the run continues without a browser.
- LLM/Ralph changes made during a Web run apply to the next turn or continuation.
- Canceling and hydrating states remain locked.
