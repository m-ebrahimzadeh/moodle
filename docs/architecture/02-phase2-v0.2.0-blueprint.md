# Phase 2 (`v0.2.0`) Architectural Blueprint & Module Contracts (`DEC-005`)
* **Document ID**: MOODLE-DOC-006
* **Canonical Path**: docs/architecture/02-phase2-v0.2.0-blueprint.md
* **Version**: 0.1.0
* **Status**: Approved
* **Owner**: Architect
* **Last Updated**: 2026-11-20

## 1. Purpose & Ratified Scope (`DEC-005`)
Define the permanent architectural blueprint, interface contracts, security boundaries, and phased milestone plan for **Phase 2 (`v0.2.0`)** of the UniPD Moodle MV3 Chrome Extension (`psico.elearning.unipd.it`), building cleanly on the accepted `v0.1.0` MVP (`DEC-002`, `DEC-003`, `TASK-003`).

| Milestone | Task ID | Scope | New Manifest Permissions | Track / Autonomy |
| :--- | :--- | :--- | :---: | :--- |
| **Phase 2.0 — CI & Governance** | `TASK-005` | GitHub Actions CI (`typecheck`, `test`, `build`, `dist/` hygiene, `sync-snapshot` drift check) + `OQ-001`/`DEC-005` governance commit | None | `Fast-Path` (`A2`) |
| **Phase 2A — Static Materials** | `TASK-006` | `mod_resource` (PDFs, slides, docs, archives, `.R`/`.Rmd`/`.sav`/`.jasp` datasets) + `mod_folder` multi-file packs, Option A `.../Materials/...` path layout, lazy resolution, Side Panel `Videos \| Materials` tabs | None | `Standard-Contract` (`A1`) |
| **Phase 2B — UX & Queue Polish** | `TASK-007` | Persistent user preferences (`chrome.storage.local`), secret-free `"Downloaded"` history badge + skip toggle, 1-click Queue `Retry` via persisted descriptors, HLS-only diagnostic detection badge | None | `Standard-Contract` (`A1`) |
| **Phase 2C — Media Gallery Spike** | `TASK-008` | `A0` live investigation spike for `local_kalturamediagallery` (`media19.elearning.unipd.it`) before optional `A1` implementation | `optional_host_permissions` (`A3` gated) | `A0` -> `Standard-Contract` |
| **Deferred (`v0.3.0+`)** | N/A | Offscreen HLS Remuxer (`chrome.offscreen`) & multi-portal `*.elearning.unipd.it` | `"offscreen"` (`A3`) | Trigger-gated on live telemetry |

## 2. Preserved Non-Negotiable Architectural Invariants
1. **Strict Unidirectional Layer Isolation (`DEC-003`)**:
   * `src/core/` MUST have zero `chrome.*`, `src/extension/`, or `src/ui/` imports.
   * `src/extension/` MUST have zero `src/ui/` imports.
   * `src/ui/` MAY import from `src/extension/` ONLY via `src/extension/messages`.
   * All three boundaries remain continuously enforced by `tests/layer-isolation.test.ts`.
2. **Zero Secret Boundary Leakage & MV3 Dormancy Resilience (`ARCH-001`)**:
   * Signed CDN URLs, `ks`, `sesskey`, and cookies never cross SW <-> UI messages and never enter `chrome.storage.session` or `chrome.storage.local`.
   * Every queued download (`video`, `subtitle`, `material`) persists a secret-free `DownloadResolutionDescriptor` and lazily resolves fresh URLs inside `service-worker.ts` upon dequeue.
3. **Zero Binary Buffering in Service Worker RAM (`ARCH-004`)**:
   * Any `GET` probe against `/mod/resource/view.php?id=<cmid>` MUST pass an `AbortController` signal and **immediately call `controller.abort()`** whenever Moodle redirects to a non-HTML binary response (`.pdf`, `.pptx`, `.zip`, etc.), reading only response URL/headers without buffering the body.
4. **Zero Request Storms on Large Courses**:
   * Courses on `psico.elearning.unipd.it` contain up to 53 `mod_resource` items (`docs/investigation/02-course-and-lecture-discovery.md` §3.2).
   * Course scanning MUST extract static material titles, icon/extension `fileTypeHint`s, and `.resourcelinkdetails` strictly from `#region-main` course HTML (`0` extra HTTP calls on course selection).
   * `mod_folder` file lists resolve lazily only when expanded or selected; `mod_resource` target `/pluginfile.php/...` URLs resolve lazily on download dequeue.

## 3. Phase 2A (`TASK-006`) Interface Contracts

### 3.1 `src/core/` Contracts
1. **`src/core/types.ts`** (Additive — 100% backward-compatible with `v0.1.0`):
   * `MaterialActivityType = 'resource' | 'folder'`
   * `CourseMaterialActivity`: `{ cmid: number; courseId: number; sectionIndex: number; sectionTitle: string; activityIndex: number; title: string; type: MaterialActivityType; url: string; fileTypeHint: string | null; detailsText: string | null }`
   * `CourseMaterialSection`: `{ sectionIndex: number; sectionId: string; title: string; materials: CourseMaterialActivity[] }`
   * `CourseContentScan`: `{ sections: CourseSection[]; materialSections: CourseMaterialSection[] }`
   * `FolderFileEntry`: `{ fileIndex: number; name: string; subPath: string[]; ext: string; url: string }`
   * `MaterialDownloadPathParams`: `{ academicYear: string | null; courseCode: string | null; courseTitle: string; sectionIndex: number; sectionTitle: string; activityIndex: number; materialTitle: string; folderName?: string | null; subPath?: string[]; fileName?: string | null; ext: string }`
2. **`src/core/course-parser.ts`**:
   * `parseCourseContentFromHtml(html: string, courseId: number, baseUrl?: string): CourseContentScan` — strictly scoped to `#region-main li.section.course-section[data-sectionid]`. Keeps `parseCourseSectionsFromHtml()` as a non-breaking wrapper returning `parseCourseContentFromHtml(...).sections`.
   * `extractPluginfileResourceUrl(html: string, baseUrl?: string): string | null` — extracts same-origin `/pluginfile.php/...` target from `.resourceworkaround a[href]`, `object[data]`, `embed[src]`, `iframe[src]`, or `#region-main a[href*="/pluginfile.php/"]`.
   * `parseFolderFilesFromHtml(html: string, baseUrl?: string): FolderFileEntry[]` — strictly scoped to `#region-main` (`.foldertree a[href*="/pluginfile.php/"]` with `#region-main` fallback), enforcing same-origin validation, safe `decodeURIComponent`, subfolder `subPath` preservation, and URL deduplication.
   * `parseContentDispositionFilename(header: string | null): string | null` — parses RFC 5987 `filename*` and standard `filename` parameters safely.
3. **`src/core/path-builder.ts`**:
   * `buildMaterialDownloadPath(params: MaterialDownloadPathParams): string` — **Option A (`DEC-005`)**:
     * Single `mod_resource`: `UniPD/{AY}/{CourseCode} - {CourseTitle}/{SectionNum} - {SectionTitle}/Materials/{ActivityNum} - {Title}.{ext}` (avoiding duplicate `.pdf.pdf` when title already ends in `.ext`).
     * `mod_folder` file: `UniPD/{AY}/{CourseCode} - {CourseTitle}/{SectionNum} - {SectionTitle}/Materials/{FolderName}/{optionalSubdir}/{FileName}.{ext}`.
     * Enforces `MAX_RELATIVE_DOWNLOAD_PATH_LENGTH = 180` and stem-based Windows reserved-name guards (`CON`, `NUL`, `AUX`, `COM1`–`COM9`, `LPT1`–`LPT9`).

### 3.2 `src/extension/` & `src/ui/` Contracts
1. **`src/extension/messages.ts`**:
   * `DownloadKind = 'video' | 'subtitle' | 'material'`
   * `PublicFolderFile`: `{ fileIndex: number; name: string; subPath: string[]; ext: string }` (secret-free — zero raw URLs).
   * `DownloadResolutionDescriptor`: discriminated union supporting both existing `{ kind: 'video' | 'subtitle'; activity: LectureActivity; ... }` and `{ kind: 'material'; material: CourseMaterialActivity; filename: string; folderFileIndex?: number; expectedFileName?: string }`.
   * `SCAN_COURSE_LECTURES` response extended additively with `materialSections: CourseMaterialSection[]` (zero breaking changes to existing handlers/tests).
   * New `RESOLVE_FOLDER_FILES` request (`{ type: 'RESOLVE_FOLDER_FILES'; material: CourseMaterialActivity }` -> `{ files: PublicFolderFile[] }`).
2. **`src/extension/download-manager.ts`**:
   * Allow `resolveDownloadUrl(descriptor)` to return either `string` or `{ url: string; resolvedFilename?: string; resolvedSizeBytes?: number }` so `mod_resource` files whose extension was unknown before redirect (e.g., Moodle title `"Week 3 Slides"` resolving to `slides.pptx`) receive the exact finalized filename/extension (still validated `<= 180` chars and Windows-safe!) right before `chrome.downloads.download()`.
3. **`src/extension/service-worker.ts`**:
   * `resolveMoodleResourceDownload(material, fetchImpl)` — enforces `MOODLE_ORIGIN`, `isLoginPageUrl()`, `isSameOrigin()`, immediate `controller.abort()` on binary redirects, `isUnauthenticatedMoodleHtml()` on HTML wrappers, `extractPluginfileResourceUrl()`, `ALLOWED_MEDIA_ORIGINS`, and `parseContentDispositionFilename()`.
   * `resolveMoodleFolderFiles(material, fetchImpl)` — enforces `MOODLE_ORIGIN`, `isLoginPageUrl()`, `isSameOrigin()`, `isUnauthenticatedMoodleHtml()`, and `parseFolderFilesFromHtml()`.
4. **`src/ui/{sidepanel.html, sidepanel.css, sidepanel.ts}`**:
   * Accessible tab bar (`role="tablist"`, `role="tab"`, `aria-selected`) switching between **`Videos (N)`** and **`Materials (M)`** inside `#lectures-panel` (heading updated to `"Course Content"`).
   * Materials list renders static `mod_resource` rows immediately (`PDF`, `Slides`, `Doc`, `Archive`, `File` badges + `.resourcelinkdetails`) and `mod_folder` rows with a lazy **"Load files"** expand button showing selectable child files or whole-folder selection.
   * Unified `Download Selected` bar and unified `Download Queue` displaying extension tags (`.mp4`, `.vtt`, `.pdf`, `.pptx`, `.zip`, etc.).

## 4. Phase 2B (`TASK-007`) & Phase 2C (`TASK-008`) Overview
* **`TASK-007` (UX, Persistence & Queue Polish)**:
  1. Persist `{ defaultQuality, includeVtt, activeContentTab, skipDownloaded }` in `chrome.storage.local` (zero secrets/PII).
  2. Maintain bounded LRU (500 entries) secret-free download history (`courseId:cmid:kind:variant`) in `chrome.storage.local` to render `"Downloaded"` badges and optional `"Skip already downloaded"` filtering.
  3. Retain secret-free `descriptor` on `failed`/`cancelled` queue items until cleared, adding `RETRY_DOWNLOAD` IPC and an accessible per-card `Retry` button.
  4. Detect HLS-only Kaltura responses (`flavors.length === 0 && hasAppleHttpSource`) in `kaltura-client.ts` -> surface `hlsOnly: true` diagnostic badge in Side Panel UI.
* **`TASK-008` (`local_kalturamediagallery` Spike -> Optional Supplement)**:
  1. `TASK-008.1` (`A0` Read-Only Spike): Verify live headless LTI OAuth 1.0 launch to `https://media19.elearning.unipd.it/hosted/index/course-gallery`, channel pagination, and `entryId` dedupe feasibility.
  2. `TASK-008.2` (Optional `Standard-Contract`, gated on `A3` approval): Implement on-demand `"Scan Media Gallery"` behind `"optional_host_permissions": ["https://media19.elearning.unipd.it/*"]`.

## 5. Relationships with Other Documents
* **Operational Ledgers**: `.uesf/EXTENSION.md`, `.uesf/KNOWLEDGE_MAP.md`, `.uesf/ACTIVE_TASKS.md`, `.uesf/DECISION_LOG.md` (`DEC-002`, `DEC-003`, `DEC-005`)
* **Prior Architecture & Investigation**: `docs/architecture/01-discovery-synthesis-and-options.md`, `docs/investigation/02-course-and-lecture-discovery.md`, `docs/investigation/03-video-playback-and-download-mechanics.md`
