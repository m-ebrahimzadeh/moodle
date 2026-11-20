import { describe, expect, it, vi } from 'vitest';
import type { LectureActivity } from '../src/core/types.js';
import {
  handleMessage,
  isMoodlePostLoginUrl,
  resolveActivityMedia,
  resolveDownloadUrlFromDescriptor,
  resolveMoodleHostedMp4,
  toPublicLectureMedia,
} from '../src/extension/service-worker.js';
import {
  REDACTED_GUEST_MY_COURSES_HTML,
  REDACTED_KALTURA_MULTIREQUEST_RESPONSE,
  REDACTED_LOGIN_PAGE_HTML,
  REDACTED_PLAYER_BRIDGE_HTML,
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
});
