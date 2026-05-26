# DPAgent Release Notes: 2.2.12

## Highlights

- Runtime `skill_manage` create/update actions now apply the skill immediately as an approved skill.
- Removed the user-visible pending skill approval surface, including Web pending-skill routes, workspace governance `pendingSkills`, and pending skill review cards.
- Removed obsolete `agent.skillWriteMode` settings and config contract exposure.
- Preserved skill write records, version history, rollback, pack publication, and generated workspace skill governance.

## Verification Scope

- Standard release gates for this version exclude the unavailable Kimi external profile and use the maintained DeepSeek and MiniMax release toolcall gate.
