import {
  DEFAULT_MOODLE_BASE_URL,
  DOWNLOAD_HISTORY_STORAGE_KEY,
  MAX_DOWNLOAD_HISTORY_ENTRIES,
  MoodleSessionExpiredError,
  ShibbolethAuthError,
  UNIPD_SHIBBOLETH_LOGIN_PATH,
  buildDownloadHistoryKey,
  buildFolderFileHistoryVariant,
  buildMaterialDownloadPath,
  extractPluginfileMp4Url,
  extractPluginfileResourceUrl,
  fetchCoursePageHtml,
  fetchEnrolledCourses,
  fetchMoodleSession,
  isLoginPageUrl,
  isUnauthenticatedMoodleHtml,
  normalizeDownloadHistoryEntries,
  parseContentDispositionFilename,
  parseCourseContentFromHtml,
  parseFolderFilesFromHtml,
  recordDownloadHistoryLru,
  resolveKalturaLectureMedia,
  type CaptionTrack,
  type CourseMaterialActivity,
  type DownloadHistoryEntry,
  type FolderFileEntry,
  type LectureActivity,
  type MoodleSessionInfo,
  type ResolvedLectureMedia,
  type VideoFlavor,
} from '../core/index.js';
import { AuthManager } from './auth-manager.js';
import {
  ALLOWED_MEDIA_ORIGINS,
  DEFAULT_MAX_CONCURRENT_DOWNLOADS,
  DownloadManager,
  createChromeDownloadsAdapter,
  createSessionQueueStorageAdapter,
  sanitizeErrorMessage,
  validateAllowedMediaUrl,
  type ResolvedDownloadTarget,
} from './download-manager.js';
import type {
  DownloadResolutionDescriptor,
  ExtensionBroadcastEvent,
  ExtensionRequest,
  ExtensionResponse,
  PublicFolderFile,
  PublicResolvedLectureMedia,
  PublicSessionStatus,
} from './messages.js';

const MOODLE_ORIGIN = new URL(DEFAULT_MOODLE_BASE_URL).origin;
const SSO_STATE_STORAGE_KEY = 'unipd_sso_probe_state_v1';

interface SsoProbeState {
  awaitingSsoLogin: boolean;
  lastKnownAuthenticated: boolean;
}

export function toPublicSession(info: MoodleSessionInfo): PublicSessionStatus {
  return {
    authenticated: info.authenticated,
    userId: info.userId,
    loginUrl: info.loginUrl,
  };
}

export function toPublicFolderFiles(files: FolderFileEntry[]): PublicFolderFile[] {
  return files.map((file) => ({
    fileIndex: file.fileIndex,
    name: file.name,
    subPath: [...file.subPath],
    ext: file.ext,
  }));
}

/**
 * Strips signed CDN/Kaltura `downloadUrl`, `vttUrl`, and `directMp4Url` fields
 * so `?ks=...` and signed query parameters never cross the SW <-> UI boundary.
 */
export function toPublicLectureMedia(media: ResolvedLectureMedia): PublicResolvedLectureMedia {
  return {
    cmid: media.cmid,
    entryId: media.entryId,
    lectureTitle: media.lectureTitle,
    durationSec: media.durationSec,
    createdAtSec: media.createdAtSec ?? null,
    flavors: media.flavors.map((flavor) => ({
      id: flavor.id,
      width: flavor.width,
      height: flavor.height,
      bitrateKbps: flavor.bitrateKbps,
      sizeBytes: flavor.sizeBytes,
      fileExt: flavor.fileExt,
      isOriginal: flavor.isOriginal,
    })),
    captions: media.captions.map((caption, index) => ({
      label: caption.label,
      languageCode: caption.languageCode,
      index,
    })),
    hasDirectMp4: Boolean(media.directMp4Url),
    hlsOnly: Boolean(media.hlsOnly),
  };
}

let historyMutationChain: Promise<DownloadHistoryEntry[]> = Promise.resolve([]);

/**
 * Builds a canonical secret-free `courseId:cmid:kind:variant` history key
 * from a completed `DownloadResolutionDescriptor`.
 */
export function buildHistoryKeyFromDescriptor(
  descriptor: DownloadResolutionDescriptor,
): string {
  if (descriptor.kind === 'material') {
    const isFolderFile =
      descriptor.material.type === 'folder' ||
      typeof descriptor.folderFileIndex === 'number' ||
      Boolean(descriptor.expectedFileName);
    const variant = isFolderFile
      ? buildFolderFileHistoryVariant(descriptor.expectedFileName, descriptor.folderFileIndex)
      : 'resource';
    return buildDownloadHistoryKey({
      courseId: descriptor.material.courseId,
      cmid: descriptor.material.cmid,
      kind: 'material',
      variant,
    });
  }

  if (descriptor.kind === 'subtitle') {
    return buildDownloadHistoryKey({
      courseId: descriptor.activity.courseId,
      cmid: descriptor.activity.cmid,
      kind: 'subtitle',
      variant: descriptor.captionLanguageCode || 'und',
    });
  }

  const heightVariant =
    typeof descriptor.preferredHeight === 'number' && descriptor.preferredHeight > 0
      ? `${Math.trunc(descriptor.preferredHeight)}p`
      : 'default';
  return buildDownloadHistoryKey({
    courseId: descriptor.activity.courseId,
    cmid: descriptor.activity.cmid,
    kind: 'video',
    variant: heightVariant,
  });
}

export async function readDownloadHistory(): Promise<DownloadHistoryEntry[]> {
  try {
    if (!chrome.storage?.local) {
      return [];
    }
    const result = await chrome.storage.local.get(DOWNLOAD_HISTORY_STORAGE_KEY);
    return normalizeDownloadHistoryEntries(
      result[DOWNLOAD_HISTORY_STORAGE_KEY],
      MAX_DOWNLOAD_HISTORY_ENTRIES,
    );
  } catch {
    return [];
  }
}

export async function recordCompletedDownloadHistory(
  descriptor: DownloadResolutionDescriptor,
  completedAt: number = Date.now(),
): Promise<DownloadHistoryEntry[]> {
  const key = buildHistoryKeyFromDescriptor(descriptor);
  const next = historyMutationChain.then(async () => {
    const current = await readDownloadHistory();
    const updated = recordDownloadHistoryLru(
      current,
      key,
      completedAt,
      MAX_DOWNLOAD_HISTORY_ENTRIES,
    );
    try {
      if (chrome.storage?.local) {
        await chrome.storage.local.set({ [DOWNLOAD_HISTORY_STORAGE_KEY]: updated });
      }
    } catch {
      // Non-fatal if storage quota/availability rejects local write
    }
    return updated;
  });
  historyMutationChain = next.catch(() => []);
  return next;
}

/**
 * Strictly validates that a tab URL is on the Moodle origin and is not an
 * active login or Shibboleth handoff URL.
 */
export function isMoodlePostLoginUrl(
  rawUrl: string,
  moodleBaseUrl: string = DEFAULT_MOODLE_BASE_URL,
): boolean {
  try {
    const parsed = new URL(rawUrl);
    const expectedOrigin = new URL(moodleBaseUrl).origin;
    if (parsed.origin !== expectedOrigin) {
      return false;
    }
    const lowerPath = parsed.pathname.toLowerCase();
    return !lowerPath.includes('/login/') && !lowerPath.includes('/auth/shibboleth/');
  } catch {
    return false;
  }
}

async function readSsoProbeState(): Promise<SsoProbeState> {
  try {
    if (!chrome.storage?.session) {
      return { awaitingSsoLogin: false, lastKnownAuthenticated: false };
    }
    const result = await chrome.storage.session.get(SSO_STATE_STORAGE_KEY);
    const raw = result[SSO_STATE_STORAGE_KEY] as Partial<SsoProbeState> | undefined;
    return {
      awaitingSsoLogin: Boolean(raw?.awaitingSsoLogin),
      lastKnownAuthenticated: Boolean(raw?.lastKnownAuthenticated),
    };
  } catch {
    return { awaitingSsoLogin: false, lastKnownAuthenticated: false };
  }
}

async function writeSsoProbeState(patch: Partial<SsoProbeState>): Promise<void> {
  try {
    if (!chrome.storage?.session) {
      return;
    }
    const current = await readSsoProbeState();
    await chrome.storage.session.set({
      [SSO_STATE_STORAGE_KEY]: { ...current, ...patch },
    });
  } catch {
    // Non-fatal if session storage is unavailable
  }
}

async function hasOpenSidePanelContext(): Promise<boolean> {
  try {
    const getContexts = (
      chrome.runtime as typeof chrome.runtime & {
        getContexts?: (filter: { contextTypes: string[] }) => Promise<unknown[]>;
      }
    ).getContexts;
    if (typeof getContexts !== 'function') {
      return false;
    }
    const contexts = await getContexts({ contextTypes: ['SIDE_PANEL'] });
    return Array.isArray(contexts) && contexts.length > 0;
  } catch {
    return false;
  }
}

async function shouldProbeSessionOnTabUpdate(): Promise<boolean> {
  const probeState = await readSsoProbeState();
  if (probeState.awaitingSsoLogin) {
    return true;
  }
  if (probeState.lastKnownAuthenticated) {
    return false;
  }
  return hasOpenSidePanelContext();
}

async function broadcastEvent(event: ExtensionBroadcastEvent): Promise<void> {
  try {
    await chrome.runtime.sendMessage(event);
  } catch {
    // No active Side Panel listener — ignore silently.
  }
}

export async function probeContentLength(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  let safeUrl: string;
  try {
    safeUrl = validateAllowedMediaUrl(url, ALLOWED_MEDIA_ORIGINS);
  } catch {
    return 0;
  }

  try {
    const parsed = new URL(safeUrl);
    const head = await fetchImpl(safeUrl, {
      method: 'HEAD',
      credentials: parsed.origin === MOODLE_ORIGIN ? 'include' : 'omit',
      redirect: 'follow',
    });
    if (!head.ok) {
      return 0;
    }
    const header = head.headers.get('content-length');
    const parsedLen = header ? Number.parseInt(header, 10) : 0;
    return Number.isFinite(parsedLen) && parsedLen > 0 ? parsedLen : 0;
  } catch {
    return 0;
  }
}

function isHtmlContentType(contentType: string): boolean {
  return contentType.includes('text/html') || contentType.includes('application/xhtml+xml');
}

function isSameOrigin(urlString: string, expectedOrigin: string): boolean {
  try {
    return new URL(urlString).origin === expectedOrigin;
  } catch {
    return false;
  }
}

function inferVideoExtension(contentType: string, urlString: string): string {
  if (contentType.includes('video/webm')) {
    return 'webm';
  }
  if (contentType.includes('video/quicktime')) {
    return 'mov';
  }
  if (contentType.includes('video/x-m4v')) {
    return 'm4v';
  }
  const urlMatch = urlString.match(/\.(mp4|m4v|webm|mov)(?:[?#]|$)/i);
  return urlMatch?.[1]?.toLowerCase() ?? 'mp4';
}

export async function resolveMoodleHostedMp4(
  activity: LectureActivity,
  fetchImpl: typeof fetch = fetch,
): Promise<ResolvedLectureMedia> {
  let activityOrigin: string;
  try {
    activityOrigin = new URL(activity.url).origin;
  } catch {
    throw new Error(`Invalid Moodle activity URL for activity ${activity.cmid}.`);
  }
  if (activityOrigin !== MOODLE_ORIGIN) {
    throw new Error(`Activity ${activity.cmid} points outside the UniPD Moodle origin.`);
  }

  const controller = new AbortController();
  const response = await fetchImpl(activity.url, {
    method: 'GET',
    credentials: 'include',
    redirect: 'follow',
    signal: controller.signal,
  });

  if (!response.ok) {
    controller.abort();
    throw new Error(
      `Failed to load Moodle video activity ${activity.cmid} (HTTP ${response.status}).`,
    );
  }

  const finalUrl = response.url || activity.url;
  if (isLoginPageUrl(finalUrl)) {
    controller.abort();
    throw new MoodleSessionExpiredError(
      'Moodle session expired. Please sign in with UniPD SSO again.',
    );
  }

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();

  let mp4Url: string | null = null;
  let sizeBytes = 0;
  let fileExt = 'mp4';

  if (
    contentType.startsWith('video/') ||
    (/\.(?:mp4|m4v|webm|mov)(?:[?#]|$)/i.test(finalUrl) && !isHtmlContentType(contentType))
  ) {
    // Do not buffer a multi-hundred-MB video body into service worker memory.
    const lengthHeader = response.headers.get('content-length');
    const parsedLen = lengthHeader ? Number.parseInt(lengthHeader, 10) : 0;
    sizeBytes = Number.isFinite(parsedLen) && parsedLen > 0 ? parsedLen : 0;
    fileExt = inferVideoExtension(contentType, finalUrl);
    controller.abort();
    mp4Url = validateAllowedMediaUrl(finalUrl, ALLOWED_MEDIA_ORIGINS);
  } else if (isHtmlContentType(contentType)) {
    if (!isSameOrigin(finalUrl, MOODLE_ORIGIN)) {
      controller.abort();
      return {
        cmid: activity.cmid,
        entryId: null,
        lectureTitle: activity.title,
        durationSec: null,
        createdAtSec: null,
        flavors: [],
        captions: [],
        directMp4Url: null,
        hlsOnly: false,
      };
    }
    const html = await response.text();
    if (isUnauthenticatedMoodleHtml(html, finalUrl)) {
      throw new MoodleSessionExpiredError(
        'Moodle session expired. Please sign in with UniPD SSO again.',
      );
    }
    const extracted = extractPluginfileMp4Url(html, DEFAULT_MOODLE_BASE_URL);
    if (extracted) {
      mp4Url = validateAllowedMediaUrl(extracted, ALLOWED_MEDIA_ORIGINS);
      fileExt = inferVideoExtension('', mp4Url);
      sizeBytes = await probeContentLength(mp4Url, fetchImpl);
    }
  } else {
    // Immediately abort arbitrary non-HTML binary responses (.pdf, .zip, etc.)
    // so they are never buffered into service worker RAM.
    controller.abort();
    return {
      cmid: activity.cmid,
      entryId: null,
      lectureTitle: activity.title,
      durationSec: null,
      createdAtSec: null,
      flavors: [],
      captions: [],
      directMp4Url: null,
      hlsOnly: false,
    };
  }

  if (!mp4Url) {
    return {
      cmid: activity.cmid,
      entryId: null,
      lectureTitle: activity.title,
      durationSec: null,
      createdAtSec: null,
      flavors: [],
      captions: [],
      directMp4Url: null,
      hlsOnly: false,
    };
  }

  return {
    cmid: activity.cmid,
    entryId: null,
    lectureTitle: activity.title,
    durationSec: null,
    createdAtSec: null,
    flavors: [
      {
        id: 'moodle-mp4',
        width: 0,
        height: 0,
        bitrateKbps: 0,
        sizeBytes,
        fileExt,
        isOriginal: true,
        downloadUrl: mp4Url,
      },
    ],
    captions: [],
    directMp4Url: mp4Url,
    hlsOnly: false,
  };
}

export async function resolveActivityMedia(
  activity: LectureActivity,
  fetchImpl: typeof fetch = fetch,
): Promise<ResolvedLectureMedia> {
  if (activity.type === 'kalvidres') {
    const bridgeUrl = `${DEFAULT_MOODLE_BASE_URL}/mod/kalvidres/player_bridge.php?cmid=${encodeURIComponent(String(activity.cmid))}`;
    const controller = new AbortController();
    const response = await fetchImpl(bridgeUrl, {
      method: 'GET',
      credentials: 'include',
      redirect: 'follow',
      signal: controller.signal,
    });

    if (!response.ok) {
      controller.abort();
      throw new Error(
        `Failed to fetch Kaltura player bridge for activity ${activity.cmid} (HTTP ${response.status}).`,
      );
    }

    const finalUrl = response.url || bridgeUrl;
    if (isLoginPageUrl(finalUrl)) {
      controller.abort();
      throw new MoodleSessionExpiredError(
        'Moodle session expired. Please sign in with UniPD SSO again.',
      );
    }

    if (!isSameOrigin(finalUrl, MOODLE_ORIGIN)) {
      controller.abort();
      throw new Error(
        `Kaltura player bridge for activity ${activity.cmid} redirected outside UniPD Moodle.`,
      );
    }

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    if (contentType && !isHtmlContentType(contentType)) {
      controller.abort();
      throw new Error(`Unexpected Kaltura player bridge response type for activity ${activity.cmid}.`);
    }

    const bridgeHtml = await response.text();
    if (isUnauthenticatedMoodleHtml(bridgeHtml, finalUrl)) {
      throw new MoodleSessionExpiredError(
        'Moodle session expired. Please sign in with UniPD SSO again.',
      );
    }

    const resolved = await resolveKalturaLectureMedia(bridgeHtml, fetchImpl);
    return {
      cmid: activity.cmid,
      ...resolved,
    };
  }

  return resolveMoodleHostedMp4(activity, fetchImpl);
}

export interface ResolvedMoodleResource {
  url: string;
  fileName: string | null;
  ext: string | null;
  sizeBytes: number;
}

const CONTENT_TYPE_TO_EXT: ReadonlyArray<[RegExp, string]> = [
  [/application\/pdf/i, 'pdf'],
  [/application\/vnd\.openxmlformats-officedocument\.presentationml\.presentation/i, 'pptx'],
  [/application\/vnd\.ms-powerpoint/i, 'ppt'],
  [/application\/vnd\.oasis\.opendocument\.presentation/i, 'odp'],
  [/application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document/i, 'docx'],
  [/application\/msword/i, 'doc'],
  [/application\/vnd\.oasis\.opendocument\.text/i, 'odt'],
  [/^(?:application|text)\/rtf/i, 'rtf'],
  [/application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/i, 'xlsx'],
  [/application\/vnd\.ms-excel/i, 'xls'],
  [/application\/vnd\.oasis\.opendocument\.spreadsheet/i, 'ods'],
  [/text\/csv/i, 'csv'],
  [/text\/tab-separated-values/i, 'tsv'],
  [/application\/(?:x-)?zip(?:-compressed)?/i, 'zip'],
  [/application\/(?:vnd\.rar|x-rar-compressed)/i, 'rar'],
  [/application\/x-7z-compressed/i, '7z'],
  [/application\/(?:x-)?gzip/i, 'gz'],
  [/text\/markdown/i, 'md'],
  [/text\/plain/i, 'txt'],
  [/application\/json/i, 'json'],
  [/^(?:application|text)\/xml/i, 'xml'],
  [/application\/epub\+zip/i, 'epub'],
  [/image\/png/i, 'png'],
  [/image\/jpeg/i, 'jpg'],
  [/image\/svg\+xml/i, 'svg'],
  [/audio\/mpeg/i, 'mp3'],
  [/audio\/wav/i, 'wav'],
];

function inferExtensionFromContentType(contentType: string): string | null {
  for (const [pattern, ext] of CONTENT_TYPE_TO_EXT) {
    if (pattern.test(contentType)) {
      return ext;
    }
  }
  return null;
}

function safeDecodePathBasename(urlString: string): string | null {
  try {
    const seg = new URL(urlString).pathname.split('/').pop() ?? '';
    if (!seg) {
      return null;
    }
    try {
      return decodeURIComponent(seg);
    } catch {
      return seg;
    }
  } catch {
    return null;
  }
}

function extractExtensionFromFilename(name: string | null | undefined): string | null {
  if (!name) {
    return null;
  }
  const clean = name.trim();
  const dotIdx = clean.lastIndexOf('.');
  if (dotIdx > 0 && dotIdx < clean.length - 1) {
    const rawExt = clean.slice(dotIdx + 1).trim();
    if (/^[a-zA-Z0-9]{1,12}$/.test(rawExt)) {
      return rawExt.toLowerCase();
    }
  }
  return null;
}

function replaceFilenameExtension(existingPath: string, nextExt: string): string {
  const cleanExt = nextExt.replace(/^\.+/, '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'bin';
  const lastSlash = existingPath.lastIndexOf('/');
  const dir = lastSlash >= 0 ? existingPath.slice(0, lastSlash + 1) : '';
  const base = lastSlash >= 0 ? existingPath.slice(lastSlash + 1) : existingPath;
  const dotIdx = base.lastIndexOf('.');
  let stem = dotIdx > 0 ? base.slice(0, dotIdx) : base;
  const dupSuffix = `.${cleanExt}`;
  while (stem.length > dupSuffix.length && stem.toLowerCase().endsWith(dupSuffix)) {
    stem = stem.slice(0, -dupSuffix.length).replace(/[.\s]+$/g, '');
  }
  return `${dir}${stem || 'Untitled'}.${cleanExt}`;
}

/**
 * Lazily resolves a `mod_resource` static material URL (`/pluginfile.php/...`)
 * while strictly enforcing `MOODLE_ORIGIN`, `isLoginPageUrl()`, `isSameOrigin()`,
 * `isUnauthenticatedMoodleHtml()`, `ALLOWED_MEDIA_ORIGINS`, and immediate
 * `controller.abort()` on non-HTML binary redirects so large files never enter RAM.
 */
export async function resolveMoodleResourceDownload(
  material: CourseMaterialActivity,
  fetchImpl: typeof fetch = fetch,
): Promise<ResolvedMoodleResource> {
  let activityOrigin: string;
  try {
    activityOrigin = new URL(material.url).origin;
  } catch {
    throw new Error(`Invalid Moodle resource URL for activity ${material.cmid}.`);
  }
  if (activityOrigin !== MOODLE_ORIGIN) {
    throw new Error(`Resource ${material.cmid} points outside the UniPD Moodle origin.`);
  }

  const controller = new AbortController();
  const response = await fetchImpl(material.url, {
    method: 'GET',
    credentials: 'include',
    redirect: 'follow',
    signal: controller.signal,
  });

  if (!response.ok) {
    controller.abort();
    throw new Error(
      `Failed to load Moodle resource ${material.cmid} (HTTP ${response.status}).`,
    );
  }

  const finalUrl = response.url || material.url;
  if (isLoginPageUrl(finalUrl)) {
    controller.abort();
    throw new MoodleSessionExpiredError(
      'Moodle session expired. Please sign in with UniPD SSO again.',
    );
  }

  if (!isSameOrigin(finalUrl, MOODLE_ORIGIN)) {
    controller.abort();
    throw new Error(`Resource ${material.cmid} redirected outside the UniPD Moodle origin.`);
  }

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (!isHtmlContentType(contentType)) {
    const lengthHeader = response.headers.get('content-length');
    const parsedLen = lengthHeader ? Number.parseInt(lengthHeader, 10) : 0;
    const sizeBytes = Number.isFinite(parsedLen) && parsedLen > 0 ? parsedLen : 0;
    const cdFilename = parseContentDispositionFilename(
      response.headers.get('content-disposition'),
    );

    // Abort immediately before buffering any binary payload into service worker RAM.
    controller.abort();

    const safeUrl = validateAllowedMediaUrl(finalUrl, ALLOWED_MEDIA_ORIGINS);
    const urlBasename = safeDecodePathBasename(safeUrl);
    const fileName = cdFilename || urlBasename || null;
    const ext =
      extractExtensionFromFilename(cdFilename) ||
      extractExtensionFromFilename(urlBasename) ||
      inferExtensionFromContentType(contentType) ||
      (material.fileTypeHint &&
      !['slides', 'doc', 'sheet', 'archive', 'folder'].includes(material.fileTypeHint)
        ? material.fileTypeHint
        : null);

    return {
      url: safeUrl,
      fileName,
      ext,
      sizeBytes,
    };
  }

  const html = await response.text();
  if (isUnauthenticatedMoodleHtml(html, finalUrl)) {
    throw new MoodleSessionExpiredError(
      'Moodle session expired. Please sign in with UniPD SSO again.',
    );
  }

  const extracted = extractPluginfileResourceUrl(html, DEFAULT_MOODLE_BASE_URL);
  if (!extracted) {
    const cdHeader = response.headers.get('content-disposition');
    const hasAttachmentDisposition = Boolean(cdHeader && /^\s*attachment\b/i.test(cdHeader));
    const isDirectPluginfileHtml = /\/pluginfile\.php\//i.test(finalUrl) || hasAttachmentDisposition;

    if (isDirectPluginfileHtml) {
      const safeUrl = validateAllowedMediaUrl(finalUrl, ALLOWED_MEDIA_ORIGINS);
      const cdFilename = parseContentDispositionFilename(cdHeader);
      const urlBasename = safeDecodePathBasename(safeUrl);
      const fileName = cdFilename || urlBasename || null;
      const ext =
        extractExtensionFromFilename(cdFilename) ||
        extractExtensionFromFilename(urlBasename) ||
        'html';
      const lengthHeader = response.headers.get('content-length');
      const parsedLen = lengthHeader ? Number.parseInt(lengthHeader, 10) : 0;
      const sizeBytes =
        Number.isFinite(parsedLen) && parsedLen > 0
          ? parsedLen
          : await probeContentLength(safeUrl, fetchImpl);

      return {
        url: safeUrl,
        fileName,
        ext,
        sizeBytes,
      };
    }

    throw new Error(`No downloadable file link found for resource ${material.cmid}.`);
  }

  const safeUrl = validateAllowedMediaUrl(extracted, ALLOWED_MEDIA_ORIGINS);
  const urlBasename = safeDecodePathBasename(safeUrl);
  const ext =
    extractExtensionFromFilename(urlBasename) ||
    (material.fileTypeHint &&
    !['slides', 'doc', 'sheet', 'archive', 'folder'].includes(material.fileTypeHint)
      ? material.fileTypeHint
      : null);
  const sizeBytes = await probeContentLength(safeUrl, fetchImpl);

  return {
    url: safeUrl,
    fileName: urlBasename,
    ext,
    sizeBytes,
  };
}

/**
 * Lazily resolves the file list of a Moodle `mod_folder` activity on demand,
 * enforcing `MOODLE_ORIGIN`, `isLoginPageUrl()`, `isSameOrigin()`, and
 * `isUnauthenticatedMoodleHtml()`.
 */
export async function resolveMoodleFolderFiles(
  material: CourseMaterialActivity,
  fetchImpl: typeof fetch = fetch,
): Promise<FolderFileEntry[]> {
  let activityOrigin: string;
  try {
    activityOrigin = new URL(material.url).origin;
  } catch {
    throw new Error(`Invalid Moodle folder URL for activity ${material.cmid}.`);
  }
  if (activityOrigin !== MOODLE_ORIGIN) {
    throw new Error(`Folder ${material.cmid} points outside the UniPD Moodle origin.`);
  }

  const controller = new AbortController();
  const response = await fetchImpl(material.url, {
    method: 'GET',
    credentials: 'include',
    redirect: 'follow',
    signal: controller.signal,
  });

  if (!response.ok) {
    controller.abort();
    throw new Error(
      `Failed to load Moodle folder ${material.cmid} (HTTP ${response.status}).`,
    );
  }

  const finalUrl = response.url || material.url;
  if (isLoginPageUrl(finalUrl)) {
    controller.abort();
    throw new MoodleSessionExpiredError(
      'Moodle session expired. Please sign in with UniPD SSO again.',
    );
  }

  if (!isSameOrigin(finalUrl, MOODLE_ORIGIN)) {
    controller.abort();
    throw new Error(`Folder ${material.cmid} redirected outside the UniPD Moodle origin.`);
  }

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (contentType && !isHtmlContentType(contentType)) {
    controller.abort();
    throw new Error(`Unexpected non-HTML response for folder ${material.cmid}.`);
  }

  const html = await response.text();
  if (isUnauthenticatedMoodleHtml(html, finalUrl)) {
    throw new MoodleSessionExpiredError(
      'Moodle session expired. Please sign in with UniPD SSO again.',
    );
  }

  return parseFolderFilesFromHtml(html, DEFAULT_MOODLE_BASE_URL);
}

function selectFlavorForDescriptor(
  flavors: VideoFlavor[],
  descriptor: Extract<DownloadResolutionDescriptor, { kind: 'video' | 'subtitle' }>,
): VideoFlavor | null {
  if (flavors.length === 0) {
    return null;
  }
  if (descriptor.preferredFlavorId) {
    const exactId = flavors.find((f) => f.id === descriptor.preferredFlavorId);
    if (exactId) {
      return exactId;
    }
  }
  if (typeof descriptor.preferredHeight === 'number' && descriptor.preferredHeight > 0) {
    const exactHeight = flavors.find((f) => f.height === descriptor.preferredHeight);
    if (exactHeight) {
      return exactHeight;
    }
    const nearest = [...flavors].sort(
      (a, b) =>
        Math.abs(a.height - descriptor.preferredHeight!) -
        Math.abs(b.height - descriptor.preferredHeight!),
    );
    if (nearest[0]) {
      return nearest[0];
    }
  }
  return flavors[0] ?? null;
}

function selectCaptionForDescriptor(
  captions: CaptionTrack[],
  descriptor: Extract<DownloadResolutionDescriptor, { kind: 'video' | 'subtitle' }>,
): CaptionTrack | null {
  if (captions.length === 0) {
    return null;
  }

  const targetLang = descriptor.captionLanguageCode?.trim().toLowerCase() ?? null;
  const targetLabel = descriptor.captionLabel?.trim().toLowerCase() ?? null;

  if (targetLang && targetLabel) {
    const exactBoth = captions.find(
      (c) =>
        c.languageCode.trim().toLowerCase() === targetLang &&
        c.label.trim().toLowerCase() === targetLabel,
    );
    if (exactBoth) {
      return exactBoth;
    }
  }

  if (
    typeof descriptor.captionIndex === 'number' &&
    descriptor.captionIndex >= 0 &&
    descriptor.captionIndex < captions.length
  ) {
    const indexed = captions[descriptor.captionIndex];
    if (indexed && (!targetLang || indexed.languageCode.trim().toLowerCase() === targetLang)) {
      return indexed;
    }
  }

  if (targetLang) {
    const byLang = captions.find((c) => c.languageCode.trim().toLowerCase() === targetLang);
    if (byLang) {
      return byLang;
    }
  }

  if (
    typeof descriptor.captionIndex === 'number' &&
    descriptor.captionIndex >= 0 &&
    descriptor.captionIndex < captions.length
  ) {
    return captions[descriptor.captionIndex] ?? null;
  }

  return captions[0] ?? null;
}

/**
 * Lazily resolves a fresh, allowlist-validated download URL on dequeue from a
 * secret-free `DownloadResolutionDescriptor`. Keeps Kaltura `ks` and Moodle
 * file links fresh across MV3 service worker restarts and >1h download batches.
 */
export async function resolveDownloadUrlFromDescriptor(
  descriptor: DownloadResolutionDescriptor,
  fetchImpl: typeof fetch = fetch,
): Promise<string | ResolvedDownloadTarget> {
  if (descriptor.kind === 'material') {
    if (descriptor.material.type === 'folder') {
      const files = await resolveMoodleFolderFiles(descriptor.material, fetchImpl);
      const hasIndex = typeof descriptor.folderFileIndex === 'number';
      const hasExpectedName = Boolean(descriptor.expectedFileName);
      const target =
        hasIndex && hasExpectedName
          ? (files.find(
              (f) =>
                f.fileIndex === descriptor.folderFileIndex &&
                f.name === descriptor.expectedFileName,
            ) ?? files.find((f) => f.name === descriptor.expectedFileName))
          : hasExpectedName
            ? files.find((f) => f.name === descriptor.expectedFileName)
            : hasIndex
              ? files.find((f) => f.fileIndex === descriptor.folderFileIndex)
              : undefined;

      if (!target) {
        throw new Error('Requested folder file is no longer available.');
      }

      const safeUrl = validateAllowedMediaUrl(target.url, ALLOWED_MEDIA_ORIGINS);
      const resolvedFilename = descriptor.pathContext
        ? buildMaterialDownloadPath({
            academicYear: descriptor.pathContext.academicYear,
            courseCode: descriptor.pathContext.courseCode,
            courseTitle: descriptor.pathContext.courseTitle,
            sectionIndex: descriptor.material.sectionIndex,
            sectionTitle: descriptor.material.sectionTitle,
            activityIndex: descriptor.material.activityIndex,
            materialTitle: descriptor.material.title,
            folderName: descriptor.material.title,
            subPath: target.subPath,
            fileName: target.name,
            ext: target.ext,
          })
        : descriptor.filename;

      return {
        url: safeUrl,
        resolvedFilename,
      };
    }

    const resolved = await resolveMoodleResourceDownload(descriptor.material, fetchImpl);
    let resolvedFilename = descriptor.filename;
    if (resolved.ext) {
      if (descriptor.pathContext) {
        resolvedFilename = buildMaterialDownloadPath({
          academicYear: descriptor.pathContext.academicYear,
          courseCode: descriptor.pathContext.courseCode,
          courseTitle: descriptor.pathContext.courseTitle,
          sectionIndex: descriptor.material.sectionIndex,
          sectionTitle: descriptor.material.sectionTitle,
          activityIndex: descriptor.material.activityIndex,
          materialTitle: descriptor.material.title || resolved.fileName || 'Material',
          ext: resolved.ext,
        });
      } else {
        resolvedFilename = replaceFilenameExtension(descriptor.filename, resolved.ext);
      }
    }

    return {
      url: resolved.url,
      resolvedFilename,
      resolvedSizeBytes: resolved.sizeBytes,
    };
  }

  const media = await resolveActivityMedia(descriptor.activity, fetchImpl);

  if (descriptor.kind === 'subtitle') {
    const caption = selectCaptionForDescriptor(media.captions, descriptor);
    if (!caption?.vttUrl) {
      throw new Error('Requested WebVTT subtitle track is no longer available.');
    }
    return validateAllowedMediaUrl(caption.vttUrl, ALLOWED_MEDIA_ORIGINS);
  }

  const flavor = selectFlavorForDescriptor(media.flavors, descriptor);
  const rawUrl = flavor?.downloadUrl ?? media.directMp4Url;
  if (!rawUrl) {
    throw new Error('No downloadable MP4 stream is available for this lecture.');
  }
  return validateAllowedMediaUrl(rawUrl, ALLOWED_MEDIA_ORIGINS);
}

let activeDownloadManager: DownloadManager | null = null;
let activeAuthManager: AuthManager | null = null;

export function getAuthManager(): AuthManager {
  if (!activeAuthManager) {
    activeAuthManager = new AuthManager({
      onSessionUpdated(session) {
        void writeSsoProbeState({
          lastKnownAuthenticated: session.authenticated,
          ...(session.authenticated ? { awaitingSsoLogin: false } : {}),
        });
        if (session.authenticated) {
          void broadcastEvent({
            type: 'SESSION_UPDATED',
            session: toPublicSession(session),
          });
        }
      },
      onAuthConfigUpdated(config) {
        void broadcastEvent({
          type: 'AUTH_CONFIG_UPDATED',
          config,
        });
      },
    });
  }
  return activeAuthManager;
}

function getDownloadManager(): DownloadManager {
  if (!activeDownloadManager) {
    activeDownloadManager = new DownloadManager({
      api: createChromeDownloadsAdapter(),
      storage: createSessionQueueStorageAdapter(),
      maxConcurrent: DEFAULT_MAX_CONCURRENT_DOWNLOADS,
      resolveDownloadUrl: (descriptor) =>
        getAuthManager().withAutoReauth(() => resolveDownloadUrlFromDescriptor(descriptor)),
      allowedOrigins: ALLOWED_MEDIA_ORIGINS,
      onStateChange(state) {
        void broadcastEvent({ type: 'QUEUE_UPDATED', state });
      },
      onDownloadCompleted: async (descriptor) => {
        const entries = await recordCompletedDownloadHistory(descriptor);
        await broadcastEvent({ type: 'DOWNLOAD_HISTORY_UPDATED', entries });
      },
    });
  }
  return activeDownloadManager;
}

async function configureSidePanelBehavior(): Promise<void> {
  try {
    if (chrome.sidePanel?.setPanelBehavior) {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    }
  } catch (err) {
    console.error('[moodle-sw] Failed to configure sidePanel behavior:', sanitizeErrorMessage(err));
  }
}

export async function handleMessage(
  request: ExtensionRequest,
): Promise<ExtensionResponse<ExtensionRequest['type']>> {
  const manager = getDownloadManager();
  const auth = getAuthManager();

  switch (request.type) {
    case 'GET_SESSION_STATUS': {
      let session: MoodleSessionInfo;
      try {
        session = await auth.ensureAuthenticated({
          allowAutoLogin: request.autoLogin !== false,
        });
      } catch (err) {
        if (!(err instanceof ShibbolethAuthError)) {
          throw err;
        }
        session = {
          authenticated: false,
          userId: null,
          sesskey: null,
          loginUrl: `${DEFAULT_MOODLE_BASE_URL}${UNIPD_SHIBBOLETH_LOGIN_PATH}`,
        };
      }
      await writeSsoProbeState({
        lastKnownAuthenticated: session.authenticated,
        ...(session.authenticated ? { awaitingSsoLogin: false } : {}),
      });
      return { ok: true, session: toPublicSession(session) };
    }

    case 'OPEN_SSO_LOGIN': {
      const loginUrl = `${DEFAULT_MOODLE_BASE_URL}${UNIPD_SHIBBOLETH_LOGIN_PATH}`;
      await writeSsoProbeState({ awaitingSsoLogin: true });
      const tab = await chrome.tabs.create({ url: loginUrl, active: true });
      return { ok: true, opened: true, tabId: tab.id ?? null };
    }

    case 'GET_AUTH_CONFIG': {
      const config = await auth.getAuthConfig();
      return { ok: true, config };
    }

    case 'SAVE_AUTH_CREDENTIALS': {
      let config = await auth.saveCredentials({
        username: request.username,
        domain: request.domain,
        password: request.password,
        enabled: request.enabled,
      });
      let session: MoodleSessionInfo | undefined;
      if (config.enabled) {
        try {
          session = await auth.ensureAuthenticated({ allowAutoLogin: true });
          config = await auth.getAuthConfig();
        } catch {
          config = await auth.getAuthConfig();
        }
      }
      return {
        ok: true,
        config,
        ...(session ? { session: toPublicSession(session) } : {}),
      };
    }

    case 'CLEAR_AUTH_CREDENTIALS': {
      const config = await auth.clearCredentials();
      return { ok: true, config };
    }

    case 'SET_AUTO_LOGIN_ENABLED': {
      let config = await auth.setAutoLoginEnabled(request.enabled);
      let session: MoodleSessionInfo | undefined;
      if (config.enabled && config.configured && !config.blockedReason) {
        try {
          session = await auth.ensureAuthenticated({ allowAutoLogin: true });
          config = await auth.getAuthConfig();
        } catch {
          config = await auth.getAuthConfig();
        }
      }
      return {
        ok: true,
        config,
        ...(session ? { session: toPublicSession(session) } : {}),
      };
    }

    case 'AUTO_LOGIN_NOW': {
      const session = await auth.ensureAuthenticated({
        allowAutoLogin: true,
        forceAutoLogin: true,
      });
      const config = await auth.getAuthConfig();
      return {
        ok: true,
        config,
        session: toPublicSession(session),
      };
    }

    case 'LIST_COURSES': {
      const courses = await auth.withAutoReauth(async () => {
        const session = await fetchMoodleSession(DEFAULT_MOODLE_BASE_URL);
        await writeSsoProbeState({
          lastKnownAuthenticated: session.authenticated,
          ...(session.authenticated ? { awaitingSsoLogin: false } : {}),
        });
        if (!session.authenticated || !session.sesskey) {
          throw new MoodleSessionExpiredError(
            'Not signed in to UniPD Moodle. Please log in with UniPD SSO first.',
          );
        }
        return fetchEnrolledCourses(DEFAULT_MOODLE_BASE_URL, session.sesskey);
      });
      return { ok: true, courses };
    }

    case 'SCAN_COURSE_LECTURES': {
      const scan = await auth.withAutoReauth(async () => {
        const html = await fetchCoursePageHtml(DEFAULT_MOODLE_BASE_URL, request.courseId);
        return parseCourseContentFromHtml(html, request.courseId, DEFAULT_MOODLE_BASE_URL);
      });
      return {
        ok: true,
        courseId: request.courseId,
        sections: scan.sections,
        materialSections: scan.materialSections,
      };
    }

    case 'RESOLVE_LECTURE_MEDIA': {
      const media = await auth.withAutoReauth(() => resolveActivityMedia(request.activity));
      return { ok: true, media: toPublicLectureMedia(media) };
    }

    case 'RESOLVE_FOLDER_FILES': {
      const files = await auth.withAutoReauth(() => resolveMoodleFolderFiles(request.material));
      return { ok: true, files: toPublicFolderFiles(files) };
    }

    case 'ENQUEUE_DOWNLOADS': {
      const enqueuedIds = await manager.enqueue(request.items);
      const state = manager.getState();
      return { ok: true, enqueuedIds, state };
    }

    case 'GET_QUEUE_STATE': {
      const state = await manager.refreshActiveProgress();
      return { ok: true, state };
    }

    case 'CANCEL_DOWNLOAD': {
      const state = await manager.cancel(request.taskId);
      return { ok: true, state };
    }

    case 'RETRY_DOWNLOAD': {
      const state = await manager.retry(request.taskId);
      return { ok: true, state };
    }

    case 'CLEAR_FINISHED_DOWNLOADS': {
      const state = await manager.clearFinished();
      return { ok: true, state };
    }

    case 'GET_DOWNLOAD_HISTORY': {
      const entries = await readDownloadHistory();
      return { ok: true, entries };
    }

    default: {
      const unknownType = (request as { type?: unknown }).type;
      return {
        ok: false,
        error: `Unsupported extension message type: ${String(unknownType)}`,
      };
    }
  }
}

function registerServiceWorkerListeners(): void {
  void configureSidePanelBehavior();

  chrome.runtime.onInstalled.addListener(() => {
    void configureSidePanelBehavior();
  });

  chrome.downloads.onDeterminingFilename?.addListener((item, suggest) => {
    if (item.byExtensionId !== chrome.runtime.id) {
      suggest();
      return;
    }

    const targetFilename = getDownloadManager().resolveDeterminingFilename(item);
    if (targetFilename) {
      suggest({ filename: targetFilename, conflictAction: 'uniquify' });
      return;
    }
    suggest();
  });

  chrome.downloads.onChanged.addListener((delta) => {
    void (async () => {
      try {
        await getDownloadManager().handleDownloadDelta({
          id: delta.id,
          state: delta.state,
          error: delta.error,
        });
      } catch {
        // Non-fatal if storage/download query fails during delta reconciliation
      }
    })();
  });

  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'complete' || !tab.url) {
      return;
    }
    if (!isMoodlePostLoginUrl(tab.url, DEFAULT_MOODLE_BASE_URL)) {
      return;
    }

    void (async () => {
      try {
        const shouldProbe = await shouldProbeSessionOnTabUpdate();
        if (!shouldProbe) {
          return;
        }
        const session = await fetchMoodleSession(DEFAULT_MOODLE_BASE_URL);
        await writeSsoProbeState({
          lastKnownAuthenticated: session.authenticated,
          ...(session.authenticated ? { awaitingSsoLogin: false } : {}),
        });
        if (session.authenticated) {
          await broadcastEvent({
            type: 'SESSION_UPDATED',
            session: toPublicSession(session),
          });
        }
      } catch {
        // Ignore transient network errors during tab refresh
      }
    })();
  });

  chrome.runtime.onMessage.addListener((message: ExtensionRequest, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) {
      return false;
    }
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
      return false;
    }

    void (async () => {
      try {
        const response = await handleMessage(message);
        sendResponse(response);
      } catch (err) {
        sendResponse({
          ok: false,
          error: sanitizeErrorMessage(err),
        });
      }
    })();

    return true;
  });
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  registerServiceWorkerListeners();
}
