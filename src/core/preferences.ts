import type {
  ActiveContentTab,
  DownloadHistoryEntry,
  QualityPreference,
  UserPreferences,
} from './types.js';

export const USER_PREFERENCES_STORAGE_KEY = 'unipd_user_prefs_v1';
export const DOWNLOAD_HISTORY_STORAGE_KEY = 'unipd_download_history_v1';
export const MAX_DOWNLOAD_HISTORY_ENTRIES = 500;

export const DEFAULT_USER_PREFERENCES: Readonly<UserPreferences> = {
  defaultQuality: 'highest',
  includeVtt: true,
  activeContentTab: 'videos',
  skipDownloaded: false,
};

const VALID_QUALITIES = new Set<QualityPreference>(['highest', '1080p', '720p', '360p']);
const VALID_TABS = new Set<ActiveContentTab>(['videos', 'materials']);
const VALID_HISTORY_KEY_PATTERN = /^\d+:\d+:(video|subtitle|material):[^\s?#]+$/;

/**
 * Normalizes potentially missing or corrupted persisted preferences into a valid
 * `UserPreferences` object without mutating or leaking unrelated properties.
 */
export function normalizeUserPreferences(raw: unknown): UserPreferences {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_USER_PREFERENCES };
  }
  const obj = raw as Record<string, unknown>;
  const defaultQuality =
    typeof obj.defaultQuality === 'string' && VALID_QUALITIES.has(obj.defaultQuality as QualityPreference)
      ? (obj.defaultQuality as QualityPreference)
      : DEFAULT_USER_PREFERENCES.defaultQuality;
  const activeContentTab =
    typeof obj.activeContentTab === 'string' && VALID_TABS.has(obj.activeContentTab as ActiveContentTab)
      ? (obj.activeContentTab as ActiveContentTab)
      : DEFAULT_USER_PREFERENCES.activeContentTab;

  return {
    defaultQuality,
    includeVtt:
      typeof obj.includeVtt === 'boolean' ? obj.includeVtt : DEFAULT_USER_PREFERENCES.includeVtt,
    activeContentTab,
    skipDownloaded:
      typeof obj.skipDownloaded === 'boolean'
        ? obj.skipDownloaded
        : DEFAULT_USER_PREFERENCES.skipDownloaded,
  };
}

function sanitizeHistoryVariant(rawVariant: string): string {
  const cleaned = rawVariant
    .trim()
    .toLowerCase()
    .replace(/[\r\n\t\s]+/g, '_')
    .replace(/[?#&:;/\\]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return cleaned || 'default';
}

export function buildFolderFileHistoryVariant(
  fileName?: string | null,
  fileIndex?: number,
): string {
  if (typeof fileName === 'string' && fileName.trim().length > 0) {
    return `file_${sanitizeHistoryVariant(fileName)}`;
  }
  if (typeof fileIndex === 'number' && Number.isFinite(fileIndex) && fileIndex >= 0) {
    return `file-${Math.trunc(fileIndex)}`;
  }
  return 'file';
}

export interface BuildDownloadHistoryKeyParams {
  courseId: number;
  cmid: number;
  kind: 'video' | 'subtitle' | 'material';
  variant: string;
}

/**
 * Builds a canonical secret-free `courseId:cmid:kind:variant` download history key.
 */
export function buildDownloadHistoryKey(params: BuildDownloadHistoryKeyParams): string {
  const courseId = Number.isFinite(params.courseId) && params.courseId > 0 ? Math.trunc(params.courseId) : 0;
  const cmid = Number.isFinite(params.cmid) && params.cmid > 0 ? Math.trunc(params.cmid) : 0;
  const variant = sanitizeHistoryVariant(params.variant);
  return `${courseId}:${cmid}:${params.kind}:${variant}`;
}

export function isValidHistoryKey(key: string): boolean {
  if (!key || key.length > 160) {
    return false;
  }
  if (/https?:|ks=|sesskey=|policy=|signature=/i.test(key)) {
    return false;
  }
  return VALID_HISTORY_KEY_PATTERN.test(key);
}

/**
 * Normalizes a persisted history array, deduplicating keys and trimming to the
 * newest `maxEntries` (oldest-first storage array; end of array is most recent).
 */
export function normalizeDownloadHistoryEntries(
  raw: unknown,
  maxEntries: number = MAX_DOWNLOAD_HISTORY_ENTRIES,
): DownloadHistoryEntry[] {
  if (!Array.isArray(raw) || maxEntries <= 0) {
    return [];
  }

  const deduped = new Map<string, number>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const entry = item as Record<string, unknown>;
    if (typeof entry.key !== 'string' || !isValidHistoryKey(entry.key)) {
      continue;
    }
    const completedAt =
      typeof entry.completedAt === 'number' && Number.isFinite(entry.completedAt) && entry.completedAt >= 0
        ? Math.trunc(entry.completedAt)
        : 0;
    if (deduped.has(entry.key)) {
      deduped.delete(entry.key);
    }
    deduped.set(entry.key, completedAt);
  }

  const normalized: DownloadHistoryEntry[] = Array.from(deduped.entries()).map(
    ([key, completedAt]) => ({ key, completedAt }),
  );
  if (normalized.length > maxEntries) {
    return normalized.slice(normalized.length - maxEntries);
  }
  return normalized;
}

/**
 * Inserts or promotes `key` to the most-recent slot of a bounded LRU history array.
 */
export function recordDownloadHistoryLru(
  entries: readonly DownloadHistoryEntry[],
  key: string,
  completedAt: number = Date.now(),
  maxEntries: number = MAX_DOWNLOAD_HISTORY_ENTRIES,
): DownloadHistoryEntry[] {
  if (!isValidHistoryKey(key) || maxEntries <= 0) {
    return normalizeDownloadHistoryEntries(entries, maxEntries);
  }

  const safeTimestamp =
    Number.isFinite(completedAt) && completedAt >= 0 ? Math.trunc(completedAt) : Date.now();
  const filtered = entries.filter((entry) => entry.key !== key && isValidHistoryKey(entry.key));
  filtered.push({ key, completedAt: safeTimestamp });

  if (filtered.length > maxEntries) {
    return filtered.slice(filtered.length - maxEntries);
  }
  return filtered;
}

export function createHistoryKeySet(entries: readonly DownloadHistoryEntry[]): Set<string> {
  return new Set(entries.map((entry) => entry.key));
}

export function hasVideoDownloadHistory(
  historyKeys: ReadonlySet<string>,
  courseId: number,
  cmid: number,
): boolean {
  const prefix = `${Math.trunc(courseId)}:${Math.trunc(cmid)}:video:`;
  for (const key of historyKeys) {
    if (key.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

export function hasResourceDownloadHistory(
  historyKeys: ReadonlySet<string>,
  courseId: number,
  cmid: number,
): boolean {
  return historyKeys.has(
    buildDownloadHistoryKey({
      courseId,
      cmid,
      kind: 'material',
      variant: 'resource',
    }),
  );
}

export function hasFolderFileDownloadHistory(
  historyKeys: ReadonlySet<string>,
  courseId: number,
  cmid: number,
  fileName?: string | null,
  fileIndex?: number,
): boolean {
  return historyKeys.has(
    buildDownloadHistoryKey({
      courseId,
      cmid,
      kind: 'material',
      variant: buildFolderFileHistoryVariant(fileName, fileIndex),
    }),
  );
}
