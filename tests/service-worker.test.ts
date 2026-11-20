import { describe, expect, it, vi } from 'vitest';
import type { CourseMaterialActivity, LectureActivity } from '../src/core/types.js';
import {
  buildHistoryKeyFromDescriptor,
  handleMessage,
  isMoodlePostLoginUrl,
  readDownloadHistory,
  recordCompletedDownloadHistory,
  resolveActivityMedia,
  resolveDownloadUrlFromDescriptor,
  resolveMoodleFolderFiles,
  resolveMoodleHostedMp4,
  resolveMoodleResourceDownload,
  toPublicFolderFiles,
  toPublicLectureMedia,
} from '../src/extension/service-worker.js';
import {
  REDACTED_COURSE_PAGE_WITH_DRAWER_HTML,
  REDACTED_FOLDER_PAGE_HTML,
  REDACTED_GUEST_MY_COURSES_HTML,
  REDACTED_KALTURA_MULTIREQUEST_RESPONSE,
  REDACTED_LOGIN_PAGE_HTML,
  REDACTED_PLAYER_BRIDGE_HTML,
  REDACTED_RESOURCE_WRAPPER_HTML,
} from './fixtures/moodle-fixtures.js';

function makeActivity(overrides: Partial<LectureActivity> = {}): LectureActivity {
  return {
    cmid: 255123,
    courseId: 7075,
    sectionIndex: 3,
    sectionTitle: 'Week 1',
    activityIndex: 1,
    title: 'Lab Walkthrough Video',
    type: 'videotime',
    url: 'https://psico.elearning.unipd.it/mod/videotime/view.php?id=255123',
    ...overrides,
  };
}

describe('service-worker helpers', () => {
  describe('resolveMoodleHostedMp4 [ARCH-004 / QA-007]', () => {
    it('throws auth-expired error on login redirect instead of non-MP4 embed', async () => {
      let capturedSignal: AbortSignal | undefined;
      const mockFetch = vi.fn<typeof fetch>(async (_input, init) => {
        capturedSignal = init?.signal ?? undefined;
        const res = new Response(REDACTED_LOGIN_PAGE_HTML, {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
        Object.defineProperty(res, 'url', {
          value: 'https://psico.elearning.unipd.it/login/index.php',
        });
        return res;
      });

      await expect(resolveMoodleHostedMp4(makeActivity(), mockFetch)).rejects.toThrow(
        /session expired/i,
      );
      expect(capturedSignal?.aborted).toBe(true);
    });

    it('throws auth-expired error when Moodle returns guest userId=1 HTML or notloggedin body', async () => {
      const guestFetch = vi.fn<typeof fetch>(async () => {
        const res = new Response(REDACTED_GUEST_MY_COURSES_HTML, {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
        Object.defineProperty(res, 'url', {
          value: 'https://psico.elearning.unipd.it/mod/videotime/view.php?id=255123',
        });
        return res;
      });

      await expect(resolveMoodleHostedMp4(makeActivity(), guestFetch)).rejects.toThrow(
        /session expired/i,
      );

      const notLoggedInFetch = vi.fn<typeof fetch>(async () => {
        const res = new Response('<body class="notloggedin"><div>Please log in</div></body>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
        Object.defineProperty(res, 'url', {
          value: 'https://psico.elearning.unipd.it/mod/videotime/view.php?id=255123',
        });
        return res;
      });

      await expect(resolveMoodleHostedMp4(makeActivity(), notLoggedInFetch)).rejects.toThrow(
        /session expired/i,
      );
    });

    it('immediately aborts non-HTML binary responses (.pdf / .zip) without reading response body', async () => {
      let capturedSignal: AbortSignal | undefined;
      const textSpy = vi.fn(async () => 'SHOULD_NEVER_BE_READ');

      const pdfFetch = vi.fn<typeof fetch>(async (_input, init) => {
        capturedSignal = init?.signal ?? undefined;
        return {
          ok: true,
          status: 200,
          url: 'https://psico.elearning.unipd.it/pluginfile.php/123/mod_resource/content/0/slides.pdf',
          headers: new Headers({ 'Content-Type': 'application/pdf', 'Content-Length': '52428800' }),
          text: textSpy,
        } as unknown as Response;
      });

      const result = await resolveMoodleHostedMp4(
        makeActivity({ type: 'resource', url: 'https://psico.elearning.unipd.it/mod/resource/view.php?id=275926' }),
        pdfFetch,
      );

      expect(capturedSignal?.aborted).toBe(true);
      expect(textSpy).not.toHaveBeenCalled();
      expect(result.flavors).toEqual([]);
      expect(result.directMp4Url).toBeNull();
    });

    it('extracts same-origin pluginfile.php MP4 from HTML and probes HEAD Content-Length', async () => {
      const mockFetch = vi.fn<typeof fetch>(async (input, init) => {
        const url = String(input);
        if (init?.method === 'HEAD') {
          return new Response(null, {
            status: 200,
            headers: { 'Content-Length': '12345678' },
          });
        }
        const res = new Response(
          `<video><source src="/pluginfile.php/99/mod_resource/content/0/clip.mp4" type="video/mp4"></video>`,
          {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          },
        );
        Object.defineProperty(res, 'url', { value: url });
        return res;
      });

      const resolved = await resolveMoodleHostedMp4(makeActivity(), mockFetch);
      expect(resolved.directMp4Url).toBe(
        'https://psico.elearning.unipd.it/pluginfile.php/99/mod_resource/content/0/clip.mp4',
      );
      expect(resolved.flavors[0]?.sizeBytes).toBe(12345678);
      expect(resolved.flavors[0]?.fileExt).toBe('mp4');
    });

    it('aborts cross-origin HTML redirects before reading body and preserves non-MP4 video extensions [ARCH-NOTE-004]', async () => {
      let capturedSignal: AbortSignal | undefined;
      const textSpy = vi.fn(async () => '<html>external</html>');
      const externalRedirectFetch = vi.fn<typeof fetch>(async (_input, init) => {
        capturedSignal = init?.signal ?? undefined;
        return {
          ok: true,
          status: 200,
          url: 'https://external.example/embed/video',
          headers: new Headers({ 'Content-Type': 'text/html; charset=utf-8' }),
          text: textSpy,
        } as unknown as Response;
      });

      const externalResult = await resolveMoodleHostedMp4(makeActivity(), externalRedirectFetch);
      expect(capturedSignal?.aborted).toBe(true);
      expect(textSpy).not.toHaveBeenCalled();
      expect(externalResult.directMp4Url).toBeNull();
      expect(externalResult.flavors).toEqual([]);

      const webmFetch = vi.fn<typeof fetch>(async () => {
        const res = new Response(null, {
          status: 200,
          headers: { 'Content-Type': 'video/webm', 'Content-Length': '2048000' },
        });
        Object.defineProperty(res, 'url', {
          value: 'https://psico.elearning.unipd.it/pluginfile.php/99/mod_resource/content/0/clip.webm',
        });
        return res;
      });

      const webmResult = await resolveMoodleHostedMp4(makeActivity(), webmFetch);
      expect(webmResult.flavors[0]?.fileExt).toBe('webm');
      expect(webmResult.flavors[0]?.sizeBytes).toBe(2048000);
    });
  });

  describe('resolveActivityMedia, toPublicLectureMedia, and lazy descriptor resolution [ARCH-001]', () => {
    it('throws auth-expired when kalvidres player_bridge.php returns guest userId=1 HTML', async () => {
      const mockFetch = vi.fn<typeof fetch>(async () => {
        const res = new Response(REDACTED_GUEST_MY_COURSES_HTML, {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
        Object.defineProperty(res, 'url', {
          value: 'https://psico.elearning.unipd.it/mod/kalvidres/player_bridge.php?cmid=300154',
        });
        return res;
      });

      await expect(
        resolveActivityMedia(makeActivity({ cmid: 300154, type: 'kalvidres' }), mockFetch),
      ).rejects.toThrow(/session expired/i);
    });

    it('strips all signed ?ks= URLs in toPublicLectureMedia and lazily mints fresh URLs from descriptors', async () => {
      const mockFetch = vi.fn<typeof fetch>(async (input) => {
        const url = String(input);
        if (url.includes('player_bridge.php')) {
          const res = new Response(REDACTED_PLAYER_BRIDGE_HTML, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          });
          Object.defineProperty(res, 'url', { value: url });
          return res;
        }
        return new Response(JSON.stringify(REDACTED_KALTURA_MULTIREQUEST_RESPONSE), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const kalActivity = makeActivity({
        cmid: 300154,
        type: 'kalvidres',
        url: 'https://psico.elearning.unipd.it/mod/kalvidres/view.php?id=300154',
      });

      const internalMedia = await resolveActivityMedia(kalActivity, mockFetch);
      const publicMedia = toPublicLectureMedia(internalMedia);

      // Zero ks, playManifest, downloadUrl, vttUrl, or directMp4Url may cross SW -> UI
      const serializedPublic = JSON.stringify(publicMedia);
      expect(serializedPublic).not.toContain('TEST_REDACTED_KS_TOKEN_VALUE_001');
      expect(serializedPublic).not.toContain('playManifest');
      expect(serializedPublic).not.toContain('downloadUrl');
      expect(serializedPublic).not.toContain('vttUrl');
      expect(serializedPublic).not.toContain('directMp4Url');
      expect(publicMedia.hasDirectMp4).toBe(true);
      expect(publicMedia.flavors).toHaveLength(2);
      expect(publicMedia.captions).toHaveLength(2);

      // Lazy resolution mints fresh progressive MP4 and WebVTT URLs
      const mp4Url = await resolveDownloadUrlFromDescriptor(
        {
          activity: kalActivity,
          kind: 'video',
          filename: 'UniPD/2026-2027/Course/01/01 - Lecture (360p).mp4',
          preferredFlavorId: '1_yz2ebdzm',
          preferredHeight: 360,
        },
        mockFetch,
      );
      expect(mp4Url).toContain('/flavorId/1_yz2ebdzm/format/url/protocol/https/a.mp4?ks=');

      const vttUrl = await resolveDownloadUrlFromDescriptor(
        {
          activity: kalActivity,
          kind: 'subtitle',
          filename: 'UniPD/2026-2027/Course/01/01 - Lecture (it).vtt',
          captionLanguageCode: 'it',
          captionLabel: 'Italiano',
          captionIndex: 1,
        },
        mockFetch,
      );
      expect(vttUrl).toBe(
        'https://cdnsecakmi.kaltura.com/api_v3/index.php/service/caption_captionasset/action/serveWebVTT/captionAssetId/1_cap002/captions.vtt',
      );
    });
  });

  describe('origin guards and handleMessage fallback [ARCH-008 / QA-011]', () => {
    it('enforces exact origin matching in isMoodlePostLoginUrl', () => {
      expect(isMoodlePostLoginUrl('https://psico.elearning.unipd.it/my/courses.php')).toBe(true);
      expect(isMoodlePostLoginUrl('https://psico.elearning.unipd.it/login/index.php')).toBe(false);
      expect(isMoodlePostLoginUrl('https://psico.elearning.unipd.it/auth/shibboleth/index.php')).toBe(false);
      expect(isMoodlePostLoginUrl('https://psico.elearning.unipd.it.evil.com/my/courses.php')).toBe(false);
      expect(isMoodlePostLoginUrl('http://psico.elearning.unipd.it/my/courses.php')).toBe(false);
    });

    it('returns structured error for unknown message types in handleMessage default branch', async () => {
      const response = await handleMessage({ type: 'UNKNOWN_OP' } as never);
      expect(response.ok).toBe(false);
      if (!response.ok) {
        expect(response.error).toContain('UNKNOWN_OP');
      }
    });
  });

  describe('Phase 2A static materials (resolveMoodleResourceDownload, resolveMoodleFolderFiles & descriptors)', () => {
    function makeMaterial(overrides: Partial<CourseMaterialActivity> = {}): CourseMaterialActivity {
      return {
        cmid: 500100,
        courseId: 7075,
        sectionIndex: 2,
        sectionTitle: 'Week 2',
        activityIndex: 1,
        title: 'Week 3 Slides',
        type: 'resource',
        url: 'https://psico.elearning.unipd.it/mod/resource/view.php?id=500100',
        fileTypeHint: 'slides',
        detailsText: '2.4 MB PowerPoint',
        ...overrides,
      };
    }

    it('immediately aborts non-HTML binary redirects (PDF/PPTX/ZIP) without calling .text() and reads Content-Disposition', async () => {
      let capturedSignal: AbortSignal | undefined;
      const textSpy = vi.fn(async () => 'SHOULD_NEVER_BE_READ');

      const binaryFetch = vi.fn<typeof fetch>(async (_input, init) => {
        capturedSignal = init?.signal ?? undefined;
        return {
          ok: true,
          status: 200,
          url: 'https://psico.elearning.unipd.it/pluginfile.php/888/mod_resource/content/0/download',
          headers: new Headers({
            'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            'Content-Length': '2457600',
            'Content-Disposition': `attachment; filename*=UTF-8''Week%203%20Slides.pptx`,
          }),
          text: textSpy,
        } as unknown as Response;
      });

      const resolved = await resolveMoodleResourceDownload(makeMaterial(), binaryFetch);
      expect(capturedSignal?.aborted).toBe(true);
      expect(textSpy).not.toHaveBeenCalled();
      expect(resolved.ext).toBe('pptx');
      expect(resolved.fileName).toBe('Week 3 Slides.pptx');
      expect(resolved.sizeBytes).toBe(2457600);
    });

    it('extracts HTML wrapper .resourceworkaround target and probes HEAD Content-Length', async () => {
      const wrapperFetch = vi.fn<typeof fetch>(async (input, init) => {
        if (init?.method === 'HEAD') {
          return new Response(null, {
            status: 200,
            headers: { 'Content-Length': '987654' },
          });
        }
        const res = new Response(REDACTED_RESOURCE_WRAPPER_HTML, {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
        Object.defineProperty(res, 'url', { value: String(input) });
        return res;
      });

      const resolved = await resolveMoodleResourceDownload(makeMaterial(), wrapperFetch);
      expect(resolved.url).toBe(
        'https://psico.elearning.unipd.it/pluginfile.php/45678/mod_resource/content/1/Week%203%20Slides.pptx',
      );
      expect(resolved.ext).toBe('pptx');
      expect(resolved.sizeBytes).toBe(987654);

      // Finalizes descriptor filename when initial mod_resource title omitted extension
      const target = await resolveDownloadUrlFromDescriptor(
        {
          kind: 'material',
          material: makeMaterial(),
          filename: 'UniPD/2026-2027/PSQ4107809 - Testing/02 - Week 2/Materials/01 - Week 3 Slides.bin',
          pathContext: {
            academicYear: '2026-2027',
            courseCode: 'PSQ4107809',
            courseTitle: 'Testing',
          },
        },
        wrapperFetch,
      );
      expect(target).toEqual({
        url: 'https://psico.elearning.unipd.it/pluginfile.php/45678/mod_resource/content/1/Week%203%20Slides.pptx',
        resolvedFilename:
          'UniPD/2026-2027/PSQ4107809 - Testing/02 - Week 2/Materials/01 - Week 3 Slides.pptx',
        resolvedSizeBytes: 987654,
      });
    });

    it('rejects expired sessions, guest HTML, and cross-origin redirects on resource and folder fetches', async () => {
      const loginRedirectFetch = vi.fn<typeof fetch>(async () => {
        const res = new Response(REDACTED_LOGIN_PAGE_HTML, {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
        Object.defineProperty(res, 'url', {
          value: 'https://psico.elearning.unipd.it/login/index.php',
        });
        return res;
      });
      await expect(resolveMoodleResourceDownload(makeMaterial(), loginRedirectFetch)).rejects.toThrow(
        /session expired/i,
      );

      const guestHtmlFetch = vi.fn<typeof fetch>(async () => {
        const res = new Response(REDACTED_GUEST_MY_COURSES_HTML, {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
        Object.defineProperty(res, 'url', {
          value: 'https://psico.elearning.unipd.it/mod/folder/view.php?id=296773',
        });
        return res;
      });
      await expect(
        resolveMoodleFolderFiles(makeMaterial({ type: 'folder', cmid: 296773 }), guestHtmlFetch),
      ).rejects.toThrow(/session expired/i);

      let crossSignal: AbortSignal | undefined;
      const crossFetch = vi.fn<typeof fetch>(async (_input, init) => {
        crossSignal = init?.signal ?? undefined;
        return {
          ok: true,
          status: 200,
          url: 'https://evil.example/steal.pdf',
          headers: new Headers({ 'Content-Type': 'application/pdf' }),
          text: vi.fn(),
        } as unknown as Response;
      });
      await expect(resolveMoodleResourceDownload(makeMaterial(), crossFetch)).rejects.toThrow(
        /outside the UniPD Moodle origin/i,
      );
      expect(crossSignal?.aborted).toBe(true);
    });

    it('resolves mod_folder files lazily, strips URLs in toPublicFolderFiles, and resolves descriptor by folderFileIndex', async () => {
      const folderFetch = vi.fn<typeof fetch>(async (input) => {
        const res = new Response(REDACTED_FOLDER_PAGE_HTML, {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
        Object.defineProperty(res, 'url', { value: String(input) });
        return res;
      });

      const folderMaterial = makeMaterial({
        cmid: 296773,
        type: 'folder',
        title: 'Slide Deck Archive',
        url: 'https://psico.elearning.unipd.it/mod/folder/view.php?id=296773',
      });

      const files = await resolveMoodleFolderFiles(folderMaterial, folderFetch);
      expect(files).toHaveLength(2);
      const publicFiles = toPublicFolderFiles(files);
      expect(JSON.stringify(publicFiles)).not.toContain('pluginfile.php');
      expect(publicFiles).toEqual([
        { fileIndex: 1, name: 'week_01 data.sav', subPath: ['Datasets'], ext: 'sav' },
        { fileIndex: 2, name: 'README (1).pdf', subPath: [], ext: 'pdf' },
      ]);

      const resolvedTarget = await resolveDownloadUrlFromDescriptor(
        {
          kind: 'material',
          material: folderMaterial,
          filename: 'UniPD/2026-2027/PSQ4107809 - Testing/02 - Week 2/Materials/Slide Deck Archive/Datasets/week_01 data.sav',
          folderFileIndex: 1,
          expectedFileName: 'week_01 data.sav',
          pathContext: {
            academicYear: '2026-2027',
            courseCode: 'PSQ4107809',
            courseTitle: 'Testing',
          },
        },
        folderFetch,
      );
      expect(resolvedTarget).toEqual({
        url: 'https://psico.elearning.unipd.it/pluginfile.php/77777/mod_folder/content/0/Datasets/week_01%20data.sav?forcedownload=1',
        resolvedFilename:
          'UniPD/2026-2027/PSQ4107809 - Testing/02 - Week 2/Materials/Slide Deck Archive/Datasets/week_01 data.sav',
      });
    });

    it('handles SCAN_COURSE_LECTURES (returning sections + materialSections) and RESOLVE_FOLDER_FILES via handleMessage', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn<typeof fetch>(async (input) => {
        const url = String(input);
        if (url.includes('/course/view.php')) {
          const res = new Response(REDACTED_COURSE_PAGE_WITH_DRAWER_HTML, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          });
          Object.defineProperty(res, 'url', { value: url });
          return res;
        }
        const res = new Response(REDACTED_FOLDER_PAGE_HTML, {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
        Object.defineProperty(res, 'url', { value: url });
        return res;
      });

      try {
        const scanRes = await handleMessage({ type: 'SCAN_COURSE_LECTURES', courseId: 7075 });
        expect(scanRes.ok).toBe(true);
        if (scanRes.ok && 'materialSections' in scanRes) {
          expect(scanRes.sections).toHaveLength(1);
          expect(scanRes.materialSections).toHaveLength(2);
        }

        const folderRes = await handleMessage({
          type: 'RESOLVE_FOLDER_FILES',
          material: makeMaterial({
            cmid: 296773,
            type: 'folder',
            url: 'https://psico.elearning.unipd.it/mod/folder/view.php?id=296773',
          }),
        });
        expect(folderRes.ok).toBe(true);
        if (folderRes.ok && 'files' in folderRes) {
          expect(folderRes.files).toHaveLength(2);
          expect(JSON.stringify(folderRes.files)).not.toContain('https://');
        }
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('handles direct /pluginfile.php/*.html RMarkdown downloads, Content-Type-only fallback, and HTTP/filename edge cases [ARCH-006-04 / QA-6]', async () => {
      // 1. Direct knitted RMarkdown .html at /pluginfile.php/ (Content-Type: text/html)
      const rmdHtmlFetch = vi.fn<typeof fetch>(async () => {
        const res = new Response('<html><head><title>Lab 3 RMarkdown</title></head><body><h1>Analysis</h1></body></html>', {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Length': '54321',
          },
        });
        Object.defineProperty(res, 'url', {
          value: 'https://psico.elearning.unipd.it/pluginfile.php/900/mod_resource/content/0/analysis_report.html',
        });
        return res;
      });
      const rmdResolved = await resolveMoodleResourceDownload(
        makeMaterial({ title: 'Lab 3 Report', fileTypeHint: null }),
        rmdHtmlFetch,
      );
      expect(rmdResolved).toEqual({
        url: 'https://psico.elearning.unipd.it/pluginfile.php/900/mod_resource/content/0/analysis_report.html',
        fileName: 'analysis_report.html',
        ext: 'html',
        sizeBytes: 54321,
      });

      // 2. Content-Disposition: attachment HTML response without /pluginfile.php/ in URL
      const attachmentHtmlFetch = vi.fn<typeof fetch>(async () => {
        const res = new Response('<html><body>Report</body></html>', {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Disposition': 'attachment; filename="notebook.html"',
          },
        });
        Object.defineProperty(res, 'url', {
          value: 'https://psico.elearning.unipd.it/mod/resource/view.php?id=500100&redirect=1',
        });
        return res;
      });
      const attachmentResolved = await resolveMoodleResourceDownload(
        makeMaterial({ fileTypeHint: null }),
        attachmentHtmlFetch,
      );
      expect(attachmentResolved.ext).toBe('html');
      expect(attachmentResolved.fileName).toBe('notebook.html');

      // 3. Content-Type-only extension fallback (application/pdf, generic URL, no Content-Disposition, no hint)
      const contentTypeOnlyFetch = vi.fn<typeof fetch>(async () => ({
        ok: true,
        status: 200,
        url: 'https://psico.elearning.unipd.it/pluginfile.php/888/mod_resource/content/0/download',
        headers: new Headers({ 'Content-Type': 'application/pdf' }),
        text: vi.fn(),
      }) as unknown as Response);
      const ctResolved = await resolveMoodleResourceDownload(
        makeMaterial({ fileTypeHint: null }),
        contentTypeOnlyFetch,
      );
      expect(ctResolved.ext).toBe('pdf');

      // 4. Question mark in decoded filename preserved when resolving extension
      const questionFilenameFetch = vi.fn<typeof fetch>(async () => ({
        ok: true,
        status: 200,
        url: 'https://psico.elearning.unipd.it/pluginfile.php/888/mod_resource/content/0/Are%20Emotions%20Natural%20Kinds%3F.pdf',
        headers: new Headers({ 'Content-Type': 'application/octet-stream' }),
        text: vi.fn(),
      }) as unknown as Response);
      const qResolved = await resolveMoodleResourceDownload(
        makeMaterial({ fileTypeHint: null }),
        questionFilenameFetch,
      );
      expect(qResolved.fileName).toBe('Are Emotions Natural Kinds?.pdf');
      expect(qResolved.ext).toBe('pdf');

      // 5. Guest HTML 200 & HTTP 403 / 500 on resolveMoodleResourceDownload
      const guestResourceFetch = vi.fn<typeof fetch>(async () => {
        const res = new Response(REDACTED_GUEST_MY_COURSES_HTML, {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
        Object.defineProperty(res, 'url', {
          value: 'https://psico.elearning.unipd.it/mod/resource/view.php?id=500100',
        });
        return res;
      });
      await expect(resolveMoodleResourceDownload(makeMaterial(), guestResourceFetch)).rejects.toThrow(
        /session expired/i,
      );

      for (const status of [403, 500]) {
        let abortSignal: AbortSignal | undefined;
        const errFetch = vi.fn<typeof fetch>(async (_input, init) => {
          abortSignal = init?.signal ?? undefined;
          return new Response('Forbidden', { status });
        });
        await expect(resolveMoodleResourceDownload(makeMaterial(), errFetch)).rejects.toThrow(
          new RegExp(`HTTP ${status}`),
        );
        expect(abortSignal?.aborted).toBe(true);
      }
    });

    it('rejects cross-origin redirect, non-HTML response, and 403/500 on resolveMoodleFolderFiles, and matches expectedFileName on reorder [ARCH-006-03 / QA-6]', async () => {
      const folderMat = makeMaterial({
        cmid: 296773,
        type: 'folder',
        title: 'Slide Deck Archive',
        url: 'https://psico.elearning.unipd.it/mod/folder/view.php?id=296773',
      });

      // 1. Cross-origin redirect
      let crossSignal: AbortSignal | undefined;
      const crossFolderFetch = vi.fn<typeof fetch>(async (_input, init) => {
        crossSignal = init?.signal ?? undefined;
        const res = new Response('<html></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
        Object.defineProperty(res, 'url', { value: 'https://evil.example/folder' });
        return res;
      });
      await expect(resolveMoodleFolderFiles(folderMat, crossFolderFetch)).rejects.toThrow(
        /outside the UniPD Moodle origin/i,
      );
      expect(crossSignal?.aborted).toBe(true);

      // 2. Non-HTML response
      let nonHtmlSignal: AbortSignal | undefined;
      const textSpy = vi.fn(async () => 'SHOULD_NOT_READ');
      const nonHtmlFolderFetch = vi.fn<typeof fetch>(async (_input, init) => {
        nonHtmlSignal = init?.signal ?? undefined;
        return {
          ok: true,
          status: 200,
          url: folderMat.url,
          headers: new Headers({ 'Content-Type': 'application/pdf' }),
          text: textSpy,
        } as unknown as Response;
      });
      await expect(resolveMoodleFolderFiles(folderMat, nonHtmlFolderFetch)).rejects.toThrow(
        /unexpected non-html response/i,
      );
      expect(nonHtmlSignal?.aborted).toBe(true);
      expect(textSpy).not.toHaveBeenCalled();

      // 3. HTTP 403 and 500
      for (const status of [403, 500]) {
        let abortSignal: AbortSignal | undefined;
        const errFetch = vi.fn<typeof fetch>(async (_input, init) => {
          abortSignal = init?.signal ?? undefined;
          return new Response('Error', { status });
        });
        await expect(resolveMoodleFolderFiles(folderMat, errFetch)).rejects.toThrow(
          new RegExp(`HTTP ${status}`),
        );
        expect(abortSignal?.aborted).toBe(true);
      }

      // 4. Folder file reorder: expectedFileName moved from fileIndex 1 -> fileIndex 2
      const reorderedHtml = `
        <section id="region-main">
          <div class="foldertree">
            <ul>
              <li><a href="/pluginfile.php/77777/mod_folder/content/0/00_new_intro.pdf">00_new_intro.pdf</a></li>
              <li><a href="/pluginfile.php/77777/mod_folder/content/0/Datasets/week_01%20data.sav">week_01 data.sav</a></li>
            </ul>
          </div>
        </section>`;
      const reorderedFetch = vi.fn<typeof fetch>(async (input) => {
        const res = new Response(reorderedHtml, {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
        Object.defineProperty(res, 'url', { value: String(input) });
        return res;
      });

      const reorderedTarget = await resolveDownloadUrlFromDescriptor(
        {
          kind: 'material',
          material: folderMat,
          filename: 'UniPD/2026-2027/PSQ4107809 - Testing/02 - Week 2/Materials/Slide Deck Archive/Datasets/week_01 data.sav',
          folderFileIndex: 1,
          expectedFileName: 'week_01 data.sav',
          pathContext: {
            academicYear: '2026-2027',
            courseCode: 'PSQ4107809',
            courseTitle: 'Testing',
          },
        },
        reorderedFetch,
      );
      expect(reorderedTarget).toEqual({
        url: 'https://psico.elearning.unipd.it/pluginfile.php/77777/mod_folder/content/0/Datasets/week_01%20data.sav',
        resolvedFilename:
          'UniPD/2026-2027/PSQ4107809 - Testing/02 - Week 2/Materials/Slide Deck Archive/Datasets/week_01 data.sav',
      });

      // 5. Deleted expectedFileName does not silently download another file occupying fileIndex 1
      await expect(
        resolveDownloadUrlFromDescriptor(
          {
            kind: 'material',
            material: folderMat,
            filename: 'UniPD/2026-2027/PSQ4107809 - Testing/02 - Week 2/Materials/Slide Deck Archive/deleted.pdf',
            folderFileIndex: 1,
            expectedFileName: 'deleted.pdf',
          },
          reorderedFetch,
        ),
      ).rejects.toThrow(/no longer available/i);
    });
  });

  describe('Phase 2B download history, hlsOnly projection & RETRY_DOWNLOAD routing [TASK-007]', () => {
    it('projects hlsOnly cleanly via toPublicLectureMedia without leaking URLs or ks', () => {
      const projected = toPublicLectureMedia({
        cmid: 300999,
        entryId: '1_hls99',
        lectureTitle: 'HLS Lecture',
        durationSec: 420,
        flavors: [],
        captions: [],
        directMp4Url: null,
        hlsOnly: true,
      });

      expect(projected).toEqual({
        cmid: 300999,
        entryId: '1_hls99',
        lectureTitle: 'HLS Lecture',
        durationSec: 420,
        flavors: [],
        captions: [],
        hasDirectMp4: false,
        hlsOnly: true,
      });
    });

    it('serializes concurrent completed download history writes into secret-free chrome.storage.local and handles GET_DOWNLOAD_HISTORY', async () => {
      const localStore: Record<string, unknown> = {};
      const originalChrome = (globalThis as { chrome?: unknown }).chrome;
      (globalThis as { chrome: unknown }).chrome = {
        storage: {
          local: {
            get: vi.fn(async (key: string) => ({ [key]: localStore[key] })),
            set: vi.fn(async (items: Record<string, unknown>) => {
              Object.assign(localStore, items);
            }),
          },
          session: {
            get: vi.fn(async () => ({})),
            set: vi.fn(async () => {}),
          },
        },
        downloads: {
          download: vi.fn(),
          cancel: vi.fn(),
          search: vi.fn(async () => []),
        },
        runtime: {
          id: 'test-ext',
          sendMessage: vi.fn(async () => undefined),
        },
      };

      try {
        const videoKey = buildHistoryKeyFromDescriptor({
          kind: 'video',
          activity: makeActivity({ cmid: 310001, courseId: 7075 }),
          filename: 'UniPD/a.mp4',
          preferredHeight: 720,
        });
        const folderKey = buildHistoryKeyFromDescriptor({
          kind: 'material',
          material: {
            cmid: 310002,
            courseId: 7075,
            sectionIndex: 1,
            sectionTitle: 'Sec',
            activityIndex: 1,
            title: 'Folder',
            type: 'folder',
            url: 'https://psico.elearning.unipd.it/mod/folder/view.php?id=310002',
            fileTypeHint: 'folder',
            detailsText: null,
          },
          filename: 'UniPD/Are Emotions Natural Kinds.pdf',
          folderFileIndex: 1,
          expectedFileName: 'Are Emotions Natural Kinds?.pdf',
        });

        expect(videoKey).toBe('7075:310001:video:720p');
        expect(folderKey).toBe('7075:310002:material:file_are_emotions_natural_kinds_.pdf');

        await Promise.all([
          recordCompletedDownloadHistory(
            {
              kind: 'video',
              activity: makeActivity({ cmid: 310001, courseId: 7075 }),
              filename: 'UniPD/a.mp4',
              preferredHeight: 720,
            },
            100,
          ),
          recordCompletedDownloadHistory(
            {
              kind: 'material',
              material: {
                cmid: 310002,
                courseId: 7075,
                sectionIndex: 1,
                sectionTitle: 'Sec',
                activityIndex: 1,
                title: 'Folder',
                type: 'folder',
                url: 'https://psico.elearning.unipd.it/mod/folder/view.php?id=310002',
                fileTypeHint: 'folder',
                detailsText: null,
              },
              filename: 'UniPD/Are Emotions Natural Kinds.pdf',
              folderFileIndex: 1,
              expectedFileName: 'Are Emotions Natural Kinds?.pdf',
            },
            200,
          ),
        ]);

        const entries = await readDownloadHistory();
        expect(entries).toHaveLength(2);
        expect(entries.map((e) => e.key)).toEqual([videoKey, folderKey]);
        expect(JSON.stringify(localStore)).not.toMatch(/https?:|ks=|sesskey=/i);

        const ipcHistory = await handleMessage({ type: 'GET_DOWNLOAD_HISTORY' });
        expect(ipcHistory).toEqual({
          ok: true,
          entries,
        });

        const retryMissing = await handleMessage({ type: 'RETRY_DOWNLOAD', taskId: 'missing-task' });
        expect(retryMissing).toMatchObject({
          ok: true,
          state: { items: [] },
        });
      } finally {
        (globalThis as { chrome?: unknown }).chrome = originalChrome;
      }
    });
  });
});
