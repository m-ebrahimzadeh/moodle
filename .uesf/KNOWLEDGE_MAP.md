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
