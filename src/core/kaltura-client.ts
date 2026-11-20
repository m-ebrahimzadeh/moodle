import {
  KALTURA_API_BASE_URL,
  type CaptionTrack,
  type KalturaBridgeConfig,
  type ResolvedLectureMedia,
  type VideoFlavor,
} from './types.js';

interface KalturaApiExceptionLike {
  objectType?: string;
  code?: string;
  message?: string;
}

interface KalturaBaseEntryLike {
  id?: string;
  name?: string;
  duration?: number;
}

interface KalturaFlavorAssetLike {
  id?: string;
  width?: number;
  height?: number;
  bitrate?: number;
  size?: number;
  sizeBytes?: number;
  fileExt?: string;
  containerFormat?: string;
  isOriginal?: boolean;
  status?: number;
  tags?: string;
}

interface KalturaPlaybackCaptionLike {
  label?: string;
  language?: string;
  languageCode?: string;
  webVttUrl?: string;
  url?: string;
}

interface KalturaPlaybackSourceLike {
  format?: string;
  url?: string;
}

interface KalturaMultirequestEntryList {
  objects?: KalturaBaseEntryLike[];
}

interface KalturaPlaybackContextLike {
  flavorAssets?: KalturaFlavorAssetLike[];
  playbackCaptions?: KalturaPlaybackCaptionLike[];
  sources?: KalturaPlaybackSourceLike[];
}

function isKalturaApiException(value: unknown): value is KalturaApiExceptionLike {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const obj = value as KalturaApiExceptionLike;
  return obj.objectType === 'KalturaAPIException' || (typeof obj.code === 'string' && typeof obj.message === 'string');
}

function extractNumericVar(html: string, patterns: RegExp[]): number | null {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      const parsed = Number.parseInt(match[1], 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }
  return null;
}

function extractStringVar(html: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1] && match[1].trim()) {
      return match[1].trim();
    }
  }
  return null;
}

/**
 * Parses `partnerId`, `uiconfId`, `entryId`, `ks`, and `isPlaylist` from the
 * same-origin Moodle Kaltura bridge HTML (`/mod/kalvidres/player_bridge.php?cmid=<cmid>`).
 */
export function parseKalturaPlayerBridge(html: string): KalturaBridgeConfig {
  const partnerId = extractNumericVar(html, [
    /["']?partnerId["']?\s*[:=]\s*["']?(\d+)["']?/i,
    /["']?partner_id["']?\s*[:=]\s*["']?(\d+)["']?/i,
    /\/p\/(\d+)\/embedPlaykitJs/i,
    /\/p\/(\d+)\/sp\/\d+/i,
  ]);

  const uiconfId = extractNumericVar(html, [
    /["']?uiconfId["']?\s*[:=]\s*["']?(\d+)["']?/i,
    /["']?uiconf_id["']?\s*[:=]\s*["']?(\d+)["']?/i,
    /uiconf_id\/(\d+)/i,
  ]);

  const entryId = extractStringVar(html, [
    /["']?entryId["']?\s*[:=]\s*["']([0-9]+_[a-zA-Z0-9]+)["']/,
    /["']?entry_id["']?\s*[:=]\s*["']([0-9]+_[a-zA-Z0-9]+)["']/,
    /\/entryId\/([0-9]+_[a-zA-Z0-9]+)/,
  ]);

  const ks = extractStringVar(html, [
    /(?:var|let|const)\s+ks\s*=\s*["']([^"'\s]{16,})["']/,
    /\b(?:flashvars|window|config|playerConfig)\.ks\s*=\s*["']([^"'\s]{16,})["']/,
    /\b[A-Za-z_$][\w$]*\.ks\s*=\s*["']([^"'\s]{16,})["']/,
    /["']ks["']\s*:\s*["']([^"'\s]{16,})["']/,
    /\bks\s*:\s*["']([^"'\s]{16,})["']/,
    /[?&]ks=([A-Za-z0-9%+/=_-]{16,})/,
  ]);

  const isPlaylistMatch = html.match(/["']?isPlaylist["']?\s*[:=]\s*(true|false|1|0)/i);
  const isPlaylist = isPlaylistMatch?.[1]
    ? isPlaylistMatch[1].toLowerCase() === 'true' || isPlaylistMatch[1] === '1'
    : /["']?playlistId["']?\s*[:=]\s*["'][^"']+["']/i.test(html);

  if (partnerId === null) {
    throw new Error('Could not parse Kaltura partnerId from player_bridge.php HTML.');
  }
  if (!entryId) {
    throw new Error('Could not parse Kaltura entryId from player_bridge.php HTML.');
  }
  if (!ks) {
    throw new Error('Could not parse Kaltura session token from player_bridge.php HTML.');
  }

  let decodedKs = ks;
  try {
    decodedKs = decodeURIComponent(ks);
  } catch {
    decodedKs = ks;
  }

  return {
    partnerId,
    uiconfId: uiconfId ?? 0,
    entryId,
    ks: decodedKs,
    isPlaylist,
  };
}

/**
 * Constructs Kaltura's direct progressive MP4 `playManifest` URL (`format/url`),
 * which redirects (`302`) to a CloudFront VOD progressive MP4 (`206 video/mp4`).
 */
export function buildKalturaProgressiveDownloadUrl(
  partnerId: number,
  entryId: string,
  flavorId: string,
  ks: string,
): string {
  return (
    `${KALTURA_API_BASE_URL}/p/${partnerId}/sp/${partnerId}00` +
    `/playManifest/entryId/${encodeURIComponent(entryId)}` +
    `/flavorId/${encodeURIComponent(flavorId)}` +
    `/format/url/protocol/https/a.mp4?ks=${encodeURIComponent(ks)}`
  );
}

function isUsableMp4Flavor(asset: KalturaFlavorAssetLike): boolean {
  if (!asset.id) {
    return false;
  }
  // Kaltura FlavorAssetStatus.READY === 2
  if (typeof asset.status === 'number' && asset.status !== 2) {
    return false;
  }

  const ext = (asset.fileExt ?? '').toLowerCase();
  const container = (asset.containerFormat ?? '').toLowerCase();
  const width = Number(asset.width ?? 0);
  const height = Number(asset.height ?? 0);

  if (ext === 'mp4' || container === 'isom' || container === 'mp4') {
    return width > 0 || height > 0 || Number(asset.bitrate ?? 0) > 0;
  }

  return false;
}

function resolveFlavorSizeBytes(asset: KalturaFlavorAssetLike): number {
  if (typeof asset.sizeBytes === 'number' && Number.isFinite(asset.sizeBytes) && asset.sizeBytes >= 0) {
    return Math.round(asset.sizeBytes);
  }
  // Kaltura API v3 KalturaFlavorAsset.size is expressed in kilobytes (KB).
  if (typeof asset.size === 'number' && Number.isFinite(asset.size) && asset.size > 0) {
    return Math.round(asset.size * 1024);
  }
  return 0;
}

function normalizeHttpsUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return null;
  }
  const candidate = trimmed.startsWith('//') ? `https:${trimmed}` : trimmed;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Parses a Kaltura `multirequest` (`baseEntry.list` + `baseEntry.getPlaybackContext`)
 * response into sorted progressive MP4 flavors and WebVTT captions.
 */
export function parseKalturaMultirequestResponse(
  json: unknown,
  partnerId: number,
  entryId: string,
  ks: string,
): Omit<ResolvedLectureMedia, 'cmid'> {
  if (isKalturaApiException(json)) {
    throw new Error(`Kaltura multirequest failed (${json.code ?? 'API_ERROR'}).`);
  }

  if (!Array.isArray(json) || json.length < 2) {
    throw new Error('Unexpected Kaltura multirequest response structure.');
  }

  const [entryListResult, playbackContextResult] = json as [unknown, unknown];
  if (isKalturaApiException(entryListResult)) {
    throw new Error(`Kaltura baseEntry.list failed (${entryListResult.code ?? 'API_ERROR'}).`);
  }
  if (isKalturaApiException(playbackContextResult)) {
    throw new Error(
      `Kaltura getPlaybackContext failed (${playbackContextResult.code ?? 'API_ERROR'}).`,
    );
  }

  const entryList = (entryListResult ?? {}) as KalturaMultirequestEntryList;
  const playbackContext = (playbackContextResult ?? {}) as KalturaPlaybackContextLike;

  const entry = entryList.objects?.[0];
  const lectureTitle = entry?.name?.trim() || entryId;
  const durationSec =
    typeof entry?.duration === 'number' && Number.isFinite(entry.duration) && entry.duration >= 0
      ? entry.duration
      : null;

  const rawFlavors = Array.isArray(playbackContext.flavorAssets)
    ? playbackContext.flavorAssets
    : [];

  const flavors: VideoFlavor[] = rawFlavors
    .filter(isUsableMp4Flavor)
    .map((asset) => {
      const id = String(asset.id);
      return {
        id,
        width: Number(asset.width ?? 0),
        height: Number(asset.height ?? 0),
        bitrateKbps: Number(asset.bitrate ?? 0),
        sizeBytes: resolveFlavorSizeBytes(asset),
        fileExt: (asset.fileExt ?? 'mp4').toLowerCase(),
        isOriginal: Boolean(asset.isOriginal),
        downloadUrl: buildKalturaProgressiveDownloadUrl(partnerId, entryId, id, ks),
      };
    })
    .sort((a, b) => {
      const pixelsA = a.height * a.width;
      const pixelsB = b.height * b.width;
      if (pixelsB !== pixelsA) {
        return pixelsB - pixelsA;
      }
      if (b.height !== a.height) {
        return b.height - a.height;
      }
      if (b.bitrateKbps !== a.bitrateKbps) {
        return b.bitrateKbps - a.bitrateKbps;
      }
      if (a.isOriginal !== b.isOriginal) {
        return a.isOriginal ? -1 : 1;
      }
      return b.sizeBytes - a.sizeBytes;
    });

  const rawCaptions = Array.isArray(playbackContext.playbackCaptions)
    ? playbackContext.playbackCaptions
    : [];

  const seenCaptionUrls = new Set<string>();
  const captions: CaptionTrack[] = [];
  for (const caption of rawCaptions) {
    const rawVttUrl = caption.webVttUrl ?? caption.url ?? '';
    const vttUrl = normalizeHttpsUrl(rawVttUrl);
    if (!vttUrl || seenCaptionUrls.has(vttUrl)) {
      continue;
    }
    seenCaptionUrls.add(vttUrl);
    captions.push({
      label: (caption.label ?? caption.language ?? caption.languageCode ?? 'Subtitles').trim(),
      languageCode: (caption.languageCode ?? caption.language ?? 'und').trim(),
      vttUrl,
    });
  }

  let directMp4Url: string | null = flavors[0]?.downloadUrl ?? null;
  let hasAppleHttpSource = false;
  if (Array.isArray(playbackContext.sources)) {
    for (const source of playbackContext.sources) {
      const fmt = typeof source.format === 'string' ? source.format.trim().toLowerCase() : '';
      const rawSourceUrl = typeof source.url === 'string' ? source.url : '';
      const normalizedSourceUrl = rawSourceUrl.length > 0 ? normalizeHttpsUrl(rawSourceUrl) : null;

      if (!directMp4Url && fmt === 'url' && normalizedSourceUrl) {
        directMp4Url = normalizedSourceUrl;
      }

      if (
        normalizedSourceUrl &&
        (fmt === 'applehttp' || fmt === 'hls' || /\.m3u8(?:[?#]|$)/i.test(normalizedSourceUrl))
      ) {
        hasAppleHttpSource = true;
      }
    }
  }

  const hlsOnly = flavors.length === 0 && !directMp4Url && hasAppleHttpSource;

  return {
    entryId,
    lectureTitle,
    durationSec,
    flavors,
    captions,
    directMp4Url,
    hlsOnly,
  };
}

/**
 * End-to-end headless Kaltura resolution from `player_bridge.php` HTML via
 * `POST https://cdnapisec.kaltura.com/api_v3/service/multirequest`.
 */
export async function resolveKalturaLectureMedia(
  bridgeHtml: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Omit<ResolvedLectureMedia, 'cmid'>> {
  const config = parseKalturaPlayerBridge(bridgeHtml);

  const multirequestBody = {
    apiVersion: '3.3.0',
    format: 1,
    ks: config.ks,
    1: {
      service: 'baseEntry',
      action: 'list',
      filter: {
        idEqual: config.entryId,
      },
    },
    2: {
      service: 'baseEntry',
      action: 'getPlaybackContext',
      entryId: config.entryId,
      contextDataParams: {
        objectType: 'KalturaContextDataParams',
        flavorTags: 'all',
      },
    },
  };

  const response = await fetchImpl(`${KALTURA_API_BASE_URL}/api_v3/service/multirequest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(multirequestBody),
  });

  if (!response.ok) {
    throw new Error(`Kaltura multirequest failed with HTTP ${response.status}.`);
  }

  const json = (await response.json()) as unknown;
  return parseKalturaMultirequestResponse(json, config.partnerId, config.entryId, config.ks);
}
