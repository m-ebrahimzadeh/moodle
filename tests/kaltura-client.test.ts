import { describe, expect, it, vi } from 'vitest';
import {
  buildKalturaProgressiveDownloadUrl,
  parseKalturaMultirequestResponse,
  parseKalturaPlayerBridge,
  resolveKalturaLectureMedia,
} from '../src/core/kaltura-client.js';
import {
  REDACTED_KALTURA_MULTIREQUEST_RESPONSE,
  REDACTED_PLAYER_BRIDGE_HTML,
} from './fixtures/moodle-fixtures.js';

describe('kaltura-client', () => {
  describe('parseKalturaPlayerBridge', () => {
    it('extracts partnerId, uiconfId, entryId, ks, and isPlaylist from player_bridge.php HTML', () => {
      const config = parseKalturaPlayerBridge(REDACTED_PLAYER_BRIDGE_HTML);
      expect(config).toEqual({
        partnerId: 2203921,
        uiconfId: 43513601,
        entryId: '1_sirqa9b5',
        ks: 'djJ8MjIwMzkyMXxTEST_REDACTED_KS_TOKEN_VALUE_001',
        isPlaylist: false,
      });
    });

    it('throws safe error when ks is missing without leaking HTML content', () => {
      const brokenHtml = '<script>var partnerId = 2203921; var entryId = "1_sirqa9b5";</script>';
      expect(() => parseKalturaPlayerBridge(brokenHtml)).toThrow(
        'Could not parse Kaltura session token from player_bridge.php HTML.',
      );
    });

    it('supports flashvars.ks and window.ks assignments and handles malformed percent sequences in ks [ARCH-007 / QA-008]', () => {
      const flashvarsHtml = `
        <script>
          var partnerId = 2203921;
          var entryId = "1_sirqa9b5";
          flashvars.ks = "djJ8TEST%ZZ_RAW_PERCENT_TOKEN_VALUE";
        </script>`;
      const parsedFlashvars = parseKalturaPlayerBridge(flashvarsHtml);
      expect(parsedFlashvars.ks).toBe('djJ8TEST%ZZ_RAW_PERCENT_TOKEN_VALUE');

      const windowKsHtml = `
        <script>
          var partnerId = 2203921;
          var entryId = "1_sirqa9b5";
          window.ks = "djJ8WINDOW_KS_TOKEN_1234567890";
        </script>`;
      const parsedWindow = parseKalturaPlayerBridge(windowKsHtml);
      expect(parsedWindow.ks).toBe('djJ8WINDOW_KS_TOKEN_1234567890');
    });
  });

  describe('buildKalturaProgressiveDownloadUrl', () => {
    it('builds canonical format/url progressive MP4 playManifest URL', () => {
      const url = buildKalturaProgressiveDownloadUrl(
        2203921,
        '1_sirqa9b5',
        '1_c1qlwlrw',
        'abc+123/==',
      );

      expect(url).toBe(
        'https://cdnapisec.kaltura.com/p/2203921/sp/220392100/playManifest/entryId/1_sirqa9b5/flavorId/1_c1qlwlrw/format/url/protocol/https/a.mp4?ks=abc%2B123%2F%3D%3D',
      );
    });
  });

  describe('parseKalturaMultirequestResponse', () => {
    it('sorts MP4 flavors highest resolution first, filters non-ready/audio assets, and deduplicates .vtt captions', () => {
      const media = parseKalturaMultirequestResponse(
        REDACTED_KALTURA_MULTIREQUEST_RESPONSE,
        2203921,
        '1_sirqa9b5',
        'TEST_KS_TOKEN',
      );

      expect(media.entryId).toBe('1_sirqa9b5');
      expect(media.lectureTitle).toBe('Unit 1 Lecture: What is Measurement');
      expect(media.durationSec).toBe(2363);
      expect(media.createdAtSec).toBeNull();

      expect(media.flavors).toHaveLength(2);
      expect(media.flavors[0]?.id).toBe('1_c1qlwlrw');
      expect(media.flavors[0]?.height).toBe(1080);
      expect(media.flavors[0]?.sizeBytes).toBe(163296 * 1024);
      expect(media.flavors[0]?.isOriginal).toBe(true);
      expect(media.flavors[1]?.id).toBe('1_yz2ebdzm');
      expect(media.flavors[1]?.height).toBe(360);

      expect(media.directMp4Url).toBe(media.flavors[0]?.downloadUrl);

      expect(media.captions).toHaveLength(2);
      expect(media.captions.map((c) => c.languageCode)).toEqual(['en', 'it']);
    });

    it('throws on KalturaAPIException in multirequest response', () => {
      const errorJson = [
        { objectType: 'KalturaAPIException', code: 'INVALID_KS', message: 'Invalid KS' },
        {},
      ];
      expect(() =>
        parseKalturaMultirequestResponse(errorJson, 2203921, '1_sirqa9b5', 'BAD_KS'),
      ).toThrow('INVALID_KS');
    });

    it('throws KalturaAPIException code for top-level non-array Kaltura exception [ARCH-007 / QA-008]', () => {
      const topLevelError = {
        objectType: 'KalturaAPIException',
        code: 'INVALID_KS',
        message: 'Invalid KS',
      };
      expect(() =>
        parseKalturaMultirequestResponse(topLevelError, 2203921, '1_sirqa9b5', 'BAD_KS'),
      ).toThrow('INVALID_KS');
    });

    it('normalizes protocol-relative caption URLs to https and rejects non-https schemes [ARCH-007 / QA-008]', () => {
      const payload = [
        { objects: [{ id: '1_sirqa9b5', name: 'Lecture', duration: 600 }] },
        {
          flavorAssets: [],
          playbackCaptions: [
            {
              label: 'Protocol Relative',
              languageCode: 'en',
              webVttUrl: '//cdnsecakmi.kaltura.com/api_v3/captions/en.vtt',
            },
            {
              label: 'Insecure HTTP',
              languageCode: 'it',
              webVttUrl: 'http://cdnsecakmi.kaltura.com/api_v3/captions/it.vtt',
            },
            {
              label: 'Javascript Scheme',
              languageCode: 'xx',
              webVttUrl: 'javascript:alert(1)',
            },
          ],
        },
      ];

      const media = parseKalturaMultirequestResponse(payload, 2203921, '1_sirqa9b5', 'TEST_KS');
      expect(media.hlsOnly).toBe(false);
      expect(media.captions).toEqual([
        {
          label: 'Protocol Relative',
          languageCode: 'en',
          vttUrl: 'https://cdnsecakmi.kaltura.com/api_v3/captions/en.vtt',
        },
      ]);
    });

    it('sets hlsOnly: true when no progressive MP4 flavors/url exist and an HLS/applehttp source is present [TASK-007]', () => {
      const hlsPayload = [
        { objects: [{ id: '1_hlsonly', name: 'Live Replay HLS', duration: 900 }] },
        {
          flavorAssets: [],
          playbackCaptions: [],
          sources: [
            {
              format: 'applehttp',
              url: 'https://cdnapisec.kaltura.com/p/2203921/sp/220392100/playManifest/entryId/1_hlsonly/format/applehttp/protocol/https/a.m3u8?ks=SECRET_HLS_KS',
            },
          ],
        },
      ];

      const hlsMedia = parseKalturaMultirequestResponse(hlsPayload, 2203921, '1_hlsonly', 'TEST_KS');
      expect(hlsMedia.flavors).toEqual([]);
      expect(hlsMedia.directMp4Url).toBeNull();
      expect(hlsMedia.hlsOnly).toBe(true);

      const m3u8ExtensionPayload = [
        { objects: [{ id: '1_m3u8', name: 'M3U8 Only', duration: 300 }] },
        {
          flavorAssets: [],
          playbackCaptions: [],
          sources: [
            {
              format: 'custom',
              url: '//cdnapisec.kaltura.com/stream/index.m3u8?ks=SECRET_M3U8',
            },
          ],
        },
      ];
      expect(parseKalturaMultirequestResponse(m3u8ExtensionPayload, 2203921, '1_m3u8', 'TEST_KS').hlsOnly).toBe(true);

      // If a playable progressive URL/flavor also exists, hlsOnly must remain false
      const mixedPayload = [
        { objects: [{ id: '1_mixed', name: 'Mixed', duration: 500 }] },
        {
          flavorAssets: [],
          playbackCaptions: [],
          sources: [
            {
              format: 'applehttp',
              url: 'https://cdnapisec.kaltura.com/hls/master.m3u8?ks=SECRET',
            },
            {
              format: 'url',
              url: 'https://cdnapisec.kaltura.com/progressive/video.mp4?ks=SECRET',
            },
          ],
        },
      ];
      const mixedMedia = parseKalturaMultirequestResponse(mixedPayload, 2203921, '1_mixed', 'TEST_KS');
      expect(mixedMedia.directMp4Url).toBe('https://cdnapisec.kaltura.com/progressive/video.mp4?ks=SECRET');
      expect(mixedMedia.hlsOnly).toBe(false);
    });

    it('extracts Kaltura baseEntry createdAt Unix timestamp into createdAtSec [TASK-010]', () => {
      const payload = [
        { objects: [{ id: '1_dated', name: 'Dated Lecture', duration: 1200, createdAt: 1759651200 }] },
        { flavorAssets: [], playbackCaptions: [] },
      ];
      const media = parseKalturaMultirequestResponse(payload, 2203921, '1_dated', 'TEST_KS');
      expect(media.createdAtSec).toBe(1759651200);
    });
  });

  describe('resolveKalturaLectureMedia', () => {
    it('posts multirequest with baseEntry.list and getPlaybackContext and returns resolved media', async () => {
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify(REDACTED_KALTURA_MULTIREQUEST_RESPONSE), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const resolved = await resolveKalturaLectureMedia(REDACTED_PLAYER_BRIDGE_HTML, mockFetch);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0]!;
      expect(String(url)).toBe('https://cdnapisec.kaltura.com/api_v3/service/multirequest');
      expect(init?.method).toBe('POST');

      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body['ks']).toBe('djJ8MjIwMzkyMXxTEST_REDACTED_KS_TOKEN_VALUE_001');
      expect(resolved.flavors[0]?.id).toBe('1_c1qlwlrw');
      expect(resolved.captions).toHaveLength(2);
    });
  });
});
