import type { RawMoodleCourse } from '../../src/core/types.js';

export const REDACTED_AUTHENTICATED_MY_COURSES_HTML = `<!doctype html>
<html lang="en">
<head><title>My courses | Moodle di Psicologia</title></head>
<body class="format-site path-my chrome dir-ltr lang-en yui-skin-sam">
  <nav class="navbar">
    <div class="usermenu"><span class="logininfo">Signed in student</span></div>
    <a href="https://psico.elearning.unipd.it/my/courses.php">My courses</a>
  </nav>
  <script>
    var M = {};
    M.cfg = {"wwwroot":"https://psico.elearning.unipd.it","sesskey":"TESTKEY123","userId":424242,"theme":"dlm_theme"};
  </script>
</body>
</html>`;

export const REDACTED_LOGIN_PAGE_HTML = `<!doctype html>
<html lang="en">
<head><title>Log in | Moodle di Psicologia</title></head>
<body class="pagelayout-login notloggedin">
  <a class="login-identityprovider-btn" href="https://psico.elearning.unipd.it/auth/shibboleth/index.php">SingleSignOn - UniPD</a>
  <form id="login" class="login-form" method="post" action="/login/index.php"></form>
  <script>
    M.cfg = {"wwwroot":"https://psico.elearning.unipd.it","sesskey":"ANONKEY999","userId":0,"theme":"dlm_theme"};
  </script>
</body>
</html>`;

/**
 * Mirrors live UniPD Moodle behavior when requesting `/my/courses.php` with zero
 * cookies: HTTP 200 at `/my/courses.php`, no `notloggedin` body class, built-in
 * Moodle Guest account (`M.cfg.userId === 1`), `sesskey` present, `/login/index.php`
 * link present, and `/login/logout.php` absent.
 */
export const REDACTED_GUEST_MY_COURSES_HTML = `<!doctype html>
<html lang="en">
<head><title>My courses | Moodle di Psicologia</title></head>
<body class="format-site path-my chrome dir-ltr lang-en yui-skin-sam">
  <nav class="navbar">
    <div class="usermenu">
      <span class="logininfo">You are not logged in. (<a href="https://psico.elearning.unipd.it/login/index.php">Log in</a>)</span>
    </div>
    <a href="https://psico.elearning.unipd.it/my/courses.php">My courses</a>
  </nav>
  <script>
    var M = {};
    M.cfg = {"wwwroot":"https://psico.elearning.unipd.it","sesskey":"GUESTKEY123","userId":1,"theme":"dlm_theme"};
  </script>
</body>
</html>`;

export const REDACTED_IDP_PAGE_HTML = `<!doctype html>
<html lang="it">
<head><title>Servizio di Accesso Web - idp8-shib5</title></head>
<body>
  <form id="user-login-form" method="post" action="/idp/profile/SAML2/Redirect/SSO?execution=e2s1"></form>
</body>
</html>`;

export const REDACTED_RAW_COURSES: RawMoodleCourse[] = [
  {
    id: 7075,
    fullname: 'PSQ4107809 - PRINCIPLES AND APPLICATIONS OF PSYCHOLOGICAL TESTING 2026-2027',
    shortname: '2026-PS3049-000ZZ-2026-PSQ4107809-N0-PS3049',
    coursecategory: 'PS3049 - APPLIED CHILD AND ADOLESCENT PSYCHOLOGY',
    viewurl: 'https://psico.elearning.unipd.it/course/view.php?id=7075',
  },
  {
    id: 6248,
    fullname: 'DEVELOPMENTAL PSYCHOPATHOLOGY 2025-2026',
    shortname: '2025-PS3049-000ZZ-2025-PSQ4106920-N0-PS3049',
    coursecategory: 'PS3049 - APPLIED CHILD AND ADOLESCENT PSYCHOLOGY',
    viewurl: 'https://psico.elearning.unipd.it/course/view.php?id=6248',
  },
  {
    id: 6100,
    fullname: 'CLINICAL SEMINAR WORKSHOP',
    shortname: 'CLIN-SEM-GEN',
    coursecategory: 'A.A. 2024 - 2025 > Workshops',
  },
];

export const REDACTED_COURSE_PAGE_WITH_DRAWER_HTML = `<!doctype html>
<html lang="en">
<body class="format-topics">
  <!-- Left-hand Moodle 4.5 #course-index drawer duplicating .course-section selectors -->
  <nav id="course-index" class="courseindex">
    <ul>
      <li id="course-index-section-3" class="section course-section" data-sectionid="1003" data-section="3">
        <span class="sectionname">Drawer Duplicate Section</span>
        <ul>
          <li id="module-300154" class="activity modtype_kalvidres" data-id="300154">
            <a class="aalink" href="/mod/kalvidres/view.php?id=300154">
              <span class="instancename">Duplicate Drawer Lecture</span>
            </a>
          </li>
        </ul>
      </li>
    </ul>
  </nav>

  <!-- Authoritative main course content -->
  <section id="region-main">
    <ul class="topics">
      <li id="section-0" class="section course-section" data-sectionid="1000" data-section="0">
        <h3 class="sectionname">General</h3>
        <ul class="section">
          <li id="module-200001" class="activity modtype_forum" data-id="200001">
            <a class="aalink" href="/mod/forum/view.php?id=200001">
              <span class="instancename">Announcements<span class="accesshide"> Forum</span></span>
            </a>
          </li>
          <li id="module-200002" class="activity modtype_resource" data-id="200002">
            <img class="activityicon" src="https://psico.elearning.unipd.it/theme/image.php/dlm_theme/core/1/f/pdf" alt="PDF" />
            <a class="aalink" href="/mod/resource/view.php?id=200002">
              <span class="instancename">Course Syllabus Video Notes.pdf<span class="accesshide"> File</span></span>
            </a>
            <span class="resourcelinkdetails">1.4 MB PDF document</span>
          </li>
        </ul>
      </li>

      <li id="section-3" class="section course-section" data-sectionid="1003" data-section="3">
        <h3 class="sectionname">1. Introduction: Measurement and Validity — Oct 5 - 14</h3>
        <ul class="section">
          <li id="module-300154" class="activity modtype_kalvidres" data-id="300154">
            <a class="aalink" href="/mod/kalvidres/view.php?id=300154">
              <span class="instancename">Recorded Lecture: Unit 1 Introduction<span class="accesshide"> Kaltura Video Resource</span></span>
            </a>
          </li>
          <li id="module-255123" class="activity modtype_videotime" data-id="255123">
            <a class="aalink" href="/mod/videotime/view.php?id=255123">
              <span class="instancename">Lab Walkthrough Video<span class="accesshide"> Video Time</span></span>
            </a>
          </li>
          <li id="module-275926" class="activity modtype_resource" data-id="275926">
            <img class="activityicon" src="https://psico.elearning.unipd.it/theme/image.php/dlm_theme/core/1/f/mpeg" alt="Video" />
            <a class="aalink" href="/mod/resource/view.php?id=275926">
              <span class="instancename">Supplemental Clip (MP4)<span class="accesshide"> File</span></span>
            </a>
            <span class="resourcelinkdetails">24.1 MB video/mp4</span>
          </li>
          <li id="module-296772" class="activity modtype_url" data-id="296772">
            <a class="aalink" href="/mod/url/view.php?id=296772">
              <span class="instancename">External Zoom Share</span>
            </a>
          </li>
          <li id="module-296773" class="activity modtype_folder" data-id="296773">
            <a class="aalink" href="/mod/folder/view.php?id=296773">
              <span class="instancename">Slide Deck Archive</span>
            </a>
          </li>
        </ul>
      </li>
    </ul>
  </section>
</body>
</html>`;

export const REDACTED_PLAYER_BRIDGE_HTML = `<!doctype html>
<html>
<head>
  <script src="https://cdnapi.kaltura.com/p/2203921/embedPlaykitJs/uiconf_id/43513601"></script>
</head>
<body>
  <div id="kaltura_player"></div>
  <script>
    var partnerId = 2203921;
    var uiconfId = 43513601;
    var entryId = "1_sirqa9b5";
    var ks = "djJ8MjIwMzkyMXxTEST_REDACTED_KS_TOKEN_VALUE_001";
    var isPlaylist = false;
  </script>
</body>
</html>`;

export const REDACTED_KALTURA_MULTIREQUEST_RESPONSE = [
  {
    objectType: 'KalturaBaseEntryListResponse',
    objects: [
      {
        id: '1_sirqa9b5',
        name: 'Unit 1 Lecture: What is Measurement',
        duration: 2363,
      },
    ],
  },
  {
    objectType: 'KalturaPlaybackContext',
    flavorAssets: [
      {
        id: '1_yz2ebdzm',
        width: 640,
        height: 360,
        bitrate: 160,
        size: 46300,
        fileExt: 'mp4',
        isOriginal: false,
        status: 2,
      },
      {
        id: '1_c1qlwlrw',
        width: 1920,
        height: 1080,
        bitrate: 566,
        size: 163296,
        fileExt: 'mp4',
        isOriginal: true,
        status: 2,
      },
      {
        id: '1_notready',
        width: 1920,
        height: 1080,
        bitrate: 800,
        size: 200000,
        fileExt: 'mp4',
        isOriginal: false,
        status: 4,
      },
      {
        id: '1_audioonly',
        width: 0,
        height: 0,
        bitrate: 128,
        size: 12000,
        fileExt: 'm4a',
        isOriginal: false,
        status: 2,
      },
    ],
    playbackCaptions: [
      {
        label: 'English (auto)',
        language: 'English',
        languageCode: 'en',
        webVttUrl:
          'https://cdnsecakmi.kaltura.com/api_v3/index.php/service/caption_captionasset/action/serveWebVTT/captionAssetId/1_cap001/captions.vtt',
      },
      {
        label: 'English duplicate',
        language: 'English',
        languageCode: 'en',
        webVttUrl:
          'https://cdnsecakmi.kaltura.com/api_v3/index.php/service/caption_captionasset/action/serveWebVTT/captionAssetId/1_cap001/captions.vtt',
      },
      {
        label: 'Italiano',
        language: 'Italian',
        languageCode: 'it',
        webVttUrl:
          'https://cdnsecakmi.kaltura.com/api_v3/index.php/service/caption_captionasset/action/serveWebVTT/captionAssetId/1_cap002/captions.vtt',
      },
    ],
    drm: [],
  },
];
