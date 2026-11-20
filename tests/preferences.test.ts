import { describe, expect, it } from 'vitest';
import {
  DEFAULT_USER_PREFERENCES,
  MAX_DOWNLOAD_HISTORY_ENTRIES,
  buildDownloadHistoryKey,
  buildFolderFileHistoryVariant,
  createHistoryKeySet,
  hasFolderFileDownloadHistory,
  hasResourceDownloadHistory,
  hasVideoDownloadHistory,
  isValidHistoryKey,
  normalizeDownloadHistoryEntries,
  normalizeUserPreferences,
  recordDownloadHistoryLru,
} from '../src/core/preferences.js';

describe('preferences & secret-free download history [TASK-007]', () => {
  it('normalizes missing, partial, or invalid user preferences safely', () => {
    expect(normalizeUserPreferences(undefined)).toEqual(DEFAULT_USER_PREFERENCES);
    expect(normalizeUserPreferences(null)).toEqual(DEFAULT_USER_PREFERENCES);
    expect(
      normalizeUserPreferences({
        defaultQuality: '4k-invalid',
        includeVtt: 'yes',
        activeContentTab: 'unknown-tab',
        skipDownloaded: true,
      }),
    ).toEqual({
      defaultQuality: 'highest',
      includeVtt: true,
      activeContentTab: 'videos',
      skipDownloaded: true,
    });

    expect(
      normalizeUserPreferences({
        defaultQuality: '720p',
        includeVtt: false,
        activeContentTab: 'materials',
        skipDownloaded: true,
      }),
    ).toEqual({
      defaultQuality: '720p',
      includeVtt: false,
      activeContentTab: 'materials',
      skipDownloaded: true,
    });
  });

  it('builds canonical secret-free courseId:cmid:kind:variant keys and handles folder filenames with ?', () => {
    const videoKey = buildDownloadHistoryKey({
      courseId: 7075,
      cmid: 300151,
      kind: 'video',
      variant: '1080p',
    });
    const subKey = buildDownloadHistoryKey({
      courseId: 7075,
      cmid: 300151,
      kind: 'subtitle',
      variant: 'en',
    });
    const resKey = buildDownloadHistoryKey({
      courseId: 7075,
      cmid: 298700,
      kind: 'material',
      variant: 'resource',
    });
    const folderKey = buildDownloadHistoryKey({
      courseId: 7075,
      cmid: 298753,
      kind: 'material',
      variant: buildFolderFileHistoryVariant('Are Emotions Natural Kinds?.pdf', 2),
    });

    expect(videoKey).toBe('7075:300151:video:1080p');
    expect(subKey).toBe('7075:300151:subtitle:en');
    expect(resKey).toBe('7075:298700:material:resource');
    expect(folderKey).toBe('7075:298753:material:file_are_emotions_natural_kinds_.pdf');
    expect(isValidHistoryKey(folderKey)).toBe(true);

    const set = createHistoryKeySet([
      { key: videoKey, completedAt: 1 },
      { key: resKey, completedAt: 2 },
      { key: folderKey, completedAt: 3 },
    ]);
    expect(hasVideoDownloadHistory(set, 7075, 300151)).toBe(true);
    expect(hasVideoDownloadHistory(set, 7075, 999999)).toBe(false);
    expect(hasResourceDownloadHistory(set, 7075, 298700)).toBe(true);
    expect(
      hasFolderFileDownloadHistory(set, 7075, 298753, 'Are Emotions Natural Kinds?.pdf', 9),
    ).toBe(true);
  });

  it('maintains bounded 500-entry LRU ordering and rejects keys containing URLs or tokens', () => {
    let entries: { key: string; completedAt: number }[] = [];
    for (let i = 1; i <= MAX_DOWNLOAD_HISTORY_ENTRIES + 5; i += 1) {
      entries = recordDownloadHistoryLru(entries, `7075:${i}:material:resource`, i * 10);
    }

    expect(entries).toHaveLength(MAX_DOWNLOAD_HISTORY_ENTRIES);
    expect(entries[0]?.key).toBe('7075:6:material:resource');
    expect(entries.at(-1)?.key).toBe(`7075:${MAX_DOWNLOAD_HISTORY_ENTRIES + 5}:material:resource`);

    // Promoting an existing key moves it to MRU without inflating length
    entries = recordDownloadHistoryLru(entries, '7075:6:material:resource', 999_999);
    expect(entries).toHaveLength(MAX_DOWNLOAD_HISTORY_ENTRIES);
    expect(entries[0]?.key).toBe('7075:7:material:resource');
    expect(entries.at(-1)).toEqual({
      key: '7075:6:material:resource',
      completedAt: 999_999,
    });

    const sanitized = normalizeDownloadHistoryEntries([
      { key: '7075:1:video:https://cdn.example/a.mp4?ks=SECRET', completedAt: 1 },
      { key: '7075:2:material:ks=LEAKED', completedAt: 2 },
      { key: 'invalid-entry', completedAt: 3 },
      { key: '7075:10:material:file_privacy_policy.pdf', completedAt: 4 },
    ]);
    expect(sanitized).toEqual([{ key: '7075:10:material:file_privacy_policy.pdf', completedAt: 4 }]);
  });
});
