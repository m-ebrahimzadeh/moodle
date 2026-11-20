import { describe, expect, it } from 'vitest';
import {
  extractPluginfileMp4Url,
  extractPluginfileResourceUrl,
  parseContentDispositionFilename,
  parseCourseContentFromHtml,
  parseCourseSectionsFromHtml,
  parseFolderFilesFromHtml,
} from '../src/core/course-parser.js';
import {
  REDACTED_COURSE_PAGE_WITH_DRAWER_HTML,
  REDACTED_FOLDER_PAGE_HTML,
  REDACTED_RESOURCE_WRAPPER_HTML,
} from './fixtures/moodle-fixtures.js';

describe('course-parser', () => {
  describe('parseCourseSectionsFromHtml', () => {
    it('strictly isolates #region-main and ignores #course-index drawer duplicates', () => {
      const sections = parseCourseSectionsFromHtml(REDACTED_COURSE_PAGE_WITH_DRAWER_HTML, 7075);

      expect(sections).toHaveLength(1);
      const section = sections[0]!;
      expect(section.sectionId).toBe('1003');
      expect(section.sectionIndex).toBe(3);
      expect(section.title).toBe('1. Introduction: Measurement and Validity — Oct 5 - 14');

      expect(section.activities).toHaveLength(3);
      expect(section.activities.map((a) => ({ cmid: a.cmid, type: a.type, title: a.title }))).toEqual([
        {
          cmid: 300154,
          type: 'kalvidres',
          title: 'Recorded Lecture: Unit 1 Introduction',
        },
        {
          cmid: 255123,
          type: 'videotime',
          title: 'Lab Walkthrough Video',
        },
        {
          cmid: 275926,
          type: 'resource',
          title: 'Supplemental Clip (MP4)',
        },
      ]);

      // Ensures drawer title never leaked and sequential activityIndex was assigned
      expect(section.activities[0]?.title).not.toContain('Duplicate Drawer');
      expect(section.activities.map((a) => a.activityIndex)).toEqual([1, 2, 3]);
    });

    it('returns empty array when #region-main is missing even if #course-index exists', () => {
      const drawerOnlyHtml = `
        <nav id="course-index">
          <li class="section course-section" data-sectionid="99">
            <span class="sectionname">Drawer Only</span>
            <li class="activity modtype_kalvidres" data-id="12345">
              <a class="aalink" href="/mod/kalvidres/view.php?id=12345">Should Not Parse</a>
            </li>
          </li>
        </nav>`;

      expect(parseCourseSectionsFromHtml(drawerOnlyHtml, 7075)).toEqual([]);
    });

    it('keeps video resources with mid-title non-video extensions like Class_1.R.mp4 and Notes.pdf - Recording.mp4 [QA-009]', () => {
      const html = `
        <section id="region-main">
          <ul class="topics">
            <li id="section-1" class="section course-section" data-sectionid="2001" data-section="1">
              <h3 class="sectionname">Week 1</h3>
              <ul class="section">
                <li id="module-401" class="activity modtype_resource" data-id="401">
                  <a class="aalink" href="/mod/resource/view.php?id=401">
                    <span class="instancename">Class_1.R.mp4</span>
                  </a>
                </li>
                <li id="module-402" class="activity modtype_resource" data-id="402">
                  <a class="aalink" href="/mod/resource/view.php?id=402">
                    <span class="instancename">Notes.pdf - Recording.mp4</span>
                  </a>
                </li>
                <li id="module-403" class="activity modtype_resource" data-id="403">
                  <a class="aalink" href="/mod/resource/view.php?id=403">
                    <span class="instancename">Video analysis script.R</span>
                  </a>
                  <span class="resourcelinkdetails">Video companion file</span>
                </li>
                <li id="module-404" class="activity modtype_resource" data-id="404">
                  <a class="aalink" href="/mod/resource/view.php?id=404">
                    <span class="instancename">Lecture Video Transcript.pdf</span>
                  </a>
                </li>
              </ul>
            </li>
          </ul>
        </section>`;

      const sections = parseCourseSectionsFromHtml(html, 7075);
      expect(sections).toHaveLength(1);
      expect(sections[0]?.activities.map((a) => ({ cmid: a.cmid, title: a.title }))).toEqual([
        { cmid: 401, title: 'Class_1.R.mp4' },
        { cmid: 402, title: 'Notes.pdf - Recording.mp4' },
      ]);
    });
  });

  describe('extractPluginfileMp4Url', () => {
    it('extracts MP4 URL from <video><source> in mod_resource HTML', () => {
      const html = `
        <div id="region-main">
          <video controls>
            <source src="/pluginfile.php/12345/mod_resource/content/0/lecture_clip.mp4" type="video/mp4">
          </video>
        </div>`;

      expect(extractPluginfileMp4Url(html)).toBe(
        'https://psico.elearning.unipd.it/pluginfile.php/12345/mod_resource/content/0/lecture_clip.mp4',
      );
    });

    it('extracts escaped pluginfile MP4 URL from VideoJS mod_videotime markup', () => {
      const html = `
        <div data-setup='{"sources":[{"src":"https:\\/\\/psico.elearning.unipd.it\\/pluginfile.php\\/98765\\/videotimeplugin_videojs\\/mediafile\\/0\\/demo.mp4"}]}'></div>`;

      expect(extractPluginfileMp4Url(html)).toBe(
        'https://psico.elearning.unipd.it/pluginfile.php/98765/videotimeplugin_videojs/mediafile/0/demo.mp4',
      );
    });

    it('returns null for external YouTube mod_videotime embeds', () => {
      const html = `<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>`;
      expect(extractPluginfileMp4Url(html)).toBeNull();
    });

    it('rejects cross-origin and protocol-relative pluginfile.php MP4 URLs [ARCH-004 / QA-007]', () => {
      const crossOriginVideo = `
        <video>
          <source src="https://evil.example/pluginfile.php/12345/mod_resource/content/0/trap.mp4" type="video/mp4">
        </video>`;
      expect(extractPluginfileMp4Url(crossOriginVideo)).toBeNull();

      const crossOriginAnchor = `
        <a href="https://psico.elearning.unipd.it.evil.com/pluginfile.php/1/a.mp4">Download</a>`;
      expect(extractPluginfileMp4Url(crossOriginAnchor)).toBeNull();

      const protocolRelativeEvil = `
        <script>var u = "//evil.example/pluginfile.php/1/a.mp4";</script>`;
      expect(extractPluginfileMp4Url(protocolRelativeEvil)).toBeNull();
    });
  });

  describe('parseCourseContentFromHtml (Phase 2A static materials)', () => {
    it('partitions video lectures and static materials while isolating #region-main from #course-index', () => {
      const scan = parseCourseContentFromHtml(REDACTED_COURSE_PAGE_WITH_DRAWER_HTML, 7075);

      expect(scan.sections).toHaveLength(1);
      expect(scan.sections[0]?.activities.map((a) => a.cmid)).toEqual([300154, 255123, 275926]);

      expect(scan.materialSections).toHaveLength(2);
      const sec0 = scan.materialSections[0]!;
      expect(sec0.sectionIndex).toBe(0);
      expect(sec0.materials).toEqual([
        {
          cmid: 200002,
          courseId: 7075,
          sectionIndex: 0,
          sectionTitle: 'General',
          activityIndex: 1,
          title: 'Course Syllabus Video Notes.pdf',
          type: 'resource',
          url: 'https://psico.elearning.unipd.it/mod/resource/view.php?id=200002',
          fileTypeHint: 'pdf',
          detailsText: '1.4 MB PDF document',
        },
      ]);

      const sec3 = scan.materialSections[1]!;
      expect(sec3.sectionIndex).toBe(3);
      expect(sec3.materials).toEqual([
        {
          cmid: 296773,
          courseId: 7075,
          sectionIndex: 3,
          sectionTitle: '1. Introduction: Measurement and Validity — Oct 5 - 14',
          activityIndex: 1,
          title: 'Slide Deck Archive',
          type: 'folder',
          url: 'https://psico.elearning.unipd.it/mod/folder/view.php?id=296773',
          fileTypeHint: 'folder',
          detailsText: null,
        },
      ]);
    });

    it('detects R, Rmd, sav, jasp, and icon/details hints for static mod_resource items', () => {
      const html = `
        <section id="region-main">
          <ul class="topics">
            <li id="section-1" class="section course-section" data-sectionid="2010" data-section="1">
              <h3 class="sectionname">Week 2</h3>
              <ul class="section">
                <li id="module-501" class="activity modtype_resource" data-id="501">
                  <img class="activityicon" src="/theme/image.php/dlm_theme/core/1/f/powerpoint" alt="" />
                  <a class="aalink" href="/mod/resource/view.php?id=501"><span class="instancename">Week 2 Slides</span></a>
                  <span class="resourcelinkdetails">3.2 MB PowerPoint presentation</span>
                </li>
                <li id="module-502" class="activity modtype_resource" data-id="502">
                  <a class="aalink" href="/mod/resource/view.php?id=502"><span class="instancename">lab_script.R</span></a>
                </li>
                <li id="module-503" class="activity modtype_resource" data-id="503">
                  <a class="aalink" href="/mod/resource/view.php?id=503"><span class="instancename">survey_data.sav</span></a>
                </li>
                <li id="module-504" class="activity modtype_resource" data-id="504">
                  <a class="aalink" href="/mod/resource/view.php?id=504"><span class="instancename">anova.jasp</span></a>
                </li>
              </ul>
            </li>
          </ul>
        </section>`;

      const { materialSections } = parseCourseContentFromHtml(html, 7075);
      expect(materialSections).toHaveLength(1);
      expect(materialSections[0]?.materials.map((m) => [m.cmid, m.fileTypeHint, m.detailsText])).toEqual([
        [501, 'slides', '3.2 MB PowerPoint presentation'],
        [502, 'r', null],
        [503, 'sav', null],
        [504, 'jasp', null],
      ]);
    });
  });

  describe('extractPluginfileResourceUrl', () => {
    it('extracts same-origin pluginfile URLs from resourceworkaround, object, embed, iframe, and #region-main', () => {
      expect(extractPluginfileResourceUrl(REDACTED_RESOURCE_WRAPPER_HTML)).toBe(
        'https://psico.elearning.unipd.it/pluginfile.php/45678/mod_resource/content/1/Week%203%20Slides.pptx',
      );
      expect(
        extractPluginfileResourceUrl(
          '<object data="/pluginfile.php/10/mod_resource/content/0/doc.pdf" type="application/pdf"></object>',
        ),
      ).toBe('https://psico.elearning.unipd.it/pluginfile.php/10/mod_resource/content/0/doc.pdf');
      expect(
        extractPluginfileResourceUrl(
          '<embed src="https://psico.elearning.unipd.it/pluginfile.php/11/mod_resource/content/0/deck.pdf">',
        ),
      ).toBe('https://psico.elearning.unipd.it/pluginfile.php/11/mod_resource/content/0/deck.pdf');
      expect(
        extractPluginfileResourceUrl(
          '<iframe src="/pluginfile.php/12/mod_resource/content/0/handout.pdf"></iframe>',
        ),
      ).toBe('https://psico.elearning.unipd.it/pluginfile.php/12/mod_resource/content/0/handout.pdf');
      expect(
        extractPluginfileResourceUrl(
          '<div id="region-main"><a href="/pluginfile.php/13/mod_resource/content/0/data.csv">CSV</a></div>',
        ),
      ).toBe('https://psico.elearning.unipd.it/pluginfile.php/13/mod_resource/content/0/data.csv');
    });

    it('rejects cross-origin pluginfile resource URLs', () => {
      expect(
        extractPluginfileResourceUrl(
          '<div class="resourceworkaround"><a href="https://evil.example/pluginfile.php/1/a.pdf">Evil</a></div>',
        ),
      ).toBeNull();
    });
  });

  describe('parseFolderFilesFromHtml', () => {
    it('extracts nested subfolders, decodes filenames safely, deduplicates URLs, and rejects cross-origin links', () => {
      const files = parseFolderFilesFromHtml(REDACTED_FOLDER_PAGE_HTML);

      expect(files).toEqual([
        {
          fileIndex: 1,
          name: 'week_01 data.sav',
          subPath: ['Datasets'],
          ext: 'sav',
          url: 'https://psico.elearning.unipd.it/pluginfile.php/77777/mod_folder/content/0/Datasets/week_01%20data.sav?forcedownload=1',
        },
        {
          fileIndex: 2,
          name: 'README (1).pdf',
          subPath: [],
          ext: 'pdf',
          url: 'https://psico.elearning.unipd.it/pluginfile.php/77777/mod_folder/content/0/README%20%281%29.pdf?forcedownload=1',
        },
      ]);
    });

    it('returns empty array when #region-main is absent and tolerates malformed % encodings', () => {
      expect(parseFolderFilesFromHtml('<div class="foldertree"><a href="/pluginfile.php/1/mod_folder/content/0/a.pdf">a</a></div>')).toEqual([]);

      const malformedHtml = `
        <section id="region-main">
          <a href="/pluginfile.php/5/mod_folder/content/0/100%ZZ_notes.pdf">100%ZZ_notes.pdf</a>
        </section>`;
      const parsed = parseFolderFilesFromHtml(malformedHtml);
      expect(parsed).toHaveLength(1);
      expect(parsed[0]?.name).toBe('100%ZZ_notes.pdf');
      expect(parsed[0]?.ext).toBe('pdf');
    });
  });

  describe('parseContentDispositionFilename', () => {
    it('parses RFC 5987 UTF-8 filename* with precedence over quoted filename and strips traversal', () => {
      expect(parseContentDispositionFilename(null)).toBeNull();
      expect(
        parseContentDispositionFilename(
          `attachment; filename="fallback.pdf"; filename*=UTF-8''Lezione%203%20%E2%80%94%20Statistica.pptx`,
        ),
      ).toBe('Lezione 3 — Statistica.pptx');
      expect(
        parseContentDispositionFilename(`inline; filename="Week 3 Slides.pdf"`),
      ).toBe('Week 3 Slides.pdf');
      expect(
        parseContentDispositionFilename(`attachment; filename=../../etc/passwd.txt`),
      ).toBe('passwd.txt');
      expect(parseContentDispositionFilename(`attachment; filename=".."` )).toBeNull();
    });
  });
});
