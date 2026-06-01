# Workspace Timeline

## Purpose
Workspace Timeline is the shared workspace-change substrate for normal
sessions, Fork, Arena, and future rollback. It records file-system changes as
turn-scoped deltas instead of treating an Arena branch directory or the current
working tree as the only durable state.

The first implementation is an explicit test feature exposed as a checkbox in
Web Settings -> Other. It is off by default. It is not a full virtual file
system. It is an append-only, trust-rated workspace change ledger with safe
apply/revert primitives. Later releases may make materialized workspaces
disposable execution caches, but that must wait until capture, transaction, and
materialization boundaries are fully reliable.

## User Outcomes
- Users can see which files a session turn changed.
- Arena can create proposals from the selected branch delta chain instead of
  scanning or copying a whole repository.
- Fork can share a stable workspace revision pointer without copying the source
  workspace immediately.
- Rollback can restore a session to an earlier context/workspace state without
  deleting historical events.
- Large repositories avoid whole-workspace copy/hash work in the common path.

## Non-Goals
- Do not implement a kernel-level virtual file system in the first release.
- Do not promise automatic rollback for untrusted shell, MCP, or external
  process writes until those writes are captured with sufficient confidence.
- Do not rewrite or truncate committed context event logs.
- Do not auto-merge conflicts or overwrite external user edits.
- Do not remove Arena's current workspace isolation until the new timeline path
  has equivalent safety tests.

## Terms
### Workspace Revision
A `WorkspaceRevision` is a named state node for a workspace. It records the
workspace root, parent revision, repository kind, capture trust, and enough
identity data to verify later apply/revert operations.

### Turn Workspace Delta
A `TurnWorkspaceDelta` is the file change set produced by one DPAgent turn or
Arena branch step. It contains per-path operations such as add, modify, delete,
and later rename. Each entry stores base identity, new identity, blob refs, and
display diff metadata where available.

### Workspace Materialization
A `WorkspaceMaterialization` is a real directory view prepared for execution.
It may be the source workspace, a git worktree, a sparse worktree, or a
directory assembled from a revision plus deltas. It is an execution cache, not
the durable record of what changed.

### Trust Level
Every delta has a trust level:

- `trusted`: All file writes were performed through timeline-aware tools.
- `git_observed`: Git status/object identity observed the effective changes.
- `observed_partial`: DPAgent saw some touched paths, but writes may be missed.
- `untrusted`: External writes may exist and automatic rollback/apply is unsafe.

Only `trusted` and explicitly supported `git_observed` deltas are eligible for
automatic apply/revert.

## Durable Model
The new module lives under `src/workspace-timeline/`.

Common type:

```ts
type WorkspaceTrustLevel = 'trusted' | 'git_observed' | 'observed_partial' | 'untrusted';
```

### Store Layout
Workspace Timeline persists under the runtime data directory:

```text
runtime/
  workspace-timeline/
    timelines/
      <workspace-id>.json
    revisions/
      <revision-id>.json
    deltas/
      <delta-id>.json
    blobs/
      sha256/
        ab/
          <hash>
    materializations/
      <materialization-id>/
```

`blobs/` is a content-addressed store. Deltas reference blobs by digest and
never duplicate content inline except for very small text previews.

### Workspace Revision Shape
```ts
interface WorkspaceRevision {
  id: string;
  workspaceId: string;
  workspaceDir: string;
  parentRevisionId?: string;
  repoKind: 'git' | 'plain';
  git?: {
    repoRoot: string;
    head?: string;
    syntheticRef?: string;
    indexFingerprint?: string;
  };
  plain?: {
    manifestId?: string;
    manifestTrust: 'complete' | 'partial';
  };
  trustLevel: WorkspaceTrustLevel;
  source: 'turn_begin' | 'turn_commit' | 'arena_branch' | 'rollback' | 'external_wip';
  createdAt: string;
}
```

### Turn Workspace Delta Shape
```ts
interface TurnWorkspaceDelta {
  id: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  baseRevisionId: string;
  resultRevisionId?: string;
  status: 'pending' | 'committed' | 'aborted' | 'incomplete';
  trustLevel: WorkspaceTrustLevel;
  entries: WorkspaceDeltaEntry[];
  captureWarnings: string[];
  createdAt: string;
  committedAt?: string;
}

interface WorkspaceDeltaEntry {
  path: string;
  operation: 'add' | 'modify' | 'delete';
  base?: WorkspaceBlobIdentity;
  next?: WorkspaceBlobIdentity;
  fileMode?: string;
  binary?: boolean;
  diffPreviewBlobId?: string;
}

interface WorkspaceBlobIdentity {
  sha256: string;
  size: number;
  blobRef: string;
}
```

The blob identity is authoritative. Unified diffs are display aids and may be
omitted for binary or large files.

Rename is represented as delete plus add in the first implementation. Native
rename support can be added later only with explicit tests for rename+modify,
case-only rename, cross-directory rename, and rollback.

## Turn Transaction
Workspace Timeline must be turn-scoped and transactional with context events.
A single `TurnWorkspaceTransactionCoordinator` owns this lifecycle. Agent, Web,
Arena, automation, and future rollback code must enter through the coordinator
instead of calling `WorkspaceTimelineStore` and `ContextManager` independently.

The commit protocol is:

1. Resolve the active workspace and create a `turn_begin` revision.
2. Start a pending `TurnWorkspaceDelta` linked to the session and turn id.
3. Run the agent turn.
4. Capture file changes into the pending delta.
5. Persist a prepared result revision and prepared delta record. They are not
   externally visible as a committed turn yet.
6. Append context commit events that include the prepared `workspaceRevisionId`
   and `workspaceDeltaId`, using the normal expected event count guard.
7. Mark the prepared delta/revision as `committed`.

If step 6 fails, the coordinator marks the prepared delta/revision `aborted`.
If step 7 fails after context commit succeeds, startup recovery must reconcile
the manifest: if the context event references a prepared delta/revision with
matching ids and content hashes, mark them `committed`; otherwise mark the turn
as interrupted side-effect state and block silent success.

The context event log and workspace delta cannot silently diverge. A committed
assistant turn must either reference a committed delta or explicitly record that
workspace capture was unavailable or untrusted.

`ContextManager` should not own the file-system store. It only records ids in
context events and namespace metadata. `WorkspaceTimelineStore` owns CAS,
revision manifests, delta manifests, apply/revert, and materialization records.

## Capture Strategy
### Trusted Tools
Timeline-aware file tools report their exact writes before committing:

- path
- base hash before write
- new hash after write
- blob refs
- operation type

These deltas can be `trusted` if no untracked mutation source ran in the same
turn.

### Git Repositories
Git workspaces use Git's own identity mechanisms instead of whole-repo hashing:

- `git status -z` for changed/deleted/untracked paths
- object ids or `git hash-object` for content identity
- temporary index for synthetic tree construction
- hidden refs under `refs/dpagent/...` only when a recoverable synthetic commit
  is needed

The implementation must not change HEAD, trigger ordinary commit hooks, or
write user-visible commits. Retention and cleanup for `refs/dpagent/...` must be
explicit.

`git_observed` covers tracked files plus untracked, non-ignored files reported
by Git. Ignored files are outside automatic `git_observed` coverage unless they
were written by a trusted timeline-aware tool or are explicitly included by a
workspace policy. If ignored or excluded paths may have changed through shell,
MCP, or an external process, the turn must be downgraded to
`observed_partial` or `untrusted`.

### Plain Directories
Plain workspaces use DPAgent's content-addressed store:

- path index with ignore rules
- stream hashing for touched files
- tombstones for deletes
- optional manifest snapshots for complete capture

Until a watcher or file-system wrapper exists, arbitrary shell writes in plain
directories produce `observed_partial` or `untrusted` deltas. Those deltas are
auditable but not automatically reversible.

### Shell, MCP, and Subagents
Shell, MCP, and subagent execution can write files outside tool-level
knowledge. The first release must conservatively mark such turns unless there is
a reliable detector:

- Git repo with clean status capture may become `git_observed`.
- Plain repo without watcher remains `observed_partial` or `untrusted`.
- If a subagent has its own materialized workspace, its delta belongs to that
  branch/session and may later be proposed into a parent.

## Apply and Revert
The long-term apply/revert path operates on delta entries, not
whole-workspace directory diffs. The current rollback implementation restores a
retained result revision from the CAS manifest. It writes blobs for files in the
target revision and removes files that exist in the current managed manifest but
not in the target revision.

Before writing a path, the service validates:

- relative path is safe and normalized
- path stays inside the workspace root
- source ancestors and the final existing target are not symlinks, junctions,
  special files, or escape paths
- `.git`, runtime artifacts, and configured excluded roots are protected
- Windows case-insensitive path collisions are rejected
- current file identity matches the expected base identity
- path type matches the delta operation; file-vs-directory conflicts are
  reported instead of overwritten

Apply writes through temp files and atomic rename where possible. Multi-file
apply returns a conflict list and must avoid partial success being mistaken for
success. If partial writes cannot be avoided on a platform, the result must be
recorded as interrupted side effect state.

Revert uses stored blobs as the authority. Reverse patches are allowed only as
an optimization or display aid.

The first implementation does not support symlink, junction, hardlink, device,
or special-file deltas. Encountering any of those as a source, target, or
ancestor is a conflict. The route is still API-only and conservative; it does
not expose a rollback UI, and full external-dirty conflict UX is future work.

## Rollback Semantics
Rollback is append-only.

It must not truncate `events.jsonl` or delete committed history. Instead it
appends rollback audit data and context patch metadata. The current active
workspace revision is a projected pointer, not the audit source of truth.
Historical messages, search, share links, memory promotion, fork provenance,
and audit views remain available.

Rollback is allowed only when the session has:

- no active run
- no pending plan input
- no interrupted artifact
- no active Arena lock
- no running automation mutation

Before a future user-facing rollback UI, DPAgent must classify the current
working tree. External changes are classified separately:

- `dpagent-applied`: known committed DPAgent deltas
- `external-dirty`: user or non-DPAgent writes
- `untrusted-cache`: materialized workspace state that may not match timeline

The default UI should offer to save external dirty state as a WIP revision, but
that revision remains marked external/untrusted. It is not treated as an agent
result.

The current API allows moving to any retained, blob-backed session result
revision. This supports both ordinary rollback, such as R3 to R2 to R1, and
forward restore after rollback, such as R1 back to R3, while the retained blobs
remain available.

After rollback, DPAgent appends context patches:

- `workspaceTimeline.currentRevision`
- `workspaceTimeline.lastRollback`

Those patches appear in the next turn's Context Snapshot, so the real LLM
context can see that the physical workspace has been restored to a specific
revision without pretending that historical assistant/user turns were deleted.

## Fork Integration
Fork copies context events and references the source workspace revision. It does
not copy the full workspace immediately.

The first write in the fork must acquire a workspace lease or materialize an
independent view. Forks cannot keep writing into the same source execution
cache without coordination, because that would mix independent timelines.

## Arena Integration
Arena becomes a consumer of Workspace Timeline:

- source session enters Arena with a source revision id
- each branch starts from that revision
- branch turns produce branch deltas
- winner proposal is computed from the winner delta chain
- apply validates and applies the winner delta chain to the source revision

Implementation branches still need strong isolation. If a branch must run
build/test/shell, it receives a materialized workspace that is not the source
workspace. The source workspace remains read-only from the branch prompt and
from tool routing.

The existing directory-copy/worktree path remains the fallback until timeline
materialization is proven.

## APIs
Phase 1 internal API:

```ts
interface TurnWorkspaceTransactionCoordinator {
  beginTurn(input: BeginWorkspaceTurnInput): WorkspaceTurnHandle;
  prepareTurnDelta(handle: WorkspaceTurnHandle): PreparedWorkspaceDelta;
  commitPreparedTurn(
    turnId: string,
    handle: WorkspaceTurnHandle | null,
    commit: CommitTurnInput
  ): CommitTurnResult;
  abortTurn(handle: WorkspaceTurnHandle | null, reason: string): void;
  recoverPreparedCommits(): WorkspaceRecoveryReport;
}

interface WorkspaceTimelineStore {
  getDelta(deltaId: string): TurnWorkspaceDelta | null;
  getRevision(revisionId: string): WorkspaceRevision | null;
  listSessionTimeline(sessionId: string): WorkspaceTimelineSummary;
}
```

Rollback-capable internal API:

```ts
interface WorkspaceTimelineStore {
  applyRollback(input: {
    sessionId: string;
    targetRevisionId: string;
    reason?: string;
  }): WorkspaceRollbackApplyResult;
}
```

Delta-chain `applyDelta`, generalized `revertToRevision`, and
`materializeRevision` remain later-phase work. They appear only after the
transaction/recovery contract and trust levels are proven.

Phase 1 Web APIs expose inspection plus API-only rollback:

- `GET /api/sessions/:id/workspace-timeline`
- `GET /api/sessions/:id/workspace-deltas/:deltaId`
- `POST /api/sessions/:id/workspace-rollback`

`POST /api/sessions/:id/workspace-rollback` validates session safety, target
revision ownership, and retained blob availability. On success it restores the
target revision, records rollback audit data, appends context patch metadata,
and returns `200` with `applied: true`, `changedFiles`, and `appliedAt`.
Materialization APIs are later-phase work. Mutating routes require full access.
When Workspace Timeline is disabled, the timeline APIs return 404 and the store
does not expose retained runtime timeline data.

## UI Surfaces
### Turn File Changes
Each assistant turn can show a compact "Files changed" section:

- file count
- operation badges
- trust level
- conflict or capture warnings

### Rollback
Rollback UI is not part of the first implementation. The current surface is
API-only so the store, retention, audit, apply, and safety gates can be
verified before introducing user-facing restore controls. When UI is added,
rollback must never appear while a run is active or while Arena locks the
source.

### Arena Proposal
Arena Proposal reads from the winner delta chain:

- changed files
- summary and evidence from submission
- conflict list
- tests run by branch
- apply readiness

## Performance Model
Git repositories avoid full scans where possible:

- use Git status and object ids
- hash only touched or status-reported paths
- use temporary indexes for synthetic tree work
- use sparse worktree or checkout-index for materialization

Plain directories need:

- persistent path index
- ignore rules
- size thresholds
- stream hashing
- optional file watcher for later phases

Large binary files are stored by blob reference with size limits and preview
omission. The UI should avoid rendering large diffs.

## Safety Rules
- Never follow symlink or junction ancestors when applying a delta.
- Never write outside the workspace root.
- Never write into `.git`, DPAgent runtime roots, or excluded artifact roots.
- Never auto-apply a delta with lower trust than the target operation requires.
- Never collapse external user edits into an agent delta silently.
- Never delete committed context or workspace timeline history during rollback.
- Never use a branch materialization that points directly at a locked Arena
  source workspace.

## Migration
Existing sessions have no workspace timeline. They should behave as:

- timeline status: `not_started`
- current workspace: physical workspace only
- rollback: unavailable until a new revision is captured
- Arena: existing worktree/directory-copy fallback remains available

New sessions begin creating timeline records only after the Settings -> Other
test checkbox is enabled. Generated config remains off by default:

```yaml
workspaceTimeline:
  enabled: false
  captureMode: advisory
```

The default can move to enabled only after transaction recovery, trusted tool
capture, stale dirty-state handling, and rollback UX pass release gates.

## Testing Matrix
### Store and CAS
- blob de-duplication
- manifest write/read
- pending/committed/aborted delta lifecycle
- retention cleanup does not remove referenced blobs

### Git Workspace
- clean repo no-op delta
- modified tracked file
- deleted tracked file
- untracked file
- binary file
- hidden ref creation without HEAD movement
- stale base conflict

### Plain Workspace
- add/modify/delete file
- tombstone revert removes later file
- ignored roots are excluded
- large file stored without diff preview
- untrusted shell write disables automatic rollback

### Apply/Revert Safety
- path traversal rejected
- symlink ancestor rejected
- junction escape rejected on Windows
- case collision rejected
- `.git` path rejected
- partial failure records interrupted side-effect state

### Session Integration
- context commit references committed delta
- delta commit failure blocks or interrupts turn completion
- context commit failure aborts pending delta
- rollback appends event instead of truncating history
- active run and pending input block rollback

### Arena and Fork
- fork inherits revision pointer without copying workspace
- fork first write materializes or leases safely
- Arena branch proposal comes from delta chain
- winner apply ignores loser deltas
- source dirty conflict blocks apply

## Phasing
### Phase 1: Store and Transaction Contract
Create types, CAS, timeline store, trust levels, and transaction lifecycle.
Integrate only enough to record advisory deltas for controlled tests.

### Phase 1.5: Recovery and Dirty-State Contract
Define interrupted side-effect handling, external dirty classification, and
append-only rollback event semantics before any user-facing rollback UI.

### Phase 2: Trusted Tool Capture
Wrap DPAgent-owned file mutation tools so their writes produce trusted deltas.
Shell and MCP remain lower-trust unless observed by Git.

### Phase 3: Git Observed Capture
Use Git status/object ids to capture tracked, deleted, and untracked changes
without whole-repo hashing.

### Phase 4: Arena Proposal/Apply on Delta Chain
Replace Arena full-directory proposal/apply with winner delta-chain proposal.
Keep existing worktree/directory-copy branch preparation as fallback.

### Phase 5: Session Timeline UI and Rollback
Show per-turn file changes and add append-only rollback for trusted revisions.

### Phase 6: Lazy Materialization
Introduce sparse worktree/materialized view support for branches and forks.
This phase must define leases, cache invalidation, delta ownership for writes
inside a materialization, garbage collection, concurrent execution behavior,
and mismatch handling when a materialization no longer matches its revision.

### Phase 7: Watcher or File-System Proxy
Optionally add Watchman, native watcher, or platform-specific virtualization to
raise capture confidence for non-Git and shell-heavy workflows.

## Open Questions
- What retention window should DPAgent use for blobs, revisions, and hidden Git
  refs?
- Should rollback create a new visible session branch by default, or mutate the
  active session head in place?
- Which file mutation tools are in scope for `trusted` capture in the first
  implementation node?
- Should plain-workspace watcher support be required before enabling rollback
  outside Git repositories?
- How should automation runs expose workspace deltas when they execute without
  an interactive UI?
