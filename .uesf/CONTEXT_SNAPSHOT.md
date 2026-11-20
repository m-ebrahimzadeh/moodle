# UESF Context Snapshot (Machine-Generated)
> **NON-AUTHORITATIVE DERIVED ARTIFACT — DO NOT EDIT MANUALLY**
> Generated deterministically by `bin/uesf.mjs sync-snapshot` per `policies/SOURCE_OF_TRUTH_POLICY.md` (`DEC-023`, `DEC-026`).
> * **Canonical Control Plane**: `.uesf/`
> * **Snapshot Version**: `0.1.0`
> * **Source-Ledger-SHA256**: `042b1c11ccf7dcf94add60d0e427b28c2c373cda4c2ad40319b0a60e726338d9` (`042b1c11ccf7`)
> * **Last Ledger Update**: `2026-11-19`

## 1. Empirically Verified Repository Facts (`[VERIFIED_BY_GIT_AND_FS_PROBE]`)
* **Canonical Specification Files on Disk**: `9`
* **Registered Documents in `KNOWLEDGE_MAP.md`**: `9`
* **Missing Registered Files on Disk**: `0`
* **Unindexed Canonical Markdown Files on Disk**: `0`
* **Header-to-Registry Version Mismatches**: `0`
* **Total Recorded Tasks (`ACCEPTED` / Total)**: `3 / 4`
* **Total Recorded Decisions (`DEC-*`)**: `4`
* **Unresolved Open Questions (`OQ-*`)**: `1`

## 2. Recorded Project & Governance State (`[RECORDED_IN_LEDGER]`)
### 2.1 Project Identity & Architecture Profile (`.uesf/EXTENSION.md`)
# Project-Specific Extension — moodle
* **Document ID**: MOODLE-CTRL-001
* **Canonical Path**: .uesf/EXTENSION.md
* **Version**: 0.1.0
* **Status**: Verified
* **Owner**: Architect
* **Pinned UESF Version**: 0.9.0
* **Last Updated**: 2026-11-19

## 1. Purpose & Target Project Profile
Define the Layer 6 Project-Specific Extension and operational control profile for the `moodle` project (`templates/PROJECT_EXTENSION_TEMPLATE.md`, UESF `v0.9.0`).
* **Project Name**: `moodle`
* **Canonical Remote Repository**: None configured yet (`OQ-001`) — Default Branch: `main` (unborn branch; no commits yet)
* **Detected Tech Stack**: TypeScript 5 (`strict: true`), Chrome Extension Manifest V3 (`chrome.sidePanel`, `chrome.downloads`, Background Service Worker), Vite, Vitest (`DEC-003`)
* **Operational Control Plane**: `.uesf/{EXTENSION.md, KNOWLEDGE_MAP.md, ACTIVE_TASKS.md, DECISION_LOG.md, CONTEXT_SNAPSHOT.md}` plus gitignored `.uesf/handoffs/`
* **Permanent Documentation Home**: Native project root `README.md` and `docs/{investigation,architecture}/*.md` (indexed 1-to-1 in `.uesf/KNOWLEDGE_MAP.md`)

## 2. Scope & Domain Architecture Overlay
Applies to all engineering, discovery, verification, and documentation work performed in the `moodle` repository.
* **Current Directory Boundaries**:
  * `docs/` & `README.md`: Permanent investigation specifications and architectural contracts.
  * `src/core/`: Pure TypeScript domain & protocol modules (`types.ts`, `moodle-client.ts`, `course-parser.ts`, `kaltura-client.ts`, `path-builder.ts`) with zero `chrome.*` dependencies.
  * `src/extension/`: MV3 runtime adapters (`messages.ts`, `download-manager.ts`, `service-worker.ts`).
  * `src/ui/`: Chrome Side Panel UI (`sidepanel.html`, `sidepanel.css`, `sidepanel.ts`) built with Vanilla TypeScript + semantic HTML/CSS.
  * `tests/`: Vitest unit test suites validating pure `src/core/` parsers and clients against redacted fixtures.
* **Architecture Overlay (`DEC-003`)**: Strict unidirectional dependency `src/ui/ -> src/extension/ (messages) -> src/core/`; `src/core/` never imports from `src/extension/`, `src/ui/`, or `chrome.*` globals.

## 3. Role Specialization & Domain Responsibilities
* **Discovery**: Leads read-only (`A0`) feature discovery and requirements clarification prior to creating source modules or contracts (`OQ-002`).
* **CTO**: Governs milestone acceptance, architectural rulings (`DEC-*`), and `A3` human approval gates.
* **Architect**: Maintains `.uesf/EXTENSION.md`, defines system boundaries, and approves interface contracts once stack selection is confirmed.
* **Developer**: Executes bounded implementation on feature/task branches with `IN_PROGRESS` task registration and verified checks.
* **QA**: Performs independent verification of build/lint/test evidence (`EV-TASK-XXX`) prior to task acceptance.
* **DevOps**: Maintains Git workflows, remote repository bindings (`OQ-001`), CI/CD pipelines, and `.uesf/` snapshot hook health.
* **Security**: Enforces secret hygiene, dependency auditing, and `Standard-Contract` gates for auth/security-sensitive changes.
* **SRE**: Defines operational readiness, observability, and rollback procedures once runtime services are introduced.
* **Documentation**: Keeps permanent documentation in `README.md` and `docs/` synchronized and indexed in `.uesf/KNOWLEDGE_MAP.md`.

## 4. Project-Specific Verification, Security & Release Gates
Universal UESF verification, Git, autonomy, and security policies apply unconditionally. Project-specific gates will be tightened below as tooling is introduced (`OQ-002`):
1. **Build, Typecheck & Unit Test Gate (`DEC-003`)**: Every code-producing task must exit with code `0` on `npm run typecheck` (`tsc --noEmit`), `npm test` (`vitest run`), and `npm run build` (producing `dist/manifest.json` and compiled MV3 bundles).
2. **Secret & Hygiene Gate**: Zero credentials, API keys, or `.env` secrets committed to Git; `.uesf/handoffs/` remains gitignored.
3. **Snapshot Integrity Gate**: `.uesf/CONTEXT_SNAPSHOT.md` must stay synchronized with `.uesf/` ledgers via `.git/hooks/pre-commit` or `node .uesf/bin/uesf.mjs sync-snapshot`.

## 5. Adapter & Tooling Bindings
* **Local Coding Agent Environment**: Bound via `CAP-FS`, `CAP-TERM`, and `CAP-GIT` (Node.js `v22.15.0`, Git `2.52.0`).
* **Automated Snapshot Engine**: `.uesf/bin/uesf.mjs`, `.uesf/scripts/sync-snapshot.ps1`, `.uesf/scripts/sync-snapshot.sh`, and `.git/hooks/pre-commit`.
* **Handoff Transport Spool**: `.uesf/handoffs/` (gitignored flat directory for paired `HO-TASK-XXX-01.md` / `-02.md` packages).

## 6. Strict Layer 6 Isolation & Non-Override Guarantees
* This file operates strictly as a Layer 6 Project Extension (`UESF v0.9.0`).
* Universal UESF `core/`, `policies/`, `protocols/`, `roles/`, `adapters/`, and `templates/` files are never duplicated into `.uesf/` and remain completely decoupled from this project.
* Nothing in this extension weakens `A0`–`A3` autonomy thresholds, epistemic evidence rules (`Verified`, `Observed`, `Reported`, `Inferred`, `Unknown`), or Git safety rules.

## 7. Relationships with Other Documents
* **Operational Ledgers**: `.uesf/KNOWLEDGE_MAP.md`, `.uesf/ACTIVE_TASKS.md`, `.uesf/DECISION_LOG.md`, `.uesf/CONTEXT_SNAPSHOT.md`
* **Universal UESF Specifications (`v0.9.0`)**: `core/FRAMEWORK_ARCHITECTURE.md`, `policies/AUTONOMY_POLICY.md`, `policies/SOURCE_OF_TRUTH_POLICY.md`, `policies/VERIFICATION_POLICY.md`

### 2.2 Active & Recent Task Ledger (`.uesf/ACTIVE_TASKS.md`)
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

### 2.3 Architectural & Governance Decisions (`.uesf/DECISION_LOG.md`)
# Architectural & Governance Decision Log
* **Document ID**: MOODLE-CTRL-004
* **Canonical Path**: .uesf/DECISION_LOG.md
* **Version**: 0.1.1
* **Status**: Verified
* **Owner**: CTO
* **Last Updated**: 2026-11-20

## 1. Purpose
Maintain an immutable, auditable ledger of confirmed stakeholder constraints, architectural decisions (`DEC-*`), and open questions (`OQ-*`) for the `moodle` project.

## 2. Scope
Governs all technical architecture, governance, and tooling decisions recorded within `.uesf/`.

## 3. Confirmed & Approved Decisions
| Decision ID | Category | Decision Summary | Status | Authority | Date |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `DEC-001` | Governance Onboarding | Onboard Project to UESF Three-Domain Governance (pinned to UESF `v0.9.0`), maintaining operational state in `.uesf/`, future permanent docs in native `README.md`/`docs/`, and automated context snapshots via `.uesf/bin/uesf.mjs` and `.git/hooks/pre-commit`. | Confirmed | Human Stakeholder | 2026-11-19 |
| `DEC-002` | Project Charter & Architectural Constraints | Independent UniPD Moodle Lecture Extension Project: (1) build a Chrome Extension (MV3) conceptually similar to PoliRecord; (2) perform discovery, stream capture, and download orchestration inside the user's browser extension session (no backend bot/server); (3) maintain strict independence from `polisdk` in this dedicated repository, starting investigation from `https://psico.elearning.unipd.it/login/index.php`. | Confirmed | Human Stakeholder | 2026-11-19 |
| `DEC-003` | MV3 Architecture, Tech Stack & MVP Scope (`OQ-002`) | Adopt Option A (Single-Package Pure MV3 Chrome Extension): flat modular layout (`src/{core,extension,ui}`, `tests/`), Chrome Side Panel (`chrome.sidePanel`) in Vanilla TypeScript + semantic HTML/CSS, headless `fetch()` pipeline (`/my/courses.php` `sesskey` -> Moodle AJAX `core_course_get_enrolled_courses_by_timeline_classification` -> `/course/view.php` `#region-main` parser -> `/mod/kalvidres/player_bridge.php` -> Kaltura `multirequest` -> direct progressive MP4 `format/url` + `.vtt` subtitles + Moodle `pluginfile.php` MP4s) downloaded via a bounded `chrome.downloads.download()` queue (max 2 concurrent); verified with TypeScript (`tsc --noEmit`), Vite (`npm run build`), and Vitest (`npm test`). Phase 1 MVP (`v0.1.0`) targets video lectures + `.vtt` subtitles; static PDFs/slides (`mod_resource`, `mod_folder`), Media Gallery LTI fallback, and Offscreen HLS fallback are deferred to Phase 2 (`v0.2.0`). | Confirmed | Human Stakeholder / CTO (`A2`) | 2026-11-19 |
| `DEC-004` | Snapshot Tooling Patch (`KDP-001`) | Approve `KDP-001` (`PATCH`): update local vendored `.uesf/bin/uesf.mjs` `walkMdFiles()` to unconditionally skip `.git`, `handoffs`, and `node_modules` (`ALWAYS_SKIP_DIRS`), and skip build/cache artifact directories (`dist`, `.vite`, `coverage`, `build`, `.venv`, `venv`, `target`) during `sync-snapshot` (`excludeDistAndSnap = true`) so third-party package Markdown files never trigger false-positive `UNINDEXED_MD_ON_DISK` drift alerts. Zero-dependency static denylist preserved; upstream backport to UESF `v0.9.1` (`C:/Users/user/Project/uesf`) tracked separately outside `moodle` workspace scope. | Approved | CTO (`A2`) / DevOps | 2026-11-20 |

## 4. Open Questions & Pending Human Decisions (`A3` / Clarification Items)
| Question ID | Topic | Resolution Summary | Status |
| :--- | :--- | :--- | :--- |
| `OQ-001` | Canonical Remote Git Repository URL | Pending remote repository creation and `git remote add origin <url>` configuration; update `.uesf/EXTENSION.md` once set. | **Open (Pending Setup)** |
| `OQ-002` | Target Tech Stack & Verification Gates | Resolved via `DEC-003`: Single-package TypeScript + Vite + Vitest MV3 Side Panel Chrome Extension (`src/{core,extension,ui}`) using headless `player_bridge.php` -> Kaltura progressive `format/url` MP4 + `chrome.downloads.download()`, verified via `npm run typecheck`, `npm test`, and `npm run build`. | **Closed (Resolved via DEC-003)** |

## 5. Responsibilities
* **CTO**: Records ratified project decisions and tracks resolution of open questions.

## 6. Relationships with Other Documents
* **Project Extension**: `.uesf/EXTENSION.md`
* **Knowledge Map**: `.uesf/KNOWLEDGE_MAP.md`
* **Task Registry**: `.uesf/ACTIVE_TASKS.md`

### 2.4 Master Knowledge Map Routing Index (`.uesf/KNOWLEDGE_MAP.md`)
# Master Knowledge Map & Source-of-Truth Registry
* **Document ID**: MOODLE-CTRL-002
* **Canonical Path**: .uesf/KNOWLEDGE_MAP.md
* **Version**: 0.1.0
* **Status**: Verified
* **Owner**: CTO
* **Last Updated**: 2026-11-20

## 1. Purpose
Maintain the single authoritative routing index mapping every operational UESF control-plane artifact in `.uesf/` and every permanent project specification in `README.md` or `docs/` to its Document ID, canonical path, category, owner role, version, and status.

## 2. Scope
Covers all tracked Markdown documents in the `moodle` repository (`README.md`, `docs/`, `.uesf/`). Machine-generated `.uesf/CONTEXT_SNAPSHOT.md` and gitignored ephemeral files in `.uesf/handoffs/` are excluded from manual registration.

## 3. Rules and Requirements
1. **Three-Domain Separation**: Universal UESF framework docs stay in the UESF installation (`v0.9.0`); permanent project docs remain in native paths (`README.md`, `docs/`); operational state resides in `.uesf/`.
2. **1-to-1 Inventory Parity**: Every canonical `.md` file tracked in this repository must have a matching row in Section 4 with synchronized `* **Version**:` metadata.

## 4. Document Registry
| Doc ID | Canonical Repository Path | Layer / Category | Owner Role | Version | Lifecycle Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `MOODLE-CTRL-001` | `.uesf/EXTENSION.md` | Layer 6: Project Extension | Architect | `0.1.0` | Verified |
| `MOODLE-CTRL-002` | `.uesf/KNOWLEDGE_MAP.md` | Operational State Index | CTO | `0.1.0` | Verified |
| `MOODLE-CTRL-003` | `.uesf/ACTIVE_TASKS.md` | Operational Task Ledger | CTO | `0.1.0` | Verified |
| `MOODLE-CTRL-004` | `.uesf/DECISION_LOG.md` | Operational Decision Log | CTO | `0.1.1` | Verified |
| `MOODLE-DOC-001` | `README.md` | Domain 2: Project Overview | Architect | `0.1.0` | Verified |
| `MOODLE-DOC-002` | `docs/investigation/01-auth-and-session-flow.md` | Domain 2: Investigation Spec | Architect | `0.1.0` | Verified |
| `MOODLE-DOC-003` | `docs/investigation/02-course-and-lecture-discovery.md` | Domain 2: Investigation Spec | Architect | `0.1.0` | Verified |
| `MOODLE-DOC-004` | `docs/investigation/03-video-playback-and-download-mechanics.md` | Domain 2: Investigation Spec | Architect | `0.1.0` | Verified |
| `MOODLE-DOC-005` | `docs/architecture/01-discovery-synthesis-and-options.md` | Domain 2: Architecture & OQ-002 | Architect | `0.1.0` | Verified |

## 3. Automated Discrepancy & Drift Audit (`[DRIFT_CHECK]`)
* **Drift Audit Verdict**: `CLEAN (0 discrepancies between canonical ledgers and on-disk specification tree)`
* **Cloud / Remote Session Note**: When reading this file remotely without local `CAP-FS`/`CAP-GIT`, treat Section 1 as verified at the time of the commit that produced `Source-Ledger-SHA256: 042b1c11ccf7`, treat Section 2 as `[REPORTED — Remote Ledger]`, and treat any uncommitted local working-tree edits as `[UNKNOWN — Local FS Unavailable]`.
