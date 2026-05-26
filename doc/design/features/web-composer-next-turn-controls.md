# Web Composer Next-turn Controls

## Purpose
The composer remains useful while a Web-owned run is active. The user can
prepare the next turn and future continuation settings without interrupting the
provider request already in flight.

## Editable During Web-owned Active Runs
When the active run owner is Web and the session is not canceling or hydrating:

- textarea draft is editable
- session LLM selection can be changed
- Ralph settings can be changed
- Ralph can be enabled for the next eligible continuation

These changes are future-effective. They do not replace the current LLM call,
current tool loop, or current provider selection already sent to the backend.

## Send And Stop
The send button is content-sensitive during a Web-owned active run:

- with a non-empty draft, the button is Send and emits `running_input_enqueue`
- with an empty draft, the button is Stop and cancels only the current Web-owned run

Running input is not a second concurrent `chat` run. The backend stores it in a
memory-only session/run queue. FIFO queue items become ordinary user turns after
the current run ends and Todo/Plan automatic continuation is idle.
File-reference chips submitted with a running input item are stored with that
queue item and applied when it becomes the next turn or is inserted into the
current turn.

Each queue item also exposes an Insert action. Insert marks the item for current
run injection, but the backend consumes it only at a safe checkpoint after tool
results are fully appended and before the next LLM request is prepared. Insert
does not interrupt an in-flight provider stream.

Each queued item also exposes Edit and Cancel. Edit restores the queued prompt
to the composer and removes the pending queue item, so the user can adjust and
send it again. Cancel removes only the pending queue item.

Pressing Enter while a run is active sends the non-empty draft to the running
input queue. An empty draft keeps the Stop behavior.

## Locked States
The composer and next-turn controls are read-only when:

- the session is observe-only
- cancellation is in progress
- hydration is in progress
- the active run is owned by CLI or automation

## Model Selection
Changing model selection during a Web-owned run patches session state. The next
manual turn or automatic continuation reads the latest saved selection.

## Ralph Controls
Ralph controls use the auto-loop API. Enabling Ralph during a Web-owned active
run means the current run finishes first, then the continuation policy decides
whether Ralph can run. Unfinished Todo or Plan execution work has priority over
running-input queued turns.

## Acceptance Checks
- Active Web run with draft: Send enqueues running input.
- Active Web run without draft: button is Stop.
- Active Web run: model change and Ralph change work.
- Queued item Insert waits for a tool-result checkpoint before entering the current turn.
- Queued item Edit restores the text to the composer and dismisses that pending item.
- Queued item Cancel dismisses that pending item without changing the composer.
- Active CLI or automation run: same controls are disabled.
- Canceling and hydrating lock the same controls.
