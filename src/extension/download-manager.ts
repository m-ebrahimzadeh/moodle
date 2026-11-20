import {
  MAX_RELATIVE_DOWNLOAD_PATH_LENGTH,
  sanitizePathSegment,
} from '../core/path-builder.js';
import type {
  DownloadKind,
  DownloadQueueItem,
  DownloadQueueState,
  DownloadResolutionDescriptor,
  EnqueueDownloadItem,
} from './messages.js';

export const DEFAULT_MAX_CONCURRENT_DOWNLOADS = 2;
export const CANCELLED_BY_USER_MESSAGE = 'Cancelled by user';
export const VANISHED_DOWNLOAD_MESSAGE = 'Download record no longer exists in Chrome.';

/**
 * Exact origin allowlist matching `public/manifest.json` `host_permissions`.
 */
export const ALLOWED_MEDIA_ORIGINS: ReadonlySet<string> = new Set([
  'https://psico.elearning.unipd.it',
  'https://cdnapisec.kaltura.com',
  'https://cfvod.kaltura.com',
  'https://cdnsecakmi.kaltura.com',
]);

export interface ChromeDownloadDeltaLike {
  id: number;
  state?: {
    previous?: string;
    current?: string;
  };
  error?: {
    previous?: string;
    current?: string;
  };
}

export interface ChromeDownloadItemLike {
  id: number;
  state?: string;
  bytesReceived?: number;
  totalBytes?: number;
  error?: string;
}

export interface DownloadsApiAdapter {
  download(options: {
    url: string;
    filename: string;
    conflictAction?: 'uniquify' | 'overwrite' | 'prompt';
    saveAs?: boolean;
  }): Promise<number>;
  cancel(downloadId: number): Promise<void>;
  search(query: { id: number }): Promise<ChromeDownloadItemLike[]>;
}

/**
 * Secret-free queue entry persisted in `chrome.storage.session`.
 * Contains no `ks`, `sesskey`, cookies, or signed CDN URLs.
 */
export interface PersistedDownloadEntry {
  item: DownloadQueueItem;
  descriptor: DownloadResolutionDescriptor | null;
}

export interface QueueStorageAdapter {
  load(): Promise<PersistedDownloadEntry[]>;
  save(entries: PersistedDownloadEntry[]): Promise<void>;
}

export interface ResolvedDownloadTarget {
  url: string;
  resolvedFilename?: string;
  resolvedSizeBytes?: number;
}

export type DownloadUrlResolver = (
  descriptor: DownloadResolutionDescriptor,
) => Promise<string | ResolvedDownloadTarget>;

interface InternalDownloadEntry {
  item: DownloadQueueItem;
  descriptor: DownloadResolutionDescriptor | null;
  cancelRequested: boolean;
}

/**
 * Validates that a resolved download or probe URL uses `https:` and belongs to
 * an allowed UniPD Moodle / Kaltura origin. Throws a secret-free error otherwise.
 */
export function validateAllowedMediaUrl(
  rawUrl: string,
  allowedOrigins: ReadonlySet<string> = ALLOWED_MEDIA_ORIGINS,
): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Download URL is malformed.');
  }

  if (parsed.protocol !== 'https:' || !allowedOrigins.has(parsed.origin)) {
    throw new Error('Download URL origin is not in the allowed host list.');
  }

  return parsed.toString();
}

/**
 * Strips query parameters, path-embedded Kaltura `/ks/<token>` segments, and
 * sensitive token/cookie key-value pairs (`ks`, `sesskey`, `Policy`, `Signature`,
 * `Key-Pair-Id`, `MoodleSession*`, `_shibsession_*`) so error strings are
 * guaranteed safe for UI display and diagnostics.
 */
export function sanitizeErrorMessage(raw: unknown): string {
  const message =
    raw instanceof Error
      ? raw.message
      : typeof raw === 'string'
        ? raw
        : 'Download failed';

  return message
    .replace(/https?:\/\/[^\s)"']+/gi, (matched) => {
      try {
        const parsed = new URL(matched);
        return `${parsed.origin}${parsed.pathname}`;
      } catch {
        return '[REDACTED_URL]';
      }
    })
    .replace(/\/ks\/[^/\s?#)]+/gi, '/ks/[REDACTED]')
    .replace(
      /\b((?:ks|sesskey|Policy|Signature|Key-Pair-Id|MoodleSession\w*|_shibsession_\w+)=)[^&\s;)]+/gi,
      '$1[REDACTED]',
    );
}

export function createChromeDownloadsAdapter(): DownloadsApiAdapter {
  return {
    async download(options) {
      const id = await chrome.downloads.download({
        url: options.url,
        filename: options.filename,
        conflictAction: options.conflictAction ?? 'uniquify',
        saveAs: options.saveAs ?? false,
      });
      if (typeof id !== 'number') {
        throw new Error('Chrome did not return a download identifier.');
      }
      return id;
    },
    async cancel(downloadId) {
      await chrome.downloads.cancel(downloadId);
    },
    async search(query) {
      const results = await chrome.downloads.search(query);
      return results.map((entry) => ({
        id: entry.id,
        state: entry.state,
        bytesReceived: entry.bytesReceived,
        totalBytes: entry.totalBytes,
        error: entry.error,
      }));
    },
  };
}

const SESSION_STORAGE_KEY = 'unipd_download_queue_v2';

export function createSessionQueueStorageAdapter(): QueueStorageAdapter {
  return {
    async load() {
      if (!chrome.storage?.session) {
        return [];
      }
      const result = await chrome.storage.session.get(SESSION_STORAGE_KEY);
      const raw = result[SESSION_STORAGE_KEY];
      if (!Array.isArray(raw)) {
        return [];
      }
      return raw.filter(
        (entry): entry is PersistedDownloadEntry =>
          Boolean(entry) &&
          typeof entry === 'object' &&
          'item' in entry &&
          Boolean((entry as PersistedDownloadEntry).item),
      );
    },
    async save(entries) {
      if (!chrome.storage?.session) {
        return;
      }
      await chrome.storage.session.set({ [SESSION_STORAGE_KEY]: entries });
    },
  };
}

export interface DownloadManagerOptions {
  api?: DownloadsApiAdapter;
  storage?: QueueStorageAdapter;
  maxConcurrent?: number;
  resolveDownloadUrl: DownloadUrlResolver;
  allowedOrigins?: ReadonlySet<string>;
  onStateChange?: (state: DownloadQueueState) => void;
  onDownloadCompleted?: (
    descriptor: DownloadResolutionDescriptor,
    item: DownloadQueueItem,
  ) => void | Promise<void>;
}

function makeDedupeKey(cmid: number, kind: DownloadKind, filename: string): string {
  return `${cmid}\0${kind}\0${filename}`;
}

function cloneDescriptor(
  descriptor: DownloadResolutionDescriptor | null | undefined,
): DownloadResolutionDescriptor | null {
  if (!descriptor) {
    return null;
  }
  if (descriptor.kind === 'material') {
    return {
      ...descriptor,
      material: { ...descriptor.material },
      ...(descriptor.pathContext ? { pathContext: { ...descriptor.pathContext } } : {}),
    };
  }
  return {
    ...descriptor,
    activity: { ...descriptor.activity },
  };
}

function sanitizeResolvedRelativePath(rawPath: string): string {
  const parts = rawPath
    .replace(/\\/g, '/')
    .split('/')
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && p !== '.' && p !== '..');

  if (parts.length === 0) {
    return 'UniPD/material.bin';
  }

  const last = parts.pop()!;
  const cleanDirs = parts.map((dir) => sanitizePathSegment(dir, 105));

  const dotIdx = last.lastIndexOf('.');
  const rawStem = dotIdx > 0 ? last.slice(0, dotIdx) : last;
  const rawExt =
    dotIdx > 0 && dotIdx < last.length - 1
      ? last
          .slice(dotIdx + 1)
          .replace(/[^a-zA-Z0-9]/g, '')
          .toLowerCase()
      : 'bin';
  const ext = rawExt || 'bin';
  let cleanStem = sanitizePathSegment(rawStem, 90);

  const assemble = () => [...cleanDirs, `${cleanStem}.${ext}`].join('/');
  let full = assemble();
  if (full.length > MAX_RELATIVE_DOWNLOAD_PATH_LENGTH) {
    const excess = full.length - MAX_RELATIVE_DOWNLOAD_PATH_LENGTH;
    const targetStemLen = Math.max(4, cleanStem.length - excess);
    cleanStem = sanitizePathSegment(cleanStem.slice(0, targetStemLen), targetStemLen);
    full = assemble();
  }
  while (full.length > MAX_RELATIVE_DOWNLOAD_PATH_LENGTH && cleanDirs.length > 1) {
    cleanDirs.splice(Math.floor(cleanDirs.length / 2), 1);
    full = assemble();
  }
  if (full.length > MAX_RELATIVE_DOWNLOAD_PATH_LENGTH) {
    const maxFileLen = Math.max(6, MAX_RELATIVE_DOWNLOAD_PATH_LENGTH - ext.length - 1);
    cleanStem = sanitizePathSegment(cleanStem.slice(0, maxFileLen), maxFileLen);
    full = `${cleanStem}.${ext}`.slice(0, MAX_RELATIVE_DOWNLOAD_PATH_LENGTH);
  }
  return full;
}

/**
 * Bounded Chrome downloads queue enforcing at most `maxConcurrent` (default `2`)
 * simultaneous `chrome.downloads.download()` tasks across `.mp4` and `.vtt` items.
 *
 * Queued items persist secret-free resolution descriptors in `chrome.storage.session`
 * and lazily resolve fresh signed URLs right before dequeue so long batches survive
 * MV3 30-second service worker dormancy and 1-hour Kaltura `ks` expiration.
 */
export class DownloadManager {
  private readonly api: DownloadsApiAdapter;
  private readonly storage?: QueueStorageAdapter;
  private readonly maxConcurrent: number;
  private readonly resolveDownloadUrl: DownloadUrlResolver;
  private readonly allowedOrigins: ReadonlySet<string>;
  private readonly onStateChange?: (state: DownloadQueueState) => void;
  private readonly onDownloadCompleted?: (
    descriptor: DownloadResolutionDescriptor,
    item: DownloadQueueItem,
  ) => void | Promise<void>;

  private readonly entries: InternalDownloadEntry[] = [];
  private readonly downloadIdToTaskId = new Map<number, string>();
  private nextSequence = 1;
  private hydratePromise: Promise<void> | null = null;
  private pumping = false;
  private pumpAgain = false;

  constructor(options: DownloadManagerOptions) {
    this.api = options.api ?? createChromeDownloadsAdapter();
    this.storage = options.storage;
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_DOWNLOADS);
    this.resolveDownloadUrl = options.resolveDownloadUrl;
    this.allowedOrigins = options.allowedOrigins ?? ALLOWED_MEDIA_ORIGINS;
    this.onStateChange = options.onStateChange;
    this.onDownloadCompleted = options.onDownloadCompleted;
  }

  async hydrate(): Promise<void> {
    if (!this.hydratePromise) {
      this.hydratePromise = (async () => {
        try {
          await this.performHydrate();
        } catch (err) {
          this.hydratePromise = null;
          throw err;
        }
      })();
    }
    await this.hydratePromise;
  }

  private async performHydrate(): Promise<void> {
    if (!this.storage) {
      return;
    }

    const saved = await this.storage.load();
    let reconciledOnHydrate = false;

    for (const savedEntry of saved) {
      const item: DownloadQueueItem = { ...savedEntry.item };
      let descriptor = cloneDescriptor(savedEntry.descriptor);

      if (item.status === 'in_progress' && item.downloadId === null) {
        // Reconcile orphaned `in_progress` items whose SW terminated before `downloadId` was stored.
        if (descriptor) {
          item.status = 'queued';
          item.error = null;
          item.bytesReceived = 0;
          item.canRetry = false;
        } else {
          item.status = 'failed';
          item.error = 'Interrupted before download started; please re-enqueue.';
          item.canRetry = false;
        }
        reconciledOnHydrate = true;
      } else if (item.status === 'queued' && !descriptor) {
        item.status = 'failed';
        item.error = 'Download metadata missing; please re-enqueue.';
        item.canRetry = false;
        reconciledOnHydrate = true;
      } else if (item.status === 'completed') {
        descriptor = null;
        item.canRetry = false;
      } else if (item.status === 'failed' || item.status === 'cancelled') {
        item.canRetry = Boolean(descriptor);
      } else {
        item.canRetry = false;
      }

      this.entries.push({ item, descriptor, cancelRequested: false });
      if (item.downloadId !== null) {
        this.downloadIdToTaskId.set(item.downloadId, item.id);
      }
    }

    const anyActiveChanged = await this.reconcileActiveDownloadsInternal();
    if (reconciledOnHydrate || anyActiveChanged) {
      await this.emitAndPersist();
    }

    const hasQueued = this.entries.some((e) => e.item.status === 'queued');
    const activeCount = this.entries.filter((e) => e.item.status === 'in_progress').length;
    if (hasQueued && activeCount < this.maxConcurrent) {
      await this.pumpQueue();
    }
  }

  getState(): DownloadQueueState {
    const items = this.entries.map((entry) => ({
      ...entry.item,
      canRetry:
        (entry.item.status === 'failed' || entry.item.status === 'cancelled') &&
        Boolean(entry.descriptor),
    }));
    const activeCount = items.filter((item) => item.status === 'in_progress').length;
    const queuedCount = items.filter((item) => item.status === 'queued').length;

    return {
      maxConcurrent: this.maxConcurrent,
      activeCount,
      queuedCount,
      items,
    };
  }

  async enqueue(requests: EnqueueDownloadItem[]): Promise<string[]> {
    await this.hydrate();
    const createdIds: string[] = [];

    const activeKeys = new Set<string>();
    for (const existing of this.entries) {
      if (existing.item.status === 'queued' || existing.item.status === 'in_progress') {
        activeKeys.add(
          makeDedupeKey(existing.item.cmid, existing.item.kind, existing.item.filename),
        );
        if (existing.descriptor?.filename && existing.descriptor.filename !== existing.item.filename) {
          activeKeys.add(
            makeDedupeKey(existing.item.cmid, existing.item.kind, existing.descriptor.filename),
          );
        }
      }
    }

    for (const req of requests) {
      const dedupeKey = makeDedupeKey(req.cmid, req.kind, req.filename);
      if (activeKeys.has(dedupeKey)) {
        continue;
      }
      activeKeys.add(dedupeKey);

      const id = `dl-${Date.now()}-${this.nextSequence++}`;
      const item: DownloadQueueItem = {
        id,
        cmid: req.cmid,
        courseId: req.courseId,
        lectureTitle: req.lectureTitle,
        filename: req.filename,
        kind: req.kind,
        status: 'queued',
        downloadId: null,
        bytesReceived: 0,
        totalBytes: req.sizeBytes && req.sizeBytes > 0 ? req.sizeBytes : 0,
        error: null,
        createdAt: Date.now(),
        canRetry: false,
      };

      this.entries.push({
        item,
        descriptor: cloneDescriptor(req.descriptor),
        cancelRequested: false,
      });
      createdIds.push(id);
    }

    if (createdIds.length > 0) {
      await this.emitAndPersist();
      await this.pumpQueue();
    }
    return createdIds;
  }

  async handleDownloadDelta(delta: ChromeDownloadDeltaLike): Promise<void> {
    await this.hydrate();
    const taskId = this.downloadIdToTaskId.get(delta.id);
    if (!taskId) {
      return;
    }

    const entry = this.entries.find((e) => e.item.id === taskId);
    if (!entry || entry.item.status !== 'in_progress') {
      return;
    }

    let changed = false;

    if (delta.state?.current === 'complete') {
      await this.syncSingleDownloadBytes(entry);
      if ((entry.item.status as string) !== 'completed') {
        await this.completeEntry(entry);
      }
      changed = true;
    } else if (delta.state?.current === 'interrupted') {
      const reason = delta.error?.current ?? 'INTERRUPTED';
      if (reason === 'USER_CANCELED') {
        entry.item.status = 'cancelled';
        entry.item.error = CANCELLED_BY_USER_MESSAGE;
      } else {
        entry.item.status = 'failed';
        entry.item.error = sanitizeErrorMessage(reason);
      }
      entry.item.canRetry = Boolean(entry.descriptor);
      await this.syncSingleDownloadBytes(entry);
      changed = true;
    }

    if (changed) {
      await this.emitAndPersist();
      await this.pumpQueue();
    }
  }

  async refreshActiveProgress(): Promise<DownloadQueueState> {
    await this.hydrate();
    await this.reconcileActiveDownloads();
    return this.getState();
  }

  async cancel(taskId: string): Promise<DownloadQueueState> {
    await this.hydrate();
    const entry = this.entries.find((e) => e.item.id === taskId);
    if (!entry) {
      return this.getState();
    }

    if (entry.item.status === 'queued') {
      entry.cancelRequested = true;
      entry.item.status = 'cancelled';
      entry.item.error = CANCELLED_BY_USER_MESSAGE;
      entry.item.canRetry = Boolean(entry.descriptor);
      await this.emitAndPersist();
      return this.getState();
    }

    if (entry.item.status === 'in_progress') {
      entry.cancelRequested = true;
      const existingDownloadId = entry.item.downloadId;
      entry.item.status = 'cancelled';
      entry.item.error = CANCELLED_BY_USER_MESSAGE;
      entry.item.canRetry = Boolean(entry.descriptor);

      if (existingDownloadId !== null) {
        try {
          await this.api.cancel(existingDownloadId);
        } catch {
          // Ignore if Chrome already finished or interrupted the download
        }
      }

      await this.emitAndPersist();
      await this.pumpQueue();
    }

    return this.getState();
  }

  async retry(taskId: string): Promise<DownloadQueueState> {
    await this.hydrate();
    const entry = this.entries.find((e) => e.item.id === taskId);
    if (!entry) {
      return this.getState();
    }
    if (entry.item.status !== 'failed' && entry.item.status !== 'cancelled') {
      return this.getState();
    }
    if (!entry.descriptor) {
      throw new Error('Cannot retry download because resolution metadata is missing.');
    }

    const targetKeys = new Set<string>([
      makeDedupeKey(entry.item.cmid, entry.item.kind, entry.item.filename),
      makeDedupeKey(entry.item.cmid, entry.item.kind, entry.descriptor.filename),
    ]);
    const hasActiveDuplicate = this.entries.some(
      (other) =>
        other !== entry &&
        (other.item.status === 'queued' || other.item.status === 'in_progress') &&
        (targetKeys.has(makeDedupeKey(other.item.cmid, other.item.kind, other.item.filename)) ||
          (other.descriptor?.filename &&
            targetKeys.has(
              makeDedupeKey(other.item.cmid, other.item.kind, other.descriptor.filename),
            ))),
    );
    if (hasActiveDuplicate) {
      throw new Error('This file is already queued or downloading.');
    }

    if (entry.item.downloadId !== null) {
      this.downloadIdToTaskId.delete(entry.item.downloadId);
      entry.item.downloadId = null;
    }

    entry.cancelRequested = false;
    entry.item.status = 'queued';
    entry.item.bytesReceived = 0;
    entry.item.error = null;
    entry.item.canRetry = false;

    await this.emitAndPersist();
    await this.pumpQueue();
    return this.getState();
  }

  async clearFinished(): Promise<DownloadQueueState> {
    await this.hydrate();
    for (let i = this.entries.length - 1; i >= 0; i -= 1) {
      const entry = this.entries[i];
      if (!entry) {
        continue;
      }
      if (
        entry.item.status === 'completed' ||
        entry.item.status === 'failed' ||
        entry.item.status === 'cancelled'
      ) {
        if (entry.item.downloadId !== null) {
          this.downloadIdToTaskId.delete(entry.item.downloadId);
        }
        this.entries.splice(i, 1);
      }
    }

    await this.emitAndPersist();
    return this.getState();
  }

  private async pumpQueue(): Promise<void> {
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;

    try {
      do {
        this.pumpAgain = false;
        await this.drainAvailableSlots();
      } while (this.pumpAgain);
    } finally {
      this.pumping = false;
    }
  }

  private isEntryCancelled(entry: InternalDownloadEntry): boolean {
    return entry.cancelRequested || entry.item.status === 'cancelled';
  }

  private async drainAvailableSlots(): Promise<void> {
    while (true) {
      const activeCount = this.entries.filter((e) => e.item.status === 'in_progress').length;
      if (activeCount >= this.maxConcurrent) {
        break;
      }

      const nextEntry = this.entries.find((e) => e.item.status === 'queued');
      if (!nextEntry) {
        break;
      }

      const descriptor = nextEntry.descriptor;
      if (!descriptor) {
        nextEntry.item.status = 'failed';
        nextEntry.item.error = 'Download metadata missing; please re-enqueue.';
        nextEntry.item.canRetry = false;
        await this.emitAndPersist();
        continue;
      }

      // Transition synchronously before awaiting lazy URL resolution and
      // `chrome.downloads.download()` so concurrent callers never exceed `maxConcurrent`.
      nextEntry.item.status = 'in_progress';
      nextEntry.item.error = null;
      nextEntry.item.canRetry = false;
      nextEntry.cancelRequested = false;
      await this.emitAndPersist();
      if (this.isEntryCancelled(nextEntry)) {
        continue;
      }

      try {
        const resolved = await this.resolveDownloadUrl(descriptor);
        if (this.isEntryCancelled(nextEntry)) {
          continue;
        }

        const rawUrl = typeof resolved === 'string' ? resolved : resolved.url;
        if (typeof resolved !== 'string') {
          if (resolved.resolvedFilename) {
            nextEntry.item.filename = sanitizeResolvedRelativePath(resolved.resolvedFilename);
          }
          if (
            typeof resolved.resolvedSizeBytes === 'number' &&
            resolved.resolvedSizeBytes > 0 &&
            nextEntry.item.totalBytes === 0
          ) {
            nextEntry.item.totalBytes = resolved.resolvedSizeBytes;
          }
        }

        const safeUrl = validateAllowedMediaUrl(rawUrl, this.allowedOrigins);
        const downloadId = await this.api.download({
          url: safeUrl,
          filename: nextEntry.item.filename,
          conflictAction: 'uniquify',
          saveAs: false,
        });

        if (this.isEntryCancelled(nextEntry)) {
          try {
            await this.api.cancel(downloadId);
          } catch {
            // Ignore if Chrome already finished or interrupted the download
          }
          continue;
        }

        nextEntry.item.downloadId = downloadId;
        this.downloadIdToTaskId.set(downloadId, nextEntry.item.id);
        // Immediately sync in case a fast download (e.g. small .vtt) already finished
        // before `chrome.downloads.download()` resolved and before `downloadIdToTaskId` was set.
        await this.syncSingleDownloadBytes(nextEntry);
        await this.emitAndPersist();
      } catch (err) {
        if (this.isEntryCancelled(nextEntry)) {
          continue;
        }
        nextEntry.item.status = 'failed';
        nextEntry.item.error = sanitizeErrorMessage(err);
        nextEntry.item.canRetry = Boolean(nextEntry.descriptor);
        await this.emitAndPersist();
      }
    }
  }

  private async reconcileActiveDownloadsInternal(): Promise<boolean> {
    let anyChanged = false;
    for (const entry of this.entries) {
      if (entry.item.status !== 'in_progress' || entry.item.downloadId === null) {
        continue;
      }
      const changed = await this.syncSingleDownloadBytes(entry);
      if (changed) {
        anyChanged = true;
      }
    }
    return anyChanged;
  }

  private async reconcileActiveDownloads(): Promise<void> {
    const anyChanged = await this.reconcileActiveDownloadsInternal();
    if (anyChanged) {
      await this.emitAndPersist();
      await this.pumpQueue();
    }
  }

  private async completeEntry(entry: InternalDownloadEntry): Promise<void> {
    const alreadyCompleted = entry.item.status === 'completed';
    const completedDescriptor = cloneDescriptor(entry.descriptor);

    entry.item.status = 'completed';
    if (entry.item.totalBytes > 0) {
      entry.item.bytesReceived = entry.item.totalBytes;
    } else if (entry.item.bytesReceived > 0) {
      entry.item.totalBytes = entry.item.bytesReceived;
    }
    entry.item.error = null;
    entry.item.canRetry = false;
    entry.descriptor = null;

    if (!alreadyCompleted && completedDescriptor && this.onDownloadCompleted) {
      try {
        await this.onDownloadCompleted(completedDescriptor, { ...entry.item });
      } catch {
        // Non-fatal if completion callback / history write fails
      }
    }
  }

  private async syncSingleDownloadBytes(entry: InternalDownloadEntry): Promise<boolean> {
    const item = entry.item;
    if (item.downloadId === null) {
      return false;
    }
    try {
      const results = await this.api.search({ id: item.downloadId });
      const info = results[0];
      if (!info) {
        if (item.status === 'in_progress') {
          item.status = 'failed';
          item.error = VANISHED_DOWNLOAD_MESSAGE;
          item.canRetry = Boolean(entry.descriptor);
          return true;
        }
        return false;
      }

      let changed = false;
      if (typeof info.bytesReceived === 'number' && info.bytesReceived !== item.bytesReceived) {
        item.bytesReceived = info.bytesReceived;
        changed = true;
      }
      if (
        typeof info.totalBytes === 'number' &&
        info.totalBytes > 0 &&
        info.totalBytes !== item.totalBytes
      ) {
        item.totalBytes = info.totalBytes;
        changed = true;
      }
      if (info.state === 'complete' && item.status !== 'completed') {
        await this.completeEntry(entry);
        changed = true;
      } else if (info.state === 'interrupted' && item.status === 'in_progress') {
        if (info.error === 'USER_CANCELED') {
          item.status = 'cancelled';
          item.error = CANCELLED_BY_USER_MESSAGE;
        } else {
          item.status = 'failed';
          item.error = sanitizeErrorMessage(info.error ?? 'Download interrupted');
        }
        item.canRetry = Boolean(entry.descriptor);
        changed = true;
      }
      return changed;
    } catch {
      return false;
    }
  }

  private async emitAndPersist(): Promise<void> {
    const state = this.getState();
    if (this.storage) {
      const persisted: PersistedDownloadEntry[] = this.entries.map((entry) => ({
        item: {
          ...entry.item,
          canRetry:
            (entry.item.status === 'failed' || entry.item.status === 'cancelled') &&
            Boolean(entry.descriptor),
        },
        descriptor:
          entry.item.status !== 'completed' ? cloneDescriptor(entry.descriptor) : null,
      }));
      try {
        await this.storage.save(persisted);
      } catch {
        // Non-fatal if session storage write fails
      }
    }
    this.onStateChange?.(state);
  }
}
