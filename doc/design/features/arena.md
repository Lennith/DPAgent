# Arena

## Purpose
Arena lets the user run the same source-session context through multiple
contestant agents and models, compare their submitted results, and converge the
source session back to one selected outcome. It is a peer feature to Share and
Fork, but it keeps the source session locked while the Arena is active so that
branch work stays comparable and the final state can be audited.

## User Outcomes
- The user can start an Arena from a stable session or from a finalized plan
  that is waiting for approval.
- Up to four contestants can work from the same context and fair starting workspace.
- Contestants may produce either read-only answers or implementation artifacts.
- The user can inspect branch progress, pause work, request a judge ranking, or choose a winner manually.
- The source session converges to one outcome instead of inheriting every branch transcript.
- The source workspace is changed only after a reviewed proposal and a second confirmation.

## Modes
### Answer Arena
Answer Arena is for questions where the final product is an LLM answer. Branches
receive the same context and prompt, but they do not need writable workspaces.
The selected outcome converges into the source session as:

- winner answer
- judge or manual-selection summary
- branch links and provenance
- closing audit event

No source file changes are proposed.

### Implementation Arena
Implementation Arena is for tasks that may write files, run tests, or produce
code changes. Each branch receives its own Arena workspace. The selected outcome
converges into the source session as:

- winner summary
- changed-file proposal
- apply audit or close-without-apply audit
- branch links and provenance

The source workspace remains locked until the proposal is applied or the Arena
is closed.

## Entry Rules
Arena can start from:

- a normal idle session with no unfinished Todo
- a finalized plan that is waiting for user approval, using the frozen plan as
  the Arena prompt and contract

Arena is disabled when the source session has an active run, pending plan input,
ordinary unfinished Todo, active plan execution, interrupted artifacts,
observe-only state, or share-only permissions.

The finalized-plan case must account for the hidden plan Todo. The plan approval
request is treated as frozen context, not as an unfinished execution Todo that
blocks Arena entry.

## Source Session Lock
Entering Arena places the source session in an Arena-locked state. While locked:

- the normal composer is hidden or replaced by a lock notice
- the main panel renders the Arena panel instead of the normal chat workflow
- the user cannot send a new source-session message
- source rename and non-mutating inspection remain allowed where safe
- mutating actions that would invalidate Arena context are disabled

The lock is released only when the Arena is closed or when the selected outcome
has converged back into the source session. For Answer Arena this means the
winner answer was recorded; for Implementation Arena this means the proposal was
applied.

## Arena State Model
### Arena Run
An Arena run belongs to one source session and records:

- source session namespace and source event count
- entry type: answer, implementation, or finalized-plan
- original prompt or frozen plan reference
- source workspace snapshot information
- contestant configuration
- judge configuration
- status and audit timeline
- selected winner, if any
- convergence status

New Arenas inherit the most recent Arena contestant and judge configuration.
When no history exists, the UI drafts two contestants from the current session
LLM selection and uses the current selection as the judge default.

### Arena Branch
Each contestant is a long-lived Arena branch, not a single attempt. A branch has
its own session namespace, transcript, Todo loop, LLM selection, agent
selection, and workspace when writes are enabled.

Branches are hidden from the normal session list by default. The user may
promote a branch to a normal session. Promotion preserves transcript, workspace,
LLM selection, and Arena provenance, but it does not select that branch as the
winner and does not apply its changes to the source workspace.

### Arena Submission
A branch completes by calling the Arena submission tool. The submission includes
the final answer or implementation summary, evidence, changed-file summary where
applicable, and blocked/completed status.

### Arena Judgement
The judge is configured separately from contestants. It can rank submitted
branches and explain tradeoffs, but it never auto-selects or auto-applies a
winner.

### Arena Merge Proposal
Implementation winners produce a merge proposal before source changes are
applied. The proposal describes changed files, detected conflicts, test
evidence, and safety checks. Applying the proposal requires a second
confirmation.

## Branch Lifecycle
Branch states:

- `draft`: configured but not started
- `preparing`: branch session or workspace is being created
- `running`: branch agent is active
- `paused`: branch work is stopped but can resume
- `submitted`: branch called the submission tool successfully
- `reopened`: a submitted branch was reopened before judge start
- `blocked`: branch submitted a blocked result with evidence
- `failed`: branch failed unexpectedly
- `cancelled`: branch was stopped by Arena pause or close
- `frozen`: judge has started or Arena is resolving
- `promoted`: branch was promoted to a normal session

Submitted branches can be reopened only before the judge starts. Once the judge
starts, submitted branches are frozen.

## Submission Tool
Arena branches get a dedicated `arena_submit_result` tool. The tool is mandatory
for branch completion.

The tool is available only inside Arena branch sessions. It rejects normal
completion while the branch has unfinished Todo unless the branch reports a
blocked result with evidence. This keeps branch completion aligned with the same
execution contract as normal session work.

The tool should record:

- completion status: complete or blocked
- final answer or implementation summary
- evidence and test results
- known risks or unresolved items
- changed-file summary for implementation branches

## Contestants And Judge
Contestant cards configure:

- agent
- provider or LLM profile
- model
- reasoning depth

Contestant configuration intentionally excludes toolset. Answer branches use
the read-heavy Arena-safe toolset. Implementation branches use a hidden
branch-confined file-edit toolset with no shell or delegation so every
contestant competes under the same capability boundary without being able to
write back to the source workspace directly.

Arena supports at most four contestants per run.

The judge configuration is separate and includes provider/profile, model, and
reasoning depth. The judge can be started after enough branches have submitted,
or the user can bypass judging and select a submitted branch manually. Manual
selection must be recorded as `manual_winner`.

## Workspace Isolation
Implementation Arena uses isolated workspaces. The source workspace is
read-only from the branch perspective. Branch prompts must state that agents may
modify only their own Arena workspace and must not write to the source
workspace. V1 enforces this by registering implementation branches with the
branch-confined Arena toolset; running arbitrary shell commands from
implementation branches is out of scope until a stronger workspace sandbox is
available.

For git workspaces, Arena creates special-named worktrees under:

`<workspace-parent>/.dpagent-arena/<sourceSessionName>-arena-<shortId>/<index>-<agentSlug>-<modelSlug>/`

Dirty source workspace state is copied into every branch workspace at start so
that contestants begin from the same files. The copied dirty state is part of
the Arena provenance and must be visible in the audit timeline.

When the current workspace is not a git repository, Arena downgrades to a
directory-copy workspace. Merge proposals then rely on directory diffs and file
hash safety checks instead of git merges.

## Start, Pause, And Close
The configuration phase does not create worktrees or branch sessions. Clicking
Start Arena creates all branch sessions and any required workspaces, then
launches all contestants concurrently.

Pause Arena stops running branches but keeps the Arena open and keeps the source
session locked. The user can resume or close later.

Close Arena ends the Arena and unlocks the source session. If no winner was
selected, the audit timeline records `closed_without_winner`. Closing does not
delete branch transcripts or workspaces.

## Judge, Winner, And Apply
The user may choose a winner from submitted branches before or after judging.
If the judge has not started, submitted branches may still be reopened. Starting
the judge freezes submitted branches.

Selecting an implementation winner creates a proposal; it does not apply files.
Apply performs dirty checks, conflict checks, and file hash validation against
the source workspace. If the source workspace changed after Arena start, apply
must stop and show the conflict or stale-base reason.

Applying requires a second confirmation in the unified application confirm
dialog. After a successful apply, the source session records the selected
outcome and unlocks.

If a winner is selected but its implementation is not applied, the source
session remains locked until the proposal is applied or the Arena is closed.

## Source Convergence
The source session must not absorb every branch transcript. It receives a
compact convergence record:

- Arena prompt or frozen plan reference
- contestant roster and branch links
- judge summary or manual-selection reason
- selected winner
- answer text or implementation proposal summary
- apply or close audit result

Branch transcripts remain available through branch links and promotion, but
they are not appended as normal source conversation turns.

## Web UI
Arena is exposed beside Share and Fork. The button is disabled under the same
entry-rule constraints that prevent Arena start.

When the source session is Arena-locked, the main panel becomes the Arena panel.
The normal composer is hidden. The panel shows status, source session, entry
type, lock notice, and actions for Pause or Resume, Judge now, Close Arena, and
Apply Proposal when available.

Desktop layout prioritizes contestant cards:

- top status and action bar
- two-by-two contestant card grid
- judge panel
- proposal panel
- audit timeline

Mobile layout uses one-column cards and tabs:

- Branches
- Judge
- Proposal
- Timeline

Mobile defaults to Branches and keeps primary actions in a bottom fixed action
area. Text must fit inside controls, and contestant cards should use stable
dimensions so branch status updates do not shift the layout.

All destructive or irreversible Arena actions use the unified application
confirm dialog, not browser-native confirmation.

## API Sketch
Exact DTOs belong in protocol specs, but the product surface needs these
capabilities:

- create Arena from a source session
- update draft contestant and judge configuration
- start Arena
- pause or resume Arena
- pause or resume a branch
- reopen a submitted branch before judge start
- start judge
- select winner manually or from judge-ranked results
- create merge proposal for implementation winner
- apply proposal with confirmation and safety checks
- close Arena
- promote branch to normal session
- fetch Arena state for the locked source panel

## Acceptance Checks
- Arena button appears beside Share and Fork and is disabled for active,
  observe-only, interrupted, or unfinished-Todo sessions.
- Starting Arena from an idle source creates at most four concurrent branches.
- Starting Arena from a finalized pending plan uses the frozen plan as the
  branch contract.
- Source session becomes locked and the main panel switches to Arena UI.
- Branches can only complete through `arena_submit_result`.
- A branch with unfinished Todo cannot submit complete status.
- Judge ranking never auto-selects or auto-applies a winner.
- Manual winner selection records `manual_winner`.
- Implementation winner produces a proposal before apply.
- Apply refuses stale source workspace state or detected conflicts.
- Source convergence records one selected outcome, not all transcripts.
- Mobile Arena UI supports branch monitoring and primary actions without
  overlapping controls.

## Risks And Open Questions
- Concurrent model runs can increase API cost and rate-limit pressure.
- Concurrent branches can consume significant CPU, disk, and tool resources.
- Copying dirty source state improves fairness but can make merge provenance
  harder to explain.
- Directory-copy fallback cannot provide git-quality conflict detection.
- Long-lived branches may outlive the source user's intent; close and cleanup
  policies need operational limits.
- Worktree cleanup should be explicit and auditable so branch evidence is not
  lost unexpectedly.
- Future multi-round Arena prompts may need branch-to-source context sync
  rules; v1 keeps source locked and does not sync new source turns.

## Phased Implementation
### Phase 1: Arena Shell And Answer Arena
- Add Arena run model, source lock, Web entry button, Arena panel, config
  inheritance, branch sessions, and answer-mode submission.
- Add judge ranking and manual winner audit.
- Add source convergence for answer results.

### Phase 2: Implementation Branch Isolation
- Add git worktree creation, directory-copy fallback, dirty-state replication,
  branch prompt isolation rules, and branch workspace provenance.
- Add branch Todo integration and mandatory `arena_submit_result` validation.

### Phase 3: Proposal And Apply
- Add changed-file proposal generation, stale-base checks, conflict checks, file
  hash validation, apply confirmation, and source convergence for applied or
  closed implementation outcomes.

### Phase 4: Operational Polish
- Add branch promotion UI, cleanup policy, richer timeline, mobile UX pass, and
  load/cost controls if real usage shows resource contention.
