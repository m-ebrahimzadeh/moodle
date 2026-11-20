import { describe, expect, it } from 'vitest';
import {
  extractPluginfileMp4Url,
  parseCourseSectionsFromHtml,
} from '../src/core/course-parser.js';
import { REDACTED_COURSE_PAGE_WITH_DRAWER_HTML } from './fixtures/moodle-fixtures.js';

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
});
