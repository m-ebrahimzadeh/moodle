import { describe, expect, it, vi } from 'vitest';
import {
  CANCELLED_BY_USER_MESSAGE,
  DownloadManager,
  VANISHED_DOWNLOAD_MESSAGE,
  sanitizeErrorMessage,
  type ChromeDownloadItemLike,
  type DownloadsApiAdapter,
  type PersistedDownloadEntry,
  type QueueStorageAdapter,
} from '../src/extension/download-manager.js';
import type {
  DownloadResolutionDescriptor,
  EnqueueDownloadItem,
} from '../src/extension/messages.js';

function makeItem(index: number, kind: 'video' | 'subtitle' = 'video'): EnqueueDownloadItem {
  const ext = kind === 'subtitle' ? 'vtt' : 'mp4';
  const cmid = 300150 + index;
  const filename = `UniPD/2026-2027/PSQ4107809 - Testing/01 - Intro/0${index} - Lecture ${index}.${ext}`;

  const descriptor: DownloadResolutionDescriptor = {
    activity: {
      cmid,
      courseId: 7075,
      sectionIndex: 1,
      sectionTitle: 'Intro',
      activityIndex: index,
      title: `Lecture ${index}`,
      type: 'kalvidres',
      url: `https://psico.elearning.unipd.it/mod/kalvidres/view.php?id=${cmid}`,
    },
    kind,
    filename,
    preferredFlavorId: kind === 'video' ? '1_c1qlwlrw' : null,
    preferredHeight: kind === 'video' ? 1080 : null,
    captionLanguageCode: kind === 'subtitle' ? 'en' : null,
    captionLabel: kind === 'subtitle' ? 'English' : null,
    captionIndex: kind === 'subtitle' ? 0 : null,
  };

  return {
    cmid,
    courseId: 7075,
    lectureTitle: `Lecture ${index}`,
    filename,
    kind,
    sizeBytes: kind === 'video' ? 100_000_000 : 25_000,
    descriptor,
  };
}

function createDefaultResolver() {
  let tokenSeq = 1;
  return vi.fn(async (descriptor: DownloadResolutionDescriptor): Promise<string> => {
    const seq = tokenSeq++;
    if (descriptor.kind === 'material') {
      return `https://psico.elearning.unipd.it/pluginfile.php/555/mod_resource/content/${seq}/${descriptor.material.cmid}.pdf`;
    }
    if (descriptor.kind === 'subtitle') {
      return `https://cdnsecakmi.kaltura.com/api_v3/captions/${descriptor.activity.cmid}/en.vtt?ks=SECRET_KS_VTT_${seq}`;
    }
    return `https://cdnapisec.kaltura.com/p/2203921/sp/220392100/playManifest/entryId/1_test${descriptor.activity.cmid}/flavorId/${descriptor.preferredFlavorId ?? '1_flv'}/format/url/protocol/https/a.mp4?ks=SECRET_KS_${seq}`;
  });
}

function createInMemoryChromeDownloads(startId: number = 100) {
  let nextDownloadId = startId;
  const records = new Map<number, ChromeDownloadItemLike>();

  const downloadSpy = vi.fn<DownloadsApiAdapter['download']>(async () => {
    const id = nextDownloadId++;
    records.set(id, {
      id,
      state: 'in_progress',
      bytesReceived: 1024,
      totalBytes: 100_000_000,
    });
    return id;
  });

  const cancelSpy = vi.fn<DownloadsApiAdapter['cancel']>(async (id) => {
    const rec = records.get(id);
    if (rec) {
      rec.state = 'interrupted';
      rec.error = 'USER_CANCELED';
    }
  });

  const searchSpy = vi.fn<DownloadsApiAdapter['search']>(async ({ id }) => {
    const rec = records.get(id);
    return rec ? [{ ...rec }] : [];
  });

  return {
    records,
    api: {
      download: downloadSpy,
      cancel: cancelSpy,
      search: searchSpy,
    } satisfies DownloadsApiAdapter,
    downloadSpy,
    cancelSpy,
    searchSpy,
  };
}

describe('download-manager', () => {
  it('enforces max 2 concurrent downloads, promotes FIFO, and persists only secret-free descriptors', async () => {
    const chromeMock = createInMemoryChromeDownloads(100);
    const resolveSpy = createDefaultResolver();

    const savedSnapshots: PersistedDownloadEntry[][] = [];
    const storage: QueueStorageAdapter = {
      load: async () => [],
      save: async (entries) => {
        savedSnapshots.push(entries);
      },
    };

    const manager = new DownloadManager({
      api: chromeMock.api,
      storage,
      maxConcurrent: 2,
      resolveDownloadUrl: resolveSpy,
    });

    await manager.enqueue([
      makeItem(1, 'video'),
      makeItem(2, 'subtitle'),
      makeItem(3, 'video'),
      makeItem(4, 'video'),
    ]);

    // Only 2 downloads may start immediately; 2 stay queued (and are NOT resolved yet!)
    expect(chromeMock.downloadSpy).toHaveBeenCalledTimes(2);
    expect(resolveSpy).toHaveBeenCalledTimes(2);

    let state = manager.getState();
    expect(state.activeCount).toBe(2);
    expect(state.queuedCount).toBe(2);
    expect(state.items.map((i) => i.status)).toEqual([
      'in_progress',
      'in_progress',
      'queued',
      'queued',
    ]);

    // Ensure no signed URL, ks token, or playManifest ever leaked into persisted storage
    const serializedStorage = JSON.stringify(savedSnapshots);
    expect(serializedStorage).not.toContain('SECRET_KS_');
    expect(serializedStorage).not.toContain('playManifest');
    expect(serializedStorage).not.toContain('sesskey');

    // Complete first download (id=100) -> lazily resolves & promotes item 3 immediately
    chromeMock.records.set(100, {
      id: 100,
      state: 'complete',
      bytesReceived: 100_000_000,
      totalBytes: 100_000_000,
    });
    await manager.handleDownloadDelta({ id: 100, state: { current: 'complete' } });
    expect(chromeMock.downloadSpy).toHaveBeenCalledTimes(3);
    expect(resolveSpy).toHaveBeenCalledTimes(3);
    state = manager.getState();
    expect(state.activeCount).toBe(2);
    expect(state.queuedCount).toBe(1);
    expect(state.items[0]?.status).toBe('completed');
    expect(state.items[2]?.status).toBe('in_progress');

    // Fail second download (id=101) -> lazily resolves & promotes item 4 immediately
    chromeMock.records.set(101, {
      id: 101,
      state: 'interrupted',
      error: 'NETWORK_FAILED',
      bytesReceived: 1000,
      totalBytes: 25_000,
    });
    await manager.handleDownloadDelta({
      id: 101,
      state: { current: 'interrupted' },
      error: { current: 'NETWORK_FAILED' },
    });
    expect(chromeMock.downloadSpy).toHaveBeenCalledTimes(4);
    state = manager.getState();
    expect(state.activeCount).toBe(2);
    expect(state.queuedCount).toBe(0);
    expect(state.items[1]?.status).toBe('failed');
    expect(state.items[3]?.status).toBe('in_progress');
  });

  it('prevents hydrate() re-entrancy race across concurrent cold-wake callers and resets only on failure [ARCH-002 / QA-001]', async () => {
    const chromeMock = createInMemoryChromeDownloads(200);
    chromeMock.records.set(200, {
      id: 200,
      state: 'in_progress',
      bytesReceived: 5000,
      totalBytes: 100_000_000,
    });
    chromeMock.records.set(201, {
      id: 201,
      state: 'in_progress',
      bytesReceived: 5000,
      totalBytes: 100_000_000,
    });

    const item1 = makeItem(1);
    const item2 = makeItem(2);
    const item3 = makeItem(3);
    const persisted: PersistedDownloadEntry[] = [
      {
        item: {
          id: 'dl-1',
          cmid: item1.cmid,
          courseId: 7075,
          lectureTitle: item1.lectureTitle,
          filename: item1.filename,
          kind: 'video',
          status: 'in_progress',
          downloadId: 200,
          bytesReceived: 5000,
          totalBytes: 100_000_000,
          error: null,
          createdAt: 1,
        },
        descriptor: item1.descriptor,
      },
      {
        item: {
          id: 'dl-2',
          cmid: item2.cmid,
          courseId: 7075,
          lectureTitle: item2.lectureTitle,
          filename: item2.filename,
          kind: 'video',
          status: 'in_progress',
          downloadId: 201,
          bytesReceived: 5000,
          totalBytes: 100_000_000,
          error: null,
          createdAt: 2,
        },
        descriptor: item2.descriptor,
      },
    ];

    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const loadSpy = vi.fn(async () => {
      await loadGate;
      return persisted;
    });

    const manager = new DownloadManager({
      api: chromeMock.api,
      storage: { load: loadSpy, save: vi.fn(async () => {}) },
      maxConcurrent: 2,
      resolveDownloadUrl: createDefaultResolver(),
    });

    // Fire 3 concurrent cold-start callers while storage.load() is still pending
    const pDelta = manager.handleDownloadDelta({ id: 200, state: { current: 'complete' } });
    const pEnqueue = manager.enqueue([item3]);
    const pRefresh = manager.refreshActiveProgress();

    // Update record 200 to complete before releasing load so delta & refresh both see completion
    chromeMock.records.set(200, {
      id: 200,
      state: 'complete',
      bytesReceived: 100_000_000,
      totalBytes: 100_000_000,
    });
    releaseLoad();

    await Promise.all([pDelta, pEnqueue, pRefresh]);

    // storage.load() was called only ONCE despite 3 concurrent cold-start callers
    expect(loadSpy).toHaveBeenCalledTimes(1);

    const state = manager.getState();
    expect(state.items).toHaveLength(3);
    expect(state.items.find((i) => i.id === 'dl-1')?.status).toBe('completed');
    expect(state.items.find((i) => i.id === 'dl-2')?.status).toBe('in_progress');
    expect(state.items.find((i) => i.cmid === item3.cmid)?.status).toBe('in_progress');
    // Concurrency limit of 2 was never exceeded
    expect(state.activeCount).toBe(2);

    // Verify hydratePromise resets on failure and succeeds on retry
    let failFirst = true;
    const flakyLoad = vi.fn(async (): Promise<PersistedDownloadEntry[]> => {
      if (failFirst) {
        failFirst = false;
        throw new Error('Transient storage failure');
      }
      return [];
    });
    const flakyManager = new DownloadManager({
      api: chromeMock.api,
      storage: { load: flakyLoad, save: vi.fn(async () => {}) },
      resolveDownloadUrl: createDefaultResolver(),
    });

    await expect(flakyManager.hydrate()).rejects.toThrow('Transient storage failure');
    await expect(flakyManager.hydrate()).resolves.toBeUndefined();
    expect(flakyLoad).toHaveBeenCalledTimes(2);
  });

  it('survives simulated MV3 SW restart by lazily re-resolving persisted queued descriptors [ARCH-001 / QA-002]', async () => {
    const chromeMock = createInMemoryChromeDownloads(300);
    let persistedEntries: PersistedDownloadEntry[] = [];

    const sharedStorage: QueueStorageAdapter = {
      load: async () => structuredClone(persistedEntries),
      save: async (entries) => {
        persistedEntries = structuredClone(entries);
      },
    };

    const sw1Resolver = createDefaultResolver();
    const swInstance1 = new DownloadManager({
      api: chromeMock.api,
      storage: sharedStorage,
      maxConcurrent: 2,
      resolveDownloadUrl: sw1Resolver,
    });

    // Enqueue 3 lectures in SW lifecycle #1 -> 2 start, 1 stays queued in storage
    await swInstance1.enqueue([makeItem(1), makeItem(2), makeItem(3)]);
    expect(sw1Resolver).toHaveBeenCalledTimes(2);
    expect(swInstance1.getState().queuedCount).toBe(1);

    // Verify persisted storage has zero ks/signed URLs even though item 3 is queued
    expect(JSON.stringify(persistedEntries)).not.toContain('SECRET_KS_');

    // Simulate MV3 SW termination (~30s dormancy) and brand-new SW instance waking up
    // when download 300 completes (>1h later, fresh ks minted lazily)
    const sw2Resolver = vi.fn(async (descriptor: DownloadResolutionDescriptor) => {
      const cmid = descriptor.kind === 'material' ? descriptor.material.cmid : descriptor.activity.cmid;
      return `https://cdnapisec.kaltura.com/p/2203921/sp/220392100/playManifest/entryId/1_fresh_${cmid}/flavorId/1_c1qlwlrw/format/url/protocol/https/a.mp4?ks=FRESH_KS_AFTER_SW_RESTART`;
    });

    const swInstance2 = new DownloadManager({
      api: chromeMock.api,
      storage: sharedStorage,
      maxConcurrent: 2,
      resolveDownloadUrl: sw2Resolver,
    });

    chromeMock.records.set(300, {
      id: 300,
      state: 'complete',
      bytesReceived: 100_000_000,
      totalBytes: 100_000_000,
    });

    await swInstance2.handleDownloadDelta({ id: 300, state: { current: 'complete' } });

    // Item 3 survived SW restart and received a freshly minted ks URL on dequeue!
    expect(sw2Resolver).toHaveBeenCalledTimes(1);
    expect(chromeMock.downloadSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        url: expect.stringContaining('ks=FRESH_KS_AFTER_SW_RESTART'),
      }),
    );

    const state2 = swInstance2.getState();
    expect(state2.items[0]?.status).toBe('completed');
    expect(state2.items[1]?.status).toBe('in_progress');
    expect(state2.items[2]?.status).toBe('in_progress');
    expect(state2.queuedCount).toBe(0);
    expect(state2.activeCount).toBe(2);
  });

  it('recovers concurrency slot when Chrome download record vanishes and reconciles orphaned in_progress on hydrate [QA-003 / ARCH-003]', async () => {
    const chromeMock = createInMemoryChromeDownloads(400);
    const manager = new DownloadManager({
      api: chromeMock.api,
      maxConcurrent: 2,
      resolveDownloadUrl: createDefaultResolver(),
    });

    await manager.enqueue([makeItem(1), makeItem(2), makeItem(3)]);
    expect(manager.getState().activeCount).toBe(2);
    expect(manager.getState().queuedCount).toBe(1);

    // Simulate download 400 erased from Chrome history (`search` returns `[]`)
    chromeMock.records.delete(400);

    const refreshed = await manager.refreshActiveProgress();
    expect(refreshed.items[0]?.status).toBe('failed');
    expect(refreshed.items[0]?.error).toBe(VANISHED_DOWNLOAD_MESSAGE);
    // Slot was immediately recovered and item 3 was promoted!
    expect(refreshed.items[2]?.status).toBe('in_progress');
    expect(refreshed.activeCount).toBe(2);
    expect(refreshed.queuedCount).toBe(0);

    // Verify orphaned `in_progress` entries with `downloadId: null` on hydrate()
    const itemA = makeItem(10);
    const orphanStorage: QueueStorageAdapter = {
      load: async () => [
        {
          item: {
            id: 'orphan-with-desc',
            cmid: itemA.cmid,
            courseId: 7075,
            lectureTitle: itemA.lectureTitle,
            filename: itemA.filename,
            kind: 'video',
            status: 'in_progress',
            downloadId: null,
            bytesReceived: 0,
            totalBytes: 100_000,
            error: null,
            createdAt: 1,
          },
          descriptor: itemA.descriptor,
        },
        {
          item: {
            id: 'orphan-no-desc',
            cmid: 999999,
            courseId: 7075,
            lectureTitle: 'Missing Desc',
            filename: 'UniPD/x.mp4',
            kind: 'video',
            status: 'in_progress',
            downloadId: null,
            bytesReceived: 0,
            totalBytes: 0,
            error: null,
            createdAt: 2,
          },
          descriptor: null,
        },
      ],
      save: vi.fn(async () => {}),
    };

    const orphanManager = new DownloadManager({
      api: chromeMock.api,
      storage: orphanStorage,
      maxConcurrent: 2,
      resolveDownloadUrl: createDefaultResolver(),
    });

    const orphanState = await orphanManager.refreshActiveProgress();
    // Orphan with descriptor was re-queued and immediately pumped to in_progress with a real downloadId
    const recovered = orphanState.items.find((i) => i.id === 'orphan-with-desc');
    expect(recovered?.status).toBe('in_progress');
    expect(recovered?.downloadId).not.toBeNull();
    // Orphan without descriptor transitioned cleanly to failed
    const failed = orphanState.items.find((i) => i.id === 'orphan-no-desc');
    expect(failed?.status).toBe('failed');
  });

  it('syncs fast-completing downloads immediately after download() resolves and promotes next queued item [QA-003 / ARCH-003]', async () => {
    let nextId = 500;
    const downloadSpy = vi.fn<DownloadsApiAdapter['download']>(async () => nextId++);
    // First download (500, fast .vtt) is ALREADY complete before download() returns!
    const searchSpy = vi.fn<DownloadsApiAdapter['search']>(async ({ id }) => {
      if (id === 500) {
        return [{ id, state: 'complete', bytesReceived: 1200, totalBytes: 1200 }];
      }
      return [{ id, state: 'in_progress', bytesReceived: 100, totalBytes: 100_000 }];
    });

    const manager = new DownloadManager({
      api: {
        download: downloadSpy,
        cancel: vi.fn(async () => {}),
        search: searchSpy,
      },
      maxConcurrent: 1,
      resolveDownloadUrl: createDefaultResolver(),
    });

    await manager.enqueue([makeItem(1, 'subtitle'), makeItem(2, 'video')]);

    // Because fast .vtt (id=500) was already complete on immediate sync, item 2 started immediately!
    expect(downloadSpy).toHaveBeenCalledTimes(2);
    const state = manager.getState();
    expect(state.items[0]?.status).toBe('completed');
    expect(state.items[0]?.bytesReceived).toBe(1200);
    expect(state.items[1]?.status).toBe('in_progress');
  });

  it('cancels in_progress items while downloadId is still null and unifies cancellation error text [QA-003 / ARCH-003]', async () => {
    let resolveDownloadId!: (id: number) => void;
    const pendingDownload = new Promise<number>((resolve) => {
      resolveDownloadId = resolve;
    });
    const cancelSpy = vi.fn<DownloadsApiAdapter['cancel']>(async () => {});

    const manager = new DownloadManager({
      api: {
        download: vi.fn(() => pendingDownload),
        cancel: cancelSpy,
        search: vi.fn(async ({ id }) => [
          { id, state: 'interrupted', error: 'USER_CANCELED', bytesReceived: 0, totalBytes: 100 },
        ]),
      },
      maxConcurrent: 2,
      resolveDownloadUrl: createDefaultResolver(),
    });

    const enqueuePromise = manager.enqueue([makeItem(1)]);
    // Yield so pumpQueue reaches `await this.api.download(...)` with downloadId === null
    await new Promise((r) => setTimeout(r, 10));

    const preCancel = manager.getState();
    expect(preCancel.items[0]?.status).toBe('in_progress');
    expect(preCancel.items[0]?.downloadId).toBeNull();

    const taskId = preCancel.items[0]!.id;
    const cancelledState = await manager.cancel(taskId);
    expect(cancelledState.items[0]?.status).toBe('cancelled');
    expect(cancelledState.items[0]?.error).toBe(CANCELLED_BY_USER_MESSAGE);

    // Now resolve pending Chrome download() -> DownloadManager must cancel the orphaned Chrome downloadId
    resolveDownloadId(777);
    await enqueuePromise;
    expect(cancelSpy).toHaveBeenCalledWith(777);
    expect(manager.getState().items[0]?.status).toBe('cancelled');
    expect(manager.getState().items[0]?.error).toBe(CANCELLED_BY_USER_MESSAGE);

    // Verify syncSingleDownloadBytes USER_CANCELED also produces unified 'Cancelled by user'
    const chromeMock = createInMemoryChromeDownloads(800);
    const manager2 = new DownloadManager({
      api: chromeMock.api,
      maxConcurrent: 2,
      resolveDownloadUrl: createDefaultResolver(),
    });
    await manager2.enqueue([makeItem(1)]);
    chromeMock.records.set(800, {
      id: 800,
      state: 'interrupted',
      error: 'USER_CANCELED',
      bytesReceived: 10,
      totalBytes: 100,
    });
    const synced = await manager2.refreshActiveProgress();
    expect(synced.items[0]?.status).toBe('cancelled');
    expect(synced.items[0]?.error).toBe(CANCELLED_BY_USER_MESSAGE);
  });

  it('skips resolveDownloadUrl if cancelled while initial in_progress persistence is in-flight [QA-LOW-4]', async () => {
    let releaseSave!: () => void;
    let saveCallCount = 0;
    const resolveSpy = vi.fn(createDefaultResolver());
    const chromeMock = createInMemoryChromeDownloads(850);

    const manager = new DownloadManager({
      api: chromeMock.api,
      maxConcurrent: 1,
      resolveDownloadUrl: resolveSpy,
      storage: {
        load: async () => [],
        save: async () => {
          saveCallCount += 1;
          // 1st save is inside enqueue(); 2nd save is the in_progress transition before resolveDownloadUrl()
          if (saveCallCount === 2) {
            await new Promise<void>((resolve) => {
              releaseSave = resolve;
            });
          }
        },
      },
    });

    const enqueuePromise = manager.enqueue([makeItem(1)]);
    await new Promise((r) => setTimeout(r, 10));

    const taskId = manager.getState().items[0]!.id;
    const cancelPromise = manager.cancel(taskId);
    releaseSave();
    await Promise.all([enqueuePromise, cancelPromise]);

    expect(resolveSpy).not.toHaveBeenCalled();
    expect(chromeMock.downloadSpy).not.toHaveBeenCalled();
    expect(manager.getState().items[0]?.status).toBe('cancelled');
  });

  it('deduplicates active (queued / in_progress) entries by (cmid, kind, filename) while allowing re-enqueue after completion [QA-005]', async () => {
    const chromeMock = createInMemoryChromeDownloads(900);
    const manager = new DownloadManager({
      api: chromeMock.api,
      maxConcurrent: 2,
      resolveDownloadUrl: createDefaultResolver(),
    });

    const dupItem = makeItem(1, 'video');
    const firstBatch = await manager.enqueue([dupItem, dupItem]);
    expect(firstBatch).toHaveLength(1);
    expect(manager.getState().items).toHaveLength(1);

    // Second enqueue while item is still in_progress must be skipped
    const secondBatch = await manager.enqueue([dupItem]);
    expect(secondBatch).toHaveLength(0);
    expect(manager.getState().items).toHaveLength(1);

    // Once completed, re-enqueuing the same lecture is permitted
    chromeMock.records.set(900, {
      id: 900,
      state: 'complete',
      bytesReceived: 100_000_000,
      totalBytes: 100_000_000,
    });
    await manager.handleDownloadDelta({ id: 900, state: { current: 'complete' } });

    const thirdBatch = await manager.enqueue([dupItem]);
    expect(thirdBatch).toHaveLength(1);
    expect(manager.getState().items).toHaveLength(2);
  });

  it('rejects resolved URLs outside the manifest host allowlist before calling chrome.downloads.download [ARCH-001]', async () => {
    const chromeMock = createInMemoryChromeDownloads(1000);
    const manager = new DownloadManager({
      api: chromeMock.api,
      maxConcurrent: 2,
      resolveDownloadUrl: async () => 'https://evil.example/video.mp4?ks=STOLEN_TOKEN',
    });

    await manager.enqueue([makeItem(1)]);
    expect(chromeMock.downloadSpy).not.toHaveBeenCalled();
    const state = manager.getState();
    expect(state.items[0]?.status).toBe('failed');
    expect(state.items[0]?.error).toContain('allowed host');
    expect(state.items[0]?.error).not.toContain('STOLEN_TOKEN');
  });

  it('sanitizes signed query parameters, path-embedded /ks/<token>/, and bare/cookie token patterns [QA-004]', async () => {
    const chromeMock = createInMemoryChromeDownloads(1100);
    const manager = new DownloadManager({
      api: {
        ...chromeMock.api,
        download: vi.fn(async () => {
          throw new Error(
            'Failed fetching https://cfvod.kaltura.com/p/2203921/ks/PATH_SECRET_KS_99/a.mp4?Policy=ABC&Signature=SECRET123&ks=TOK999',
          );
        }),
      },
      maxConcurrent: 2,
      resolveDownloadUrl: createDefaultResolver(),
    });

    await manager.enqueue([makeItem(1)]);
    const state = manager.getState();
    expect(state.items[0]?.status).toBe('failed');
    expect(state.items[0]?.error).not.toContain('PATH_SECRET_KS_99');
    expect(state.items[0]?.error).not.toContain('SECRET123');
    expect(state.items[0]?.error).not.toContain('TOK999');
    expect(state.items[0]?.error).toContain('/ks/[REDACTED]/a.mp4');

    expect(sanitizeErrorMessage('Bad request ?sesskey=MYSECRETKEY')).toBe(
      'Bad request ?sesskey=[REDACTED]',
    );
    expect(
      sanitizeErrorMessage(
        'Headers: ks=BARE_KS_123 Policy=POL1 Signature=SIG2 Key-Pair-Id=KPID3 MoodleSessionpsico=SESS4; _shibsession_646566=SHIB5',
      ),
    ).toBe(
      'Headers: ks=[REDACTED] Policy=[REDACTED] Signature=[REDACTED] Key-Pair-Id=[REDACTED] MoodleSessionpsico=[REDACTED]; _shibsession_646566=[REDACTED]',
    );
    expect(
      sanitizeErrorMessage('Path error /p/2203921/ks/djJ8SECRET_PATH_TOKEN/format/url'),
    ).toBe('Path error /p/2203921/ks/[REDACTED]/format/url');
  });

  it('supports kind: material lazy descriptors, folder file dedupe, and finalized extension/filename updates', async () => {
    const chromeMock = createInMemoryChromeDownloads(1200);
    const baseApi = chromeMock.api;
    const apiWithUnknownInitialSize: DownloadsApiAdapter = {
      ...baseApi,
      download: vi.fn(async (opts) => {
        const id = await baseApi.download(opts);
        const rec = chromeMock.records.get(id);
        if (rec) {
          rec.totalBytes = 0;
        }
        return id;
      }),
    };
    let persisted: PersistedDownloadEntry[] = [];
    const storage: QueueStorageAdapter = {
      load: async () => structuredClone(persisted),
      save: async (entries) => {
        persisted = structuredClone(entries);
      },
    };

    const materialResource = {
      cmid: 410001,
      courseId: 7075,
      sectionIndex: 1,
      sectionTitle: 'Week 1',
      activityIndex: 1,
      title: 'Week 3 Slides',
      type: 'resource' as const,
      url: 'https://psico.elearning.unipd.it/mod/resource/view.php?id=410001',
      fileTypeHint: 'slides',
      detailsText: '2.1 MB PowerPoint',
    };

    const materialFolder = {
      cmid: 410002,
      courseId: 7075,
      sectionIndex: 1,
      sectionTitle: 'Week 1',
      activityIndex: 2,
      title: 'Datasets',
      type: 'folder' as const,
      url: 'https://psico.elearning.unipd.it/mod/folder/view.php?id=410002',
      fileTypeHint: 'folder',
      detailsText: null,
    };

    const resourceItem: EnqueueDownloadItem = {
      cmid: 410001,
      courseId: 7075,
      lectureTitle: 'Week 3 Slides',
      filename: 'UniPD/2026-2027/PSQ4107809 - Testing/01 - Week 1/Materials/01 - Week 3 Slides.bin',
      kind: 'material',
      descriptor: {
        kind: 'material',
        material: materialResource,
        filename: 'UniPD/2026-2027/PSQ4107809 - Testing/01 - Week 1/Materials/01 - Week 3 Slides.bin',
      },
    };

    const folderFileA: EnqueueDownloadItem = {
      cmid: 410002,
      courseId: 7075,
      lectureTitle: 'Datasets / a.csv',
      filename: 'UniPD/2026-2027/PSQ4107809 - Testing/01 - Week 1/Materials/Datasets/a.csv',
      kind: 'material',
      descriptor: {
        kind: 'material',
        material: materialFolder,
        filename: 'UniPD/2026-2027/PSQ4107809 - Testing/01 - Week 1/Materials/Datasets/a.csv',
        folderFileIndex: 1,
        expectedFileName: 'a.csv',
      },
    };

    const folderFileB: EnqueueDownloadItem = {
      cmid: 410002,
      courseId: 7075,
      lectureTitle: 'Datasets / b.R',
      filename: 'UniPD/2026-2027/PSQ4107809 - Testing/01 - Week 1/Materials/Datasets/b.r',
      kind: 'material',
      descriptor: {
        kind: 'material',
        material: materialFolder,
        filename: 'UniPD/2026-2027/PSQ4107809 - Testing/01 - Week 1/Materials/Datasets/b.r',
        folderFileIndex: 2,
        expectedFileName: 'b.R',
      },
    };

    const resolver = vi.fn(async (descriptor: DownloadResolutionDescriptor) => {
      if (descriptor.kind === 'material' && descriptor.material.cmid === 410001) {
        return {
          url: 'https://psico.elearning.unipd.it/pluginfile.php/99/mod_resource/content/0/slides.pptx',
          resolvedFilename:
            'UniPD/2026-2027/PSQ4107809 - Testing/01 - Week 1/Materials/01 - Week 3 Slides.pptx',
          resolvedSizeBytes: 2_200_000,
        };
      }
      return {
        url: `https://psico.elearning.unipd.it/pluginfile.php/99/mod_folder/content/0/${descriptor.kind === 'material' ? (descriptor.expectedFileName ?? 'file') : 'x'}`,
      };
    });

    const manager = new DownloadManager({
      api: apiWithUnknownInitialSize,
      storage,
      maxConcurrent: 2,
      resolveDownloadUrl: resolver,
    });

    // Enqueue 3 material items (2 from same folder cmid with different filenames!)
    const created = await manager.enqueue([resourceItem, folderFileA, folderFileB]);
    expect(created).toHaveLength(3);

    // Re-enqueuing resourceItem while in_progress must still be deduplicated even though item.filename updated to .pptx
    const dupRes = await manager.enqueue([resourceItem]);
    expect(dupRes).toHaveLength(0);

    expect(chromeMock.downloadSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        filename:
          'UniPD/2026-2027/PSQ4107809 - Testing/01 - Week 1/Materials/01 - Week 3 Slides.pptx',
      }),
    );

    const state = manager.getState();
    expect(state.items[0]?.filename).toMatch(/01 - Week 3 Slides\.pptx$/);
    expect(state.items[0]?.totalBytes).toBe(2_200_000);
    expect(state.items[2]?.status).toBe('queued');

    // Simulate SW restart before folderFileB runs
    const manager2 = new DownloadManager({
      api: chromeMock.api,
      storage,
      maxConcurrent: 2,
      resolveDownloadUrl: resolver,
    });
    chromeMock.records.set(1200, {
      id: 1200,
      state: 'complete',
      bytesReceived: 2_200_000,
      totalBytes: 2_200_000,
    });
    await manager2.handleDownloadDelta({ id: 1200, state: { current: 'complete' } });
    expect(manager2.getState().items[2]?.status).toBe('in_progress');
  });

  it('preserves 85-99 char courseFolder parity, strips .. traversal, guards Windows stems, and caps resolvedFilename <= 180 chars [ARCH-006-01]', async () => {
    const chromeMock = createInMemoryChromeDownloads(1300);

    const courseFolder85 = `PSQ4107809 - ${'A'.repeat(72)}`;
    const courseFolder99 = `PSQ410780901234567890123 - ${'B'.repeat(72)}`;
    expect(courseFolder85.length).toBe(85);
    expect(courseFolder99.length).toBe(99);

    const resolvedTargets: Record<number, string> = {
      420001: `UniPD/2026-2027/${courseFolder85}/01 - Intro/Materials/01 - Syllabus.pdf`,
      420002: `UniPD/2026-2027/${courseFolder99}/01 - Intro/Materials/01 - Slides.pptx`,
      420003: 'UniPD/2026-2027/../../Course/../01 - Intro/../Materials/../../evil.pdf',
      420004: 'UniPD/2026-2027/CON/01 - Intro/Materials/NUL.1.pdf',
      420005: `UniPD/2026-2027/${courseFolder99}/01 - Week One Assessment/Materials/01 - ${'LongTitle'.repeat(12)}.pptx`,
    };

    const manager = new DownloadManager({
      api: chromeMock.api,
      maxConcurrent: 5,
      resolveDownloadUrl: async (descriptor) => {
        if (descriptor.kind !== 'material') {
          throw new Error('Expected material descriptor');
        }
        return {
          url: `https://psico.elearning.unipd.it/pluginfile.php/1/mod_resource/content/0/${descriptor.material.cmid}.pdf`,
          resolvedFilename: resolvedTargets[descriptor.material.cmid]!,
        };
      },
    });

    const makeMaterialReq = (cmid: number): EnqueueDownloadItem => ({
      cmid,
      courseId: 7075,
      lectureTitle: `Item ${cmid}`,
      filename: `UniPD/2026-2027/placeholder/${cmid}.bin`,
      kind: 'material',
      descriptor: {
        kind: 'material',
        material: {
          cmid,
          courseId: 7075,
          sectionIndex: 1,
          sectionTitle: 'Intro',
          activityIndex: 1,
          title: `Item ${cmid}`,
          type: 'resource',
          url: `https://psico.elearning.unipd.it/mod/resource/view.php?id=${cmid}`,
          fileTypeHint: null,
          detailsText: null,
        },
        filename: `UniPD/2026-2027/placeholder/${cmid}.bin`,
      },
    });

    await manager.enqueue([
      makeMaterialReq(420001),
      makeMaterialReq(420002),
      makeMaterialReq(420003),
      makeMaterialReq(420004),
      makeMaterialReq(420005),
    ]);

    const downloadedFilenames = chromeMock.downloadSpy.mock.calls.map((c) => c[0].filename);
    // (a) 85-char and 99-char courseFolder parity preserved intact (not truncated to 80 chars)
    expect(downloadedFilenames[0]).toBe(resolvedTargets[420001]);
    expect(downloadedFilenames[1]).toBe(resolvedTargets[420002]);

    // (b) '..' traversal segments stripped cleanly
    expect(downloadedFilenames[2]).toBe('UniPD/2026-2027/Course/01 - Intro/Materials/evil.pdf');
    expect(downloadedFilenames[2]).not.toContain('..');

    // (c) Windows reserved stems guarded across directories and dotted filenames
    expect(downloadedFilenames[3]).toBe('UniPD/2026-2027/CON_/01 - Intro/Materials/NUL_.1.pdf');

    // (d) >180-char resolvedFilename truncated safely <= 180 while keeping courseFolder parity
    const truncated = downloadedFilenames[4]!;
    expect(truncated.length).toBeLessThanOrEqual(180);
    expect(truncated.startsWith(`UniPD/2026-2027/${courseFolder99}/`)).toBe(true);
    expect(truncated.endsWith('.pptx')).toBe(true);
  });

  it('retains secret-free descriptors on failed/cancelled items, supports retry(), and notifies onDownloadCompleted once [TASK-007]', async () => {
    const chromeMock = createInMemoryChromeDownloads(900);
    const savedSnapshots: PersistedDownloadEntry[][] = [];
    const storage: QueueStorageAdapter = {
      load: async () => [],
      save: async (entries) => {
        savedSnapshots.push(entries);
      },
    };

    const resolveSpy = vi.fn(async (descriptor: DownloadResolutionDescriptor) => {
      return `https://cdnapisec.kaltura.com/p/2203921/sp/220392100/playManifest/entryId/1_test/flavorId/1_flv/format/url/protocol/https/a.mp4?ks=KS_${resolveSpy.mock.calls.length}&name=${encodeURIComponent(descriptor.filename)}`;
    });

    const onCompletedSpy = vi.fn();
    const manager = new DownloadManager({
      api: chromeMock.api,
      storage,
      maxConcurrent: 2,
      resolveDownloadUrl: resolveSpy,
      onDownloadCompleted: onCompletedSpy,
    });

    const item1 = makeItem(1, 'video');
    const item2 = makeItem(2, 'video');
    const [task1, task2] = await manager.enqueue([item1, item2]);

    // Cancel task1 and interrupt task2 as a transient network failure
    const afterCancel = await manager.cancel(task1!);
    const cancelledItem = afterCancel.items.find((i) => i.id === task1);
    expect(cancelledItem?.status).toBe('cancelled');
    expect(cancelledItem?.canRetry).toBe(true);

    chromeMock.records.get(901)!.state = 'interrupted';
    chromeMock.records.get(901)!.error = 'NETWORK_FAILED';
    await manager.handleDownloadDelta({
      id: 901,
      state: { current: 'interrupted' },
      error: { current: 'NETWORK_FAILED' },
    });

    const latestSaved = savedSnapshots.at(-1)!;
    expect(latestSaved.find((e) => e.item.id === task1)?.descriptor).not.toBeNull();
    expect(latestSaved.find((e) => e.item.id === task2)?.descriptor).not.toBeNull();
    expect(JSON.stringify(latestSaved)).not.toContain('KS_');

    // Retry both cancelled task1 and failed task2 cleanly
    const retried1 = await manager.retry(task1!);
    expect(retried1.items.find((i) => i.id === task1)?.status).toBe('in_progress');
    expect(retried1.items.find((i) => i.id === task1)?.canRetry).toBe(false);

    const retried2 = await manager.retry(task2!);
    expect(retried2.items.find((i) => i.id === task2)?.status).toBe('in_progress');
    expect(resolveSpy).toHaveBeenCalledTimes(4);

    // Complete retried task1 via delta, then ensure repeated search/reconcile does not double-fire
    const newDl1 = retried1.items.find((i) => i.id === task1)!.downloadId!;
    chromeMock.records.get(newDl1)!.state = 'complete';
    chromeMock.records.get(newDl1)!.bytesReceived = 100_000_000;
    await manager.handleDownloadDelta({ id: newDl1, state: { current: 'complete' } });
    await manager.refreshActiveProgress();

    expect(onCompletedSpy).toHaveBeenCalledTimes(1);
    expect(onCompletedSpy.mock.calls[0]?.[0].kind).toBe('video');
    expect(savedSnapshots.at(-1)!.find((e) => e.item.id === task1)?.descriptor).toBeNull();
  });

  it('rejects retry() when metadata is missing or an active duplicate exists [TASK-007]', async () => {
    const chromeMock = createInMemoryChromeDownloads(950);
    const item = makeItem(1, 'video');
    const storage: QueueStorageAdapter = {
      load: async () => [
        {
          item: {
            id: 'missing-desc-task',
            cmid: 9991,
            courseId: 7075,
            lectureTitle: 'Missing',
            filename: 'UniPD/missing.mp4',
            kind: 'video',
            status: 'failed',
            downloadId: null,
            bytesReceived: 0,
            totalBytes: 0,
            error: 'Old failure',
            createdAt: 1,
          },
          descriptor: null,
        },
        {
          item: {
            id: 'failed-dup-task',
            cmid: item.cmid,
            courseId: 7075,
            lectureTitle: item.lectureTitle,
            filename: item.filename,
            kind: 'video',
            status: 'failed',
            downloadId: null,
            bytesReceived: 0,
            totalBytes: 100_000_000,
            error: 'Failed',
            createdAt: 2,
          },
          descriptor: item.descriptor,
        },
      ],
      save: async () => {},
    };

    const manager = new DownloadManager({
      api: chromeMock.api,
      storage,
      maxConcurrent: 2,
      resolveDownloadUrl: createDefaultResolver(),
    });

    const initialState = await manager.refreshActiveProgress();
    expect(initialState.items.find((i) => i.id === 'missing-desc-task')?.canRetry).toBe(false);
    expect(initialState.items.find((i) => i.id === 'failed-dup-task')?.canRetry).toBe(true);

    await expect(manager.retry('missing-desc-task')).rejects.toThrow(/metadata is missing/i);

    await manager.enqueue([item]);
    await expect(manager.retry('failed-dup-task')).rejects.toThrow(/already queued or downloading/i);
  });
});
