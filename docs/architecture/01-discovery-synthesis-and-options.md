# Architecture Synthesis & MV3 Design Options (`OQ-002`)
* **Document ID**: MOODLE-DOC-005
* **Canonical Path**: docs/architecture/01-discovery-synthesis-and-options.md
* **Version**: 0.1.0
* **Status**: Verified
* **Owner**: Architect
* **Last Updated**: 2026-11-19

## 1. UniPD (`psico.elearning.unipd.it`) vs. PoliSDK Architectural Baseline

Comparisons below reference `c:\Users\user\Project\polisdk` (`[REPORTED]` / `[VERIFIED]` from read-only source inspection) strictly as a design comparison:

| Dimension | PoliMi (`@polisdk/webeep` + `@polisdk/polirecord`) | UniPD (`psico.elearning.unipd.it` — Verified Live) | Design Impact for `moodle` |
| :--- | :--- | :--- | :--- |
| **Moodle Auth / SSO** | `webeep-sso-spec.ts` (`WEBEEP_SHIBBOLETH_FLOW_SPEC`): `/login/index.php` -> `auth/shibboleth/index.php` -> `aunicalogin.polimi.it` / `shibidp.polimi.it` -> `Shibboleth.sso/SAML2/POST` | `/login/index.php` (`a.login-identityprovider-btn`) -> `/auth/shibboleth/index.php` -> `shibidp.cca.unipd.it` (Shibboleth IdP v5) -> **`/sp-shibboleth.sso/SAML2/POST`** | Needs UniPD-specific SP path, `MoodleSessionpsico` cookie awareness, and interactive human login (no hidden iframes due to `frame-ancestors 'none'`). |
| **Course Discovery** | `webeep-http-client.ts`: HTML scraping of `/my/` + `/course/view.php?id=...` | `/my/` lacks `block_myoverview`; **`/my/courses.php`** uses `POST /lib/ajax/service.php?sesskey=...&info=core_course_get_enrolled_courses_by_timeline_classification` | One JSON API call fetches all courses (`limit: 0`), codes (`PSQ...`), academic years (`2025-2026`, `2026-2027`), and categories cleanly. |
| **Lecture Host** | External `ArchivioListActivity.do` (`#transfers` table) launching Cisco Webex (`politecnicomilano.webex.com`) via SAML (`polirecord-spec.ts`) | **Embedded directly inside Moodle courses** as `mod_kalvidres` (`/mod/kalvidres/view.php?id=<cmid>`) + `local_kalturamediagallery` (`media19.elearning.unipd.it`) + occasional `mod_videotime`/`mod_resource` | Zero external archive scraping needed! One course DOM pass (`#region-main li.section`) discovers lectures, slides/PDFs, and section dates together. |
| **Player & Auth Bridge** | Cross-origin Webex page with UI download dialog (`#playerDownload_<uuid>` -> `#Dlg_download_confirm` -> `iframe_MP4`) | **Same-origin** `<iframe id="contentframe" src="/mod/kalvidres/player_bridge.php?cmid=<cmid>">` containing pre-minted Kaltura `ks` (`1h` TTL) | Extension can resolve `entryId` + `ks` directly from `player_bridge.php` via authenticated same-origin `fetch()` **without even opening video tabs!** |
| **Stream & Download** | Official Webex MP4 download iframe | Kaltura PlayKit streams unencrypted HLS (`.m3u8` + `.ts`), **AND** `playManifest/.../format/url/.../a.mp4` serves a direct `206 video/mp4` progressive stream (`24h` CDN TTL, zero DRM) | Pure `chrome.downloads.download()` handles **single-file MP4 downloads natively** (167–613 MB) without needing Webex-style UI click automation! |
| **MV3 Tab Driver** | `@polisdk/poliauth-chrome` (`ChromeExtensionTabDriver` via `chrome.tabs.sendMessage` with transient navigation retries & redaction) | Side Panel / Popup + Background Service Worker + lightweight Content Script on `psico.elearning.unipd.it` (`chrome.tabs.sendMessage` / `fetch`) | Much simpler: Moodle session resides in normal Chrome cookies; extension queries Moodle + Kaltura APIs directly from extension/page context. |

## 2. Chrome Extension (MV3) Architecture Options (`OQ-002`)

### Option A — Pure MV3 Extension Using Direct Progressive MP4 (`chrome.downloads`) + Optional Offscreen HLS Fallback *(Recommended)*
* **How It Works**:
  1. **Session & Discovery**: Background Service Worker + Side Panel / Popup detects an authenticated `psico.elearning.unipd.it` tab (or opens `/auth/shibboleth/index.php` for manual user login), extracts `M.cfg.sesskey` via content script, calls `core_course_get_enrolled_courses_by_timeline_classification` (`limit: 0`), and parses selected course pages (`#region-main li.section.course-section`) to list `mod_kalvidres`, `mod_videotime`, `mod_resource`, and `mod_folder` items.
  2. **Stream Resolution (Headless / Zero-Tab-Spam)**: For each selected `mod_kalvidres` `cmid`, `fetch('/mod/kalvidres/player_bridge.php?cmid=' + cmid)` extracts `partnerId`, `entryId`, and `ks` -> calls `POST https://cdnapisec.kaltura.com/api_v3/service/multirequest` (`baseEntry.list` + `getPlaybackContext`) -> selects highest (or user-chosen) `flavorAssets[]` MP4 + optional `.vtt` subtitles -> resolves `playManifest/.../flavorId/<fid>/format/url/protocol/https/a.mp4?ks=<ks>`.
  3. **Download Execution**: Calls `chrome.downloads.download({ url, filename })` directly! Chrome's native download manager handles 600 MB+ files, pause/resume (`206 Partial Content`), zero memory overhead, and automatic folder organization (`{AY}/{Course}/{Section}/{Lecture}.mp4`).
  4. **Moodle `pluginfile.php` Support (`mod_videotime` MP4 / `mod_resource` PDFs/slides)**: Handled identically by `chrome.downloads.download()` because Chrome attaches active `MoodleSessionpsico` + `HttpOnly` `_shibsession_*` cookies automatically!
  5. **Phase 2 / Edge-Case Resilience**: If an entry ever lacks a progressive `format/url` MP4 (HLS-only fallback), an MV3 Offscreen Document (`chrome.offscreen`) with `mux.js` / `mp4box.js` can fetch unencrypted `.ts` segments (`Access-Control-Allow-Origin: *`) and remux into MP4.
* **Pros**:
  * **Zero native binaries / zero installers** (100% Chrome Web Store compliant pure JS/TS MV3 extension).
  * **Zero RAM pressure** for 600 MB+ lectures (`chrome.downloads` streams straight to disk).
  * **Batch course scanning without opening 18 player tabs** (`player_bridge.php` is same-origin HTML fetchable with session cookies).
  * **Supports subtitles (`.vtt`) and slides/PDFs (`mod_resource`)** under the same unified download queue.
* **Cons**:
  * Requires explicit `host_permissions` for `https://psico.elearning.unipd.it/*`, `https://cdnapisec.kaltura.com/*`, `https://cfvod.kaltura.com/*`, and `https://cdnsecakmi.kaltura.com/*` (plus `https://media19.elearning.unipd.it/*` if Media Gallery scanning is added).
  * Pure `chrome.downloads` does not merge dual-stream Kaltura Capture PiP videos if any exist (`[UNKNOWN]` until seen; would require Offscreen WASM or Native Messaging if ever needed).

### Option B — Pure MV3 Offscreen HLS Remuxer (`chrome.offscreen` + `ffmpeg.wasm` / `mux.js`) as Primary Engine
* **How It Works**: Always fetches `.m3u8` -> downloads 240–1500 `.ts` segments in JS -> remuxes in memory/OPFS -> triggers `Blob` download.
* **Pros**: Works even if `format/url` progressive MP4 were disabled server-side; mirrors IDM's HLS capture path.
* **Cons**: Unnecessary complexity and high memory/OPFS pressure for 600 MB+ lectures when Kaltura already serves `206 video/mp4` directly (`5/5` courses verified); slower and higher risk of MV3 offscreen lifetime kills on 2.5-hour lectures.
* **Verdict**: Keep **only as an optional fallback** in Phase 2, not as the primary path.

### Option C — Chrome Extension + Local Native Messaging Helper (`yt-dlp` / `ffmpeg`)
* **How It Works**: Extension extracts `ks` / cookies / manifest URLs and delegates downloads to a locally installed Python/Go/Node native host + `ffmpeg`.
* **Pros**: Can mux dual-stream videos, download external YouTube (`mod_videotime`) or Zoom share (`mod_url`) links, and run arbitrary post-processing.
* **Cons**: Breaks pure Chrome Extension UX (`DEC-002`), requires cross-platform native host registration (`Windows Registry` / macOS/Linux manifests) and external `ffmpeg` binaries — unjustified when Kaltura & Moodle both serve direct `.mp4` streams!

## 3. Recommended Technology Stack & Verification Plan (`OQ-002` Proposal)

1. **Architecture**: **Option A** — Pure MV3 Chrome Extension (Side Panel UI + Background Service Worker + lightweight `psico.elearning.unipd.it` Content Script).
2. **Recommended Tech Stack**:
   * **Language**: TypeScript (`strict: true`)
   * **Build Tooling**: Vite + `@crxjs/vite-plugin` (or lightweight `esbuild`/`vite` MV3 multi-entry config with zero runtime bloat)
   * **UI**: Lightweight Preact/React or Vanilla TS + clean CSS for Chrome Side Panel (`chrome.sidePanel`) + course/lecture tree + batch download queue (`chrome.downloads`)
   * **Testing / Verification Gates**:
     * Type-check: `tsc --noEmit`
     * Unit tests: `vitest` (testing pure parsers for `shortname` AY extraction, `#region-main` course HTML parsing, `player_bridge.php` extraction, `multirequest` flavor selection, and sanitized filename builders against redacted fixtures)
     * Build check: `npm run build` producing clean `dist/manifest.json`
     * Live E2E verification via `chrome-devtools-mcp --categoryExtensions` (`load` unpacked extension -> inspect course -> resolve `format/url` -> verify `chrome.downloads` start/filename)
3. **Recommended Scope Phasing**:
   * **MVP (`v0.1.0`)**: UniPD SSO login status detection -> Enrolled Courses & Academic Year filter -> Course Lecture Discovery (`mod_kalvidres`) -> Quality selector + WebVTT captions -> Organized batch download via `chrome.downloads.download()` (`format/url` progressive MP4).
   * **Phase 2 (`v0.2.0`)**: Static course materials (`mod_resource` PDFs/slides/MP4s, `mod_folder`), `mod_videotime` Moodle MP4s, `local_kalturamediagallery` fallback, and optional Offscreen HLS fallback.

## 4. Ratified Architectural Blueprint & Module Contracts (`DEC-003`, `TASK-003`)

* **Ratified Decision (`DEC-003`)**: Option A adopted — single-package pure MV3 Chrome Extension (`src/{core,extension,ui}`, `tests/`). Phase 1 MVP (`v0.1.0`) targets video lectures (`mod_kalvidres` + Moodle-hosted `mod_videotime`/`mod_resource` `.mp4`s) and `.vtt` subtitles via Chrome Side Panel and `chrome.downloads.download()`. Static PDFs/slides (`mod_resource`, `mod_folder`), Media Gallery LTI fallback (`local_kalturamediagallery`), and Offscreen HLS remuxing are deferred to Phase 2 (`v0.2.0`).
* **Layering Invariant**: Strict unidirectional dependency `src/ui/ -> src/extension/ (typed messages) -> src/core/`. Modules under `src/core/` MUST have zero dependencies on `src/extension/`, `src/ui/`, or `chrome.*` globals so they remain 100% unit-testable in Vitest.

### 4.1 `src/core/` Domain & Protocol Contracts
1. **`src/core/types.ts`**:
   * `AcademicYear`: string union/alias (e.g., `'2026-2027' | '2025-2026' | string`)
   * `MoodleSessionInfo`: `{ authenticated: boolean; userId: number | null; sesskey: string | null; loginUrl: string }`
   * `EnrolledCourse`: `{ id: number; fullname: string; shortname: string; courseCode: string | null; title: string; academicYear: AcademicYear | null; category: string; viewUrl: string }`
   * `LectureActivityType`: `'kalvidres' | 'videotime' | 'resource'`
   * `CourseSection`: `{ sectionIndex: number; sectionId: string; title: string; activities: LectureActivity[] }`
   * `LectureActivity`: `{ cmid: number; courseId: number; sectionIndex: number; sectionTitle: string; activityIndex: number; title: string; type: LectureActivityType; url: string }`
   * `KalturaBridgeConfig`: `{ partnerId: number; uiconfId: number; entryId: string; ks: string; isPlaylist: boolean }`
   * `VideoFlavor`: `{ id: string; width: number; height: number; bitrateKbps: number; sizeBytes: number; fileExt: string; isOriginal: boolean; downloadUrl: string }`
   * `CaptionTrack`: `{ label: string; languageCode: string; vttUrl: string }`
   * `ResolvedLectureMedia`: `{ cmid: number; entryId: string | null; lectureTitle: string; durationSec: number | null; flavors: VideoFlavor[]; captions: CaptionTrack[]; directMp4Url: string | null }`
2. **`src/core/moodle-client.ts`**:
   * `extractMoodleSessionInfo(html: string, finalUrl: string): MoodleSessionInfo` — inspects `M.cfg` (`userId`, `sesskey`) and unauthenticated markers (`/login/`, `notloggedin`, `form#login`).
   * `parseCourseMetadata(rawCourse: RawMoodleCourse): EnrolledCourse` — extracts academic year (`shortname` prefix `^(20\d{2})-` or `fullname` `20\d{2}-20\d{2}`) and course code (`PSQ...` / `PSP...`).
   * `fetchEnrolledCourses(baseUrl: string, sesskey: string, fetchImpl?: typeof fetch): Promise<EnrolledCourse[]>` — calls `POST /lib/ajax/service.php?sesskey=...&info=core_course_get_enrolled_courses_by_timeline_classification` with `limit: 0`.
3. **`src/core/course-parser.ts`**:
   * `parseCourseSectionsFromHtml(html: string, courseId: number, baseUrl?: string): CourseSection[]` — strictly scoped to `#region-main li.section.course-section[data-sectionid]` (explicitly ignoring `#course-index` drawer duplicates), extracting `mod_kalvidres`, `mod_videotime`, and video-hinted `mod_resource` activities, plus resolving `/pluginfile.php/.../*.mp4` targets from `mod_videotime` and `mod_resource` HTML when fetched.
4. **`src/core/kaltura-client.ts`**:
   * `parseKalturaPlayerBridge(html: string): KalturaBridgeConfig` — parses `partnerId`, `uiconfId`, `entryId`, `ks`, and `isPlaylist` from `/mod/kalvidres/player_bridge.php?cmid=<cmid>`.
   * `buildKalturaProgressiveDownloadUrl(partnerId: number, entryId: string, flavorId: string, ks: string): string` — constructs `https://cdnapisec.kaltura.com/p/${partnerId}/sp/${partnerId}00/playManifest/entryId/${entryId}/flavorId/${flavorId}/format/url/protocol/https/a.mp4?ks=${encodeURIComponent(ks)}`.
   * `parseKalturaMultirequestResponse(json: unknown, partnerId: number, entryId: string, ks: string): Omit<ResolvedLectureMedia, 'cmid'>` — sorts MP4 `flavorAssets` highest resolution/bitrate first and extracts `.vtt` caption tracks from `playbackCaptions[].webVttUrl`.
   * `resolveKalturaLectureMedia(bridgeHtml: string, fetchImpl?: typeof fetch): Promise<Omit<ResolvedLectureMedia, 'cmid'>>` — executes `POST https://cdnapisec.kaltura.com/api_v3/service/multirequest` (`baseEntry.list` + `baseEntry.getPlaybackContext`).
5. **`src/core/path-builder.ts`**:
   * `sanitizePathSegment(segment: string, maxLen?: number): string` — removes OS-forbidden characters (`<>:"/\|?*`), control characters, and collapses whitespace cleanly for `chrome.downloads`.
   * `buildLectureDownloadPath(params: { academicYear: string | null; courseCode: string | null; courseTitle: string; sectionIndex: number; sectionTitle: string; activityIndex: number; lectureTitle: string; resolutionLabel?: string; ext: string }): string` — outputs `UniPD/{AY}/{CourseCode} - {CourseTitle}/{SectionNum} - {SectionTitle}/{ActivityNum} - {LectureTitle} ({Resolution}).{ext}`.

### 4.2 `src/extension/` & `src/ui/` Contracts
1. **`src/extension/messages.ts`**: Typed request/response union for Side Panel <-> Service Worker messaging (`GET_SESSION_STATUS`, `OPEN_SSO_LOGIN`, `LIST_COURSES`, `SCAN_COURSE_LECTURES`, `RESOLVE_LECTURE_MEDIA`, `ENQUEUE_DOWNLOADS`, `GET_QUEUE_STATE`).
2. **`src/extension/download-manager.ts`**: Bounded `chrome.downloads.download()` queue (max `2` concurrent downloads), tracking queued/in-progress/completed/failed states via `chrome.downloads.onChanged`.
3. **`src/extension/service-worker.ts`**: Configures `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`, orchestrates authenticated `fetch(..., { credentials: 'include' })` against Moodle and Kaltura, and forwards queue updates to the Side Panel.
4. **`src/ui/{sidepanel.html, sidepanel.css, sidepanel.ts}`**: Vanilla TypeScript + semantic HTML/CSS Side Panel featuring:
   * Auth status banner with **"Log in with UniPD Single Sign-On"** button (opens `https://psico.elearning.unipd.it/auth/shibboleth/index.php` and auto-refreshes when session becomes active)
   * Academic Year filter dropdown (`All`, `2026-2027`, `2025-2026`, etc.) and searchable course selector
   * Section/lecture checklist with resolution selector (`1080p` / `360p`), `.vtt` subtitle toggle, and file size badge
   * Live download queue progress panel

