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
