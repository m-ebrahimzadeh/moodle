# Active Tasks Registry
* **Document ID**: MOODLE-CTRL-003
* **Canonical Path**: .uesf/ACTIVE_TASKS.md
* **Version**: 0.1.0
* **Status**: Verified
* **Owner**: CTO
* **Last Updated**: 2026-11-20

## 1. Purpose
Track all active, pending, blocked, and accepted engineering tasks in `moodle` using standard `TASK-XXX` identifiers, explicit autonomy tiers, and verifiable evidence notes.

## 2. Scope
Covers all project work executed under UESF `Fast-Path` and `Standard-Contract` workflows.

## 3. Rules and Requirements
1. **Pre-Implementation Registration**: Register any `Fast-Path` or `Standard-Contract` task as `IN_PROGRESS` on disk before editing implementation files.
2. **Evidence Discipline**: Only mark a task `VERIFIED` or `ACCEPTED` after recording reproducible verification outputs.

## 4. Current Task Registry
| Task ID | Title | Responsible Role | Reviewer Role | Target Workspace | Autonomy | State | Evidence / Notes |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `TASK-001` | Initialize UESF Project Control Plane (.uesf/) | Architect / DevOps | Human Stakeholder | Local Repository (`moodle`) | `A1` | `ACCEPTED` | Onboarded via `/uesf-init` (`2026-11-19`); human approved Stage 1 proposal; `.uesf/` scaffolded and snapshot engine wired via `uesf init-project .`. |
| `TASK-002` | Conduct Live UniPD Moodle Investigation & Establish Project Knowledge Base (`psico.elearning.unipd.it`) | Architect | CTO / Human Stakeholder | Local Repository (`moodle`) | `A1` | `ACCEPTED` | `EV-TASK-002-01` (`HO-TASK-002-02`): Accepted by CTO & Human Stakeholder (`2026-11-19`); findings verified across 5 stages and architecture ratified in `DEC-003` (`OQ-002` closed). |
| `TASK-003` | Implement UniPD Moodle MV3 Chrome Extension MVP (`v0.1.0` — Core Clients, Side Panel UI & Download Queue) | Developer | QA / Architect | Local Repository (`moodle`) | `A1` | `IN_REVIEW` | `EV-TASK-003-02` + micro-hardening pass (`2026-11-20`): Independent QA (`PASS_WITH_MINOR_NOTES`), Architect (`CONFORMANT_WITH_MINOR_NOTES`), and Live Chrome 158 (`PASS`: `LIVE-001` & `LIVE-002` verified) passed on `9d7c8fa`; subsequently patched all 8 review-board notes (`ARCH-NOTE-001` scoped `M.cfg` `userId` check, `QA-LOW-2` guest text-marker gating, `QA-LOW-1` `selectCourse` `catch` generation guard, `ARCH-NOTE-003`/`QA-LOW-3` same-language multi-track `.vtt` filename disambiguation, `QA-LOW-4` pre-resolve cancel check, `QA-LOW-5` disabled errored checkbox + accessible Retry button, `ARCH-NOTE-002` tightened layer-isolation regex + `src/ui/` boundary test, `ARCH-NOTE-004` `finalUrl` same-origin abort + non-MP4 video extension inference). Verified `typecheck` exit `0`, `59/59` Vitest tests (`7` files), `npm run build`, and `sync-snapshot` `CLEAN`. Ready for commit, final sign-off, and live authenticated E2E verification. |
| `TASK-004` | Adjudicate `KDP-001` & Patch `.uesf/bin/uesf.mjs` `walkMdFiles()` Dependency/Build Exclusions (`Fast-Path`) | DevOps | QA / CTO | Local Repository (`moodle`) | `A2` | `ACCEPTED` | `DEC-004` (`2026-11-20`): patched `.uesf/bin/uesf.mjs` `walkMdFiles()` (`ALWAYS_SKIP_DIRS` + `BUILD_ARTIFACT_DIRS`); independently verified (`PASS`) by isolated QA session (`922a963e-c85c-4bf8-ac34-6b72ce805625`) — two consecutive `sync-snapshot` runs exited `0` with identical SHA256 (`IDEMPOTENT=True`) and `Drift Audit Verdict: CLEAN (0 discrepancies)`. |

## 5. Active Outbound Task Queue
* `TASK-003` (`IN_REVIEW` -> `.uesf/handoffs/HO-TASK-003-04.md`): Returned by `Developer` (`EV-TASK-003-02`) for independent QA / Architect verification and second live Chrome 158 unpacked load check (`LIVE-001`, `LIVE-002`).
