# Stages 2 & 3 Investigation — Course, Academic Year & Lecture Discovery
* **Document ID**: MOODLE-DOC-003
* **Canonical Path**: docs/investigation/02-course-and-lecture-discovery.md
* **Version**: 0.1.0
* **Status**: Verified
* **Owner**: Architect
* **Last Updated**: 2026-11-19

## 1. Executive Summary
* **`[VERIFIED]`** Enrolled courses are listed cleanly on `/my/courses.php` via Moodle's AJAX service `core_course_get_enrolled_courses_by_timeline_classification` (returning all 24 enrolled courses in one JSON payload when `limit: 0`), while `/my/` ("Dashboard") only shows `recentlyaccessedcourses`, `timeline`, and calendar blocks (`hasMyOverview: false`).
* **`[VERIFIED]`** Academic years and degree codes are explicitly encoded in three places: `shortname` (`2025-PS3049-000ZZ-2025-PSQ4106920-N0-PS3049`), `fullname` suffix (`2025-2026`, `2026-2027`), and course category breadcrumbs (`A.A. 2025 - 2026 > ...`).
* **`[VERIFIED]`** Recorded video lectures on `psico.elearning.unipd.it` primarily use the **Kaltura Video Resource (`mod_kalvidres`)** plugin (`/mod/kalvidres/view.php?id=<cmid>`), supplemented by **Media Gallery (`local_kalturamediagallery`)**, **Video Time (`mod_videotime`)**, embedded **`mod_resource` MP4s**, and external **`mod_url`/`mod_page`/`mod_zoom`** links.

## 2. Stage 2 — Enrolled Course & Academic Year Discovery

### 2.1 Dashboard (`/my/`) vs. My Courses (`/my/courses.php`) (`[VERIFIED]`)
* `/my/` (`Dashboard | Moodle di Psicologia`): Renders `recentlyaccessedcourses`, `timeline`, `calendar_month`, `calendar_upcoming`, `private_files`, `badges`, `online_users`, and `teacher_assistant` — does **not** mount `block_myoverview`.
* `/my/courses.php` (`My courses | Moodle di Psicologia`): Mounts `.block_myoverview` (`[data-block="myoverview"]`) with timeline classification filters (`all`, `inprogress`, `future`, `past`, `favourites`, `hidden`), sort (`fullname`, `ul.timeaccess desc`), display modes (`card`, `list`, `summary`), and page limits (`12`, `24`, `0` = All).

### 2.2 Course Listing AJAX Endpoint (`[VERIFIED]`)
* **Endpoint**: `POST https://psico.elearning.unipd.it/lib/ajax/service.php?sesskey=[REDACTED]&info=core_course_get_enrolled_courses_by_timeline_classification`
* **Headers**: `Content-Type: application/json`, `X-Requested-With: XMLHttpRequest`, same-origin Moodle cookies.
* **Request Body**:
  ```json
  [{
    "index": 0,
    "methodname": "core_course_get_enrolled_courses_by_timeline_classification",
    "args": {
      "offset": 0,
      "limit": 0,
      "classification": "all",
      "sort": "fullname",
      "customfieldname": "",
      "customfieldvalue": "",
      "requiredfields": ["id", "fullname", "shortname", "showcoursecategory", "showshortname", "visible", "enddate"]
    }
  }]
  ```
* **Response Schema (`data.courses[]`, 24 courses observed, `offset: 24` -> `0`)**:
  * Core identifiers: `id` (int), `fullname`, `shortname`, `fullnamedisplay`, `idnumber`, `viewurl` (`https://psico.elearning.unipd.it/course/view.php?id=<id>`).
  * Academic year / taxonomy fields: `coursecategory` (e.g., `"PS3049 - APPLIED CHILD AND ADOLESCENT PSYCHOLOGY"`), `startdate` (Unix epoch), `enddate` (Unix epoch or `0`).
  * Visibility / user prefs: `visible` (bool), `isfavourite` (bool), `hidden` (bool), `progress`, `hasprogress`, `showshortname`, `courseimage` (SVG data URI or URL).
* **DOM Fallback Selectors (on `/my/courses.php`)**:
  * Card container: `[data-region="course-content"]` / `.course-card[data-course-id]` (or `.dashboard-card`)
  * Course link: `a.coursename[href*="/course/view.php?id="]`

### 2.3 Academic Year & Multi-Portal Structure (`[VERIFIED]` / `[OBSERVED]`)
* **Academic Year Extraction Order**:
  1. `shortname` regex: `^(20\d{2})-([A-Z0-9]+)-` (e.g., `2025-PS3049-...` -> AY `2025-2026`; `2026-PS3049-...` -> AY `2026-2027`).
  2. `fullname` trailing token: `\b(20\d{2}-20\d{2})\b` (e.g., `PSQ4107809 - PRINCIPLES AND APPLICATIONS OF PSYCHOLOGICAL TESTING 2026-2027`).
  3. Course breadcrumb category: `A.A. 2025 - 2026` (`/course/index.php?categoryid=553`) observed on activity pages.
* **Department Sub-Portals (`[OBSERVED]`)**: Footer link *Piattaforme Moodle in Ateneo* indicates sibling `*.elearning.unipd.it` school portals exist across UniPD; this project scopes to `psico.elearning.unipd.it` (`DEC-002`) while keeping host patterns modular.

## 3. Stage 3 — Course Structure & Video Lecture Taxonomy

### 3.1 Course Page DOM Structure (`[VERIFIED]`)
All 24 inspected enrolled courses use `format-topics` (`body.format-topics`).
* **Important Pitfall (`#course-index` vs. `#region-main`)**: Moodle 4.5 renders a left-hand `#course-index` drawer whose elements ALSO match `.course-section` (`#course-index-section-<id>`). Scoped queries **MUST** root at `#region-main`:
  * Sections: `#region-main li.section.course-section[data-sectionid]` (e.g., `id="section-3"`)
  * Section title: `.sectionname` (e.g., `"1. Introduction: Measurement and Validity — Oct 5 - 14"`)
  * Activities: `li.activity.modtype_<type>[data-id]` (`id="module-<cmid>"`)
  * Activity link: `a.aalink` (`/mod/<type>/view.php?id=<cmid>`)
  * Activity dates / badges: `[data-region="activity-dates"]`, `.activitybadge`, `.resourcelinkdetails`
  * Secondary navigation: `.secondary-navigation a[href*="/local/kalturamediagallery/index.php?courseid="]` (`Media Gallery`)

### 3.2 Complete Lecture & Material Module Taxonomy (`[VERIFIED]` Across All 24 Enrolled Courses)

| Moodle Module / Path | Occurrence in Inspected Courses | Content Type | Resolution Mechanism | Download Priority |
| :--- | :--- | :--- | :--- | :--- |
| **`mod_kalvidres`** (`/mod/kalvidres/view.php?id=<cmid>`) | **Primary lecture host** (8 courses; up to 18 lectures/course, e.g., `7075`, `7003`, `6559`, `6248`, `6403`, `6224`, `4001`, `6225`) | Kaltura recorded lectures & workshops | Same-origin `player_bridge.php?cmid=<cmid>` -> Kaltura `entryId` + `ks` | **P0 (Core Target)** |
| **`local_kalturamediagallery`** (`/local/kalturamediagallery/index.php?courseid=<id>`) | Secondary nav tab on most courses | Kaltura course channel on `media19.elearning.unipd.it` | LTI 1.0 auto-POST (`lti_launch.php`) -> cross-origin MediaSpace iframe (`5` vs `7` items in `7075`; `0` in `6135`) | **P1 (Optional Supplement)** |
| **`mod_videotime`** (`/mod/videotime/view.php?id=<cmid>`) | Observed in `6311` (1 item) & `6200` (5 items) | VideoJS Moodle `.mp4` OR YouTube embed | Local MP4: `/pluginfile.php/<ctx>/videotimeplugin_videojs/mediafile/0/*.mp4`; External: `youtube.com/embed/...` | **P1 (Moodle MP4 only)** / Out of Scope (YouTube) |
| **`mod_resource`** (`/mod/resource/view.php?id=<cmid>`) | All courses (5–53 items/course) | Slides/PDFs (`application/pdf`) OR embedded `.mp4` (`275926`) | `303`/redirect to `/pluginfile.php/<ctx>/mod_resource/content/...` OR HTML `<video><source src="/pluginfile.php/...">` | **P1 (MP4)** / **Phase 2 (PDFs/Slides)** |
| **`mod_folder`** (`/mod/folder/view.php?id=<cmid>`) | Common (datasets, code, slide packs) | Multiple static files | HTML anchors `<a href=".../pluginfile.php/<ctx>/mod_folder/content/...">` | **Phase 2 (Static Materials)** |
| **`mod_url`** / **`mod_page`** / **`mod_zoom`** | Common (`255107`, `265986`, `296772`) | External Zoom shares (`unipd.zoom.us/rec/share/...`), YouTube links, live links | External host authentication / third-party limits | **P2 / Out of Scope (Initial MV3)** |

### 3.3 Metadata Available for Human-Friendly Filenames (`[VERIFIED]`)
From `core_course_get_enrolled_courses_by_timeline_classification` + `#region-main` DOM + Kaltura `baseEntry.list`:
1. **Academic Year**: `2025-2026` / `2026-2027`
2. **Course Code & Title**: e.g., `PSQ4107809` — `PRINCIPLES AND APPLICATIONS OF PSYCHOLOGICAL TESTING`
3. **Section / Topic Name & Index**: e.g., `03 - 1. Introduction: Measurement and Validity — Oct 5 - 14`
4. **Activity Name (`cmid`)**: e.g., `Recorded Lecture: Unit 1 Introduction to Measurement and Validity` (plus dates if embedded in title like `Class 1 Sep 29`)
5. **Kaltura Entry Metadata**: `name` (`Unit 1 Lecture: What is Measurement`), `createdAt` (Unix timestamp), `duration` (seconds), `width`/`height` (`1920x1080`).

Suggested canonical filename template (after filesystem sanitization):
`{AY}/{CourseCode} - {CourseTitle}/{SectionNum}_{SectionTitle}/{ActivityIndex} - {Title} ({Resolution}).mp4`
