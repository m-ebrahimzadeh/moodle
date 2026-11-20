# UniPD Moodle Lecture Extension (`moodle`)
* **Document ID**: MOODLE-DOC-001
* **Canonical Path**: README.md
* **Version**: 0.1.0
* **Status**: Verified
* **Owner**: Architect
* **Last Updated**: 2026-11-19

## 1. Project Overview
`moodle` is an independent Manifest V3 (MV3) Chrome Extension project designed for the University of Padua (UniPD) Psychology Moodle portal (`https://psico.elearning.unipd.it`), conceptually aligned with PoliRecord (`DEC-002`). All discovery, authentication reuse, stream resolution, and download orchestration run inside the user's browser session without a backend server or external bot.

* **Current Lifecycle Phase**: Architecture Ratified (`TASK-002` `ACCEPTED`, `DEC-003` / `OQ-002` Closed) — `TASK-003` (`HO-TASK-003-01.md`) contracted and ready to implement the Phase 1 MVP (`v0.1.0`) MV3 Chrome Extension.
* **Target Platform**: Moodle `4.5` (`tool_consumer_info_version: 2024100713.01`, `dlm_theme`) at `https://psico.elearning.unipd.it`, backed by UniPD Shibboleth IdP v5 (`shibidp.cca.unipd.it`) and Kaltura (`partnerId: 2203921`, `cdnapisec.kaltura.com` / `cfvod.kaltura.com`).
* **Reference Baseline**: `c:\Users\user\Project\polisdk` (`[REPORTED]` — strictly read-only architectural comparison; zero runtime coupling).

## 2. Knowledge Base Index (`docs/`)
Permanent investigation findings and architectural synthesis live in `docs/` (indexed 1-to-1 in [KNOWLEDGE_MAP.md](file:///c:/Users/user/Project/moodle/.uesf/KNOWLEDGE_MAP.md)):

1. [01-auth-and-session-flow.md](file:///c:/Users/user/Project/moodle/docs/investigation/01-auth-and-session-flow.md) — Stage 1 findings: `/login/index.php`, UniPD Shibboleth SAML2 redirect & `/sp-shibboleth.sso/SAML2/POST` callback, authenticated DOM markers, redacted cookie inventory, and MV3 session implications.
2. [02-course-and-lecture-discovery.md](file:///c:/Users/user/Project/moodle/docs/investigation/02-course-and-lecture-discovery.md) — Stages 2–3 findings: `/my/courses.php` AJAX API (`core_course_get_enrolled_courses_by_timeline_classification`), academic year/category structure, course DOM selectors, and the complete video/material module taxonomy (`mod_kalvidres`, `local_kalturamediagallery`, `mod_videotime`, `mod_resource`, `mod_folder`, `mod_url`).
3. [03-video-playback-and-download-mechanics.md](file:///c:/Users/user/Project/moodle/docs/investigation/03-video-playback-and-download-mechanics.md) — Stages 4–5 findings: Kaltura `player_bridge.php` same-origin embed, `multirequest` playback context, HLS vs. direct progressive MP4 (`format/url` / `format/download`) proof, IDM interception mechanics, WebVTT captions, URL/KS TTLs, and MV3 download feasibility.
4. [01-discovery-synthesis-and-options.md](file:///c:/Users/user/Project/moodle/docs/architecture/01-discovery-synthesis-and-options.md) — Synthesis comparing UniPD vs. PoliSDK (`WeBeep` / `PoliRecord` / `poliauth-chrome`), MV3 architecture options, pros/cons, and concrete recommendations for `OQ-002`.

## 3. Governance & Operational Control Plane (`.uesf/`)
This repository follows UESF `v0.9.0` Three-Domain Governance (`DEC-001`):
* **Operational Ledgers**: [EXTENSION.md](file:///c:/Users/user/Project/moodle/.uesf/EXTENSION.md), [KNOWLEDGE_MAP.md](file:///c:/Users/user/Project/moodle/.uesf/KNOWLEDGE_MAP.md), [ACTIVE_TASKS.md](file:///c:/Users/user/Project/moodle/.uesf/ACTIVE_TASKS.md), [DECISION_LOG.md](file:///c:/Users/user/Project/moodle/.uesf/DECISION_LOG.md), and machine-generated [CONTEXT_SNAPSHOT.md](file:///c:/Users/user/Project/moodle/.uesf/CONTEXT_SNAPSHOT.md).
* **Snapshot Refresh**: Run `node .uesf/bin/uesf.mjs sync-snapshot` after editing any canonical `.md` document.
