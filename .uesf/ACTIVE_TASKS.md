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
| `TASK-003` | Implement UniPD Moodle MV3 Chrome Extension MVP (`v0.1.0` — Core Clients, Side Panel UI & Download Queue) | Developer | QA / Architect | Local Repository (`moodle`) | `A1` | `ACCEPTED` | Accepted by Human Stakeholder (`2026-11-20`) following independent QA (`d9362fca`, `PASS_WITH_MINOR_NOTES`), Architect (`71deef6e`, `CONFORMANT_WITH_MINOR_NOTES`), unauthenticated Live Chrome 158 (`e5c28278`, `PASS`: `LIVE-001` & `LIVE-002`), micro-hardening pass (`d31fb17`, `59/59` tests, all 8 review-board notes resolved), and full Live Authenticated Chrome 158 E2E (`f4451964` + `d50f47b3`, `PASS`: Shibboleth SSO auto-push, 24 courses, Kaltura resolution, zero-secret boundary, real `368.6 MB` `.mp4` + `.vtt` downloads under `UniPD/...`, live cancel, and `LIVE-UI-001` / `LIVE-UI-002` CSS/UI fixes verified with `0` errors). |
| `TASK-004` | Adjudicate `KDP-001` & Patch `.uesf/bin/uesf.mjs` `walkMdFiles()` Dependency/Build Exclusions (`Fast-Path`) | DevOps | QA / CTO | Local Repository (`moodle`) | `A2` | `ACCEPTED` | `DEC-004` (`2026-11-20`): patched `.uesf/bin/uesf.mjs` `walkMdFiles()` (`ALWAYS_SKIP_DIRS` + `BUILD_ARTIFACT_DIRS`); independently verified (`PASS`) by isolated QA session (`922a963e-c85c-4bf8-ac34-6b72ce805625`) — two consecutive `sync-snapshot` runs exited `0` with identical SHA256 (`IDEMPOTENT=True`) and `Drift Audit Verdict: CLEAN (0 discrepancies)`. |
| `TASK-005` | Configure GitHub Actions CI Pipeline & Commit `OQ-001`/`DEC-005` Governance Baseline (`Fast-Path`) | DevOps | QA | Local Repository (`moodle`) | `A2` | `ACCEPTED` | `426d650` (`HO-TASK-005-02.md` / `EV-TASK-005-01`): independently verified (`PASS`) by Tier 1 QA (`f143e8aa`, `A0`) across all 4 acceptance criteria — `.github/workflows/ci.yml` (`contents: read`, `checkout@v4`, `setup-node@v4` Node 22/npm, `npm ci`, `typecheck`, `test` `59/59`, `build` `63` modules, static `dist/` & `src/ui/` checks, `sync-snapshot` `CLEAN` + `git diff --exit-code`), `OQ-001`/`DEC-005`/`MOODLE-DOC-006` baseline committed, `0` changes to `src/`/`tests/`/`public/`/`package.json`, `.env` gitignored. |
| `TASK-006` | Phase 2A: Implement Static Course Materials (`mod_resource` & `mod_folder`), Lazy Resolvers & Side Panel Content Tabs (`v0.2.0`) | Developer | QA / Architect | Local Repository (`moodle`) | `A1` | `VERIFIED` | Tier 2 re-verification passed (`HO-TASK-006-05.md`): Independent Architect (`CONFORMANT`, `0` blockers), Independent QA (`PASS`: `tsc --noEmit` `0`, `82/82` Vitest tests, `vite build` `63` modules, `npm audit` `0`, `0`-diff `public/manifest.json`), and Live Chrome `158.0.8127.36` E2E (`PASS`: Shibboleth SSO `24` courses, `0` `mod_subsection` dupes across 5 course entries / `164` materials, `"Are Emotions Natural Kinds?.pdf"` `.pdf` badge & `368,991 B` `%PDF-` download, keyboard `ArrowRight` & `Space` DOM-node reuse focus retention, zero-secret storage). |
| `TASK-007` | Phase 2B: UX Persistence, Secret-Free Download History Badge, Queue Retry & HLS-Only Diagnostics (`v0.2.0`) | Developer | QA / Architect | Local Repository (`moodle`) | `A1` | `PROPOSED` | Sequenced after `TASK-006` acceptance (`DEC-005`, `docs/architecture/02-phase2-v0.2.0-blueprint.md` §4). |
| `TASK-008` | Phase 2C: `local_kalturamediagallery` (`media19.elearning.unipd.it`) Live `A0` Investigation Spike & Optional Supplement | Architect / Developer | CTO / QA | Local Repository (`moodle`) | `A0` | `PROPOSED` | Sequenced after `TASK-007` (`DEC-005`); `A0` read-only LTI/KAF feasibility spike required prior to any `optional_host_permissions` (`A3`) contract. |

## 5. Active Outbound Task Queue
* `TASK-006` (`VERIFIED` -> `.uesf/handoffs/HO-TASK-006-05.md`): Rebased onto `main` after `TASK-005`; awaiting final `ACCEPTED` record and `--no-ff` merge.
