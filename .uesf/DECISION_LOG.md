# Architectural & Governance Decision Log
* **Document ID**: MOODLE-CTRL-004
* **Canonical Path**: .uesf/DECISION_LOG.md
* **Version**: 0.1.5
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
| `DEC-005` | Phase 2 (`v0.2.0`) Roadmap, Materials Path & Permission Boundaries | Ratify incremental Phase 2 (`v0.2.0`) plan documented in `docs/architecture/02-phase2-v0.2.0-blueprint.md`: (1) `TASK-005` GitHub Actions CI + `OQ-001`/`DEC-005` governance commit (`Fast-Path`); (2) `TASK-006` Phase 2A Static Course Materials (`mod_resource` PDFs/slides/datasets + `mod_folder` packs, zero new manifest permissions, lazy resolution to prevent request storms on 50+ item courses, Option A subfolder layout `UniPD/{AY}/{Course}/{Section}/Materials/...`); (3) `TASK-007` Phase 2B UX, Persistence & Queue Polish (persistent `chrome.storage.local` prefs, secret-free download history badge, 1-click Retry via persisted descriptors, HLS-only diagnostic detection); (4) `TASK-008` Phase 2C `local_kalturamediagallery` (`media19.elearning.unipd.it`) starting with an `A0` live investigation spike before any `optional_host_permissions` (`A3`) addition. Defer Offscreen HLS remuxing (`chrome.offscreen`) to `v0.3.0+` unless HLS-only telemetry is actually observed on UniPD. | Confirmed | Human Stakeholder / CTO (`A2`) | 2026-11-20 |
| `DEC-006` | Automatic UniPD Shibboleth SSO & Encrypted Local Storage (`DSC-001`) | Ratify opt-in automatic UniPD Shibboleth SSO login (`docs/architecture/03-auto-shibboleth-auth.md`, `MOODLE-DOC-007`) while preserving strict `polisdk` independence (`DEC-002`) and unidirectional layer isolation (`DEC-003`): (1) `S1` zero-prompt credential storage via Web Crypto `AES-256-GCM` in `chrome.storage.local` with a random non-extractable `CryptoKey` in IndexedDB and write-only SW boundary; (2) scoped to UniPD Shibboleth `username` (`name.surname@studenti.unipd.it` full input or `@studenti.unipd.it`/`@unipd.it` domain), and `password`; (3) `T1` headless Service Worker `fetch()` flow (`e1s1` -> `e1s2` -> `/sp-shibboleth.sso/SAML2/POST`) adding `"https://shibidp.cca.unipd.it/*"` to `public/manifest.json` `host_permissions`, with singleflight re-auth (`withAutoReauth`) and persistent lockout circuit breaker on failed credentials (`T2` background tab + `chrome.scripting` reserved strictly as contingency if live SP `POST` blocks extension `Origin`). | Confirmed | Human Stakeholder (`A3`) / CTO (`A2`) | 2026-11-20 |
| `DEC-007` | Course-Level `Lectures/` & `Materials/` Hierarchy and Lecture Naming (`DSC-002`) | Amend `DEC-005` folder layout per Human-approved `DSC-002`: (1) split at course level under `UniPD/{AY}/{CourseFolder}/` into `Lectures/` (flat, `{LectureNum} - [{YYYY-MM-DD} - ]{LectureTitle} ({Resolution}).{ext}` using course-wide 2-digit index and Kaltura `createdAt` UTC date when available, omitting topic and course code in filenames) and `Materials/{SectionNum} - {SectionTitle}/` (`{ActivityNum} - {Title}.{ext}` for `mod_resource`, `{FolderName}/{subPath}/{FileName}.{ext}` for `mod_folder`); (2) keep Chrome native directory handling (`Downloads/UniPD/...`) and `conflictAction: 'uniquify'`. | Confirmed | Human Stakeholder (`A3`) | 2026-11-20 |

## 4. Open Questions & Pending Human Decisions (`A3` / Clarification Items)
| Question ID | Topic | Resolution Summary | Status |
| :--- | :--- | :--- | :--- |
| `OQ-001` | Canonical Remote Git Repository URL | Resolved (`2026-11-20`): configured `origin` -> `https://github.com/m-ebrahimzadeh/moodle.git` tracking `origin/main` (verified via `git remote -v`); `.uesf/EXTENSION.md` updated to `v0.1.1`. | **Closed (Configured on GitHub)** |
| `OQ-002` | Target Tech Stack & Verification Gates | Resolved via `DEC-003`: Single-package TypeScript + Vite + Vitest MV3 Side Panel Chrome Extension (`src/{core,extension,ui}`) using headless `player_bridge.php` -> Kaltura progressive `format/url` MP4 + `chrome.downloads.download()`, verified via `npm run typecheck`, `npm test`, and `npm run build`. | **Closed (Resolved via DEC-003)** |

## 5. Responsibilities
* **CTO**: Records ratified project decisions and tracks resolution of open questions.

## 6. Relationships with Other Documents
* **Project Extension**: `.uesf/EXTENSION.md`
* **Knowledge Map**: `.uesf/KNOWLEDGE_MAP.md`
* **Task Registry**: `.uesf/ACTIVE_TASKS.md`
