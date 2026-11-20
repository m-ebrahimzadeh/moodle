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
| `TASK-003` | Implement UniPD Moodle MV3 Chrome Extension MVP (`v0.1.0` — Core Clients, Side Panel UI & Download Queue) | Developer | QA / Architect | Local Repository (`moodle`) | `A1` | `IN_REVIEW` | `EV-TASK-003-02` (`HO-TASK-003-04`, `2026-11-20`): Completed all 14 remediation items from `HO-TASK-003-03` (`LIVE-001` guest `userId <= 1` + `fetchMoodleSession` `!response.ok`, `LIVE-002` `[hidden] { display: none !important }`, `ARCH-002`/`QA-001` memoized `hydratePromise`, `ARCH-001`/`QA-002` secret-free session descriptors + lazy `resolveDownloadUrl` + `toPublicLectureMedia` stripping `?ks=`, `QA-003`/`ARCH-003` vanished `downloadId` recovery + orphan reconciliation + null-`downloadId` cancel + fast-completion sync + unified `'Cancelled by user'`, `QA-004` `/ks/` & cookie/bare token redaction, `QA-005` duplicate enqueue guard, `ARCH-005`/`QA-006` Windows stem check & `<= 180` char `MAX_PATH` budget, `ARCH-004`/`QA-007` Moodle MP4 auth + non-HTML binary abort + same-origin `pluginfile.php`, `ARCH-007`/`QA-008` Kaltura top-level exception & caption `https:` normalization, `QA-009` anchored `NON_VIDEO_EXT_PATTERN`, `QA-010`/`ARCH-009` in-place Side Panel UI updates & selection/session guards, `ARCH-006`/`ARCH-008`/`QA-011` `modulePreload: false`, `sender.id` guard, gated `tabs.onUpdated`, recursive layer-isolation tests). Verified `typecheck` exit `0`, `54/54` Vitest tests (`7` files), `npm run build`, `npm audit` (`0` vulns), secret scan clean, and `sync-snapshot` `CLEAN`. Ready for independent QA/Architect + Live Chrome 158 re-check. |
| `TASK-004` | Adjudicate `KDP-001` & Patch `.uesf/bin/uesf.mjs` `walkMdFiles()` Dependency/Build Exclusions (`Fast-Path`) | DevOps | QA / CTO | Local Repository (`moodle`) | `A2` | `ACCEPTED` | `DEC-004` (`2026-11-20`): patched `.uesf/bin/uesf.mjs` `walkMdFiles()` (`ALWAYS_SKIP_DIRS` + `BUILD_ARTIFACT_DIRS`); independently verified (`PASS`) by isolated QA session (`922a963e-c85c-4bf8-ac34-6b72ce805625`) — two consecutive `sync-snapshot` runs exited `0` with identical SHA256 (`IDEMPOTENT=True`) and `Drift Audit Verdict: CLEAN (0 discrepancies)`. |

## 5. Active Outbound Task Queue
* `TASK-003` (`IN_REVIEW` -> `.uesf/handoffs/HO-TASK-003-04.md`): Returned by `Developer` (`EV-TASK-003-02`) for independent QA / Architect verification and second live Chrome 158 unpacked load check (`LIVE-001`, `LIVE-002`).
