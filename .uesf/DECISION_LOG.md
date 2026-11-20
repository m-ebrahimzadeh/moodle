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
