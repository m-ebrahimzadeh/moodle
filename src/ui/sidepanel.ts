import {
  buildLectureDownloadPath,
  formatDuration,
  formatFileSize,
  type CourseSection,
  type EnrolledCourse,
  type LectureActivity,
} from '../core/index.js';
import type {
  DownloadQueueItem,
  DownloadQueueState,
  EnqueueDownloadItem,
  ExtensionBroadcastEvent,
  ExtensionRequest,
  ExtensionResponse,
  PublicResolvedLectureMedia,
  PublicSessionStatus,
  PublicVideoFlavor,
} from '../extension/messages.js';

interface LectureUiState {
  activity: LectureActivity;
  selected: boolean;
  resolving: boolean;
  resolved: PublicResolvedLectureMedia | null;
  selectedFlavorId: string | null;
  error: string | null;
}

interface LectureRowDomRefs {
  rowEl: HTMLLIElement;
  checkbox: HTMLInputElement;
  metaEl: HTMLDivElement;
  controlsEl: HTMLDivElement;
  flavorSelect: HTMLSelectElement;
  renderedFlavorSignature: string;
}

interface QueueCardDomRefs {
  cardEl: HTMLDivElement;
  filenameEl: HTMLSpanElement;
  statusBadgeEl: HTMLSpanElement;
  progressEl: HTMLProgressElement;
  bytesTextEl: HTMLSpanElement;
  cancelBtnEl: HTMLButtonElement;
  errorEl: HTMLDivElement;
}

const state = {
  session: null as PublicSessionStatus | null,
  courses: [] as EnrolledCourse[],
  selectedAy: 'ALL',
  searchQuery: '',
  selectedCourse: null as EnrolledCourse | null,
  sections: [] as CourseSection[],
  lecturesByCmid: new Map<number, LectureUiState>(),
  inFlightResolves: new Map<number, Promise<void>>(),
  defaultQuality: 'highest' as 'highest' | '1080p' | '720p' | '360p',
  includeVtt: true,
  enqueuing: false,
  sessionLoadPromise: null as Promise<void> | null,
  pendingSessionReload: false,
  queue: {
    maxConcurrent: 2,
    activeCount: 0,
    queuedCount: 0,
    items: [],
  } as DownloadQueueState,
  progressTimerId: null as number | null,
  scanGeneration: 0,
};

const lectureRowsByCmid = new Map<number, LectureRowDomRefs>();
const queueCardsById = new Map<string, QueueCardDomRefs>();
let queueEmptyStateEl: HTMLParagraphElement | null = null;

function requireElement<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Missing required UI element #${id}`);
  }
  return el as T;
}

const dom = {
  refreshSessionBtn: requireElement<HTMLButtonElement>('refresh-session-btn'),
  authBanner: requireElement<HTMLElement>('auth-banner'),
  authMessage: requireElement<HTMLSpanElement>('auth-message'),
  ssoLoginBtn: requireElement<HTMLButtonElement>('sso-login-btn'),
  globalAlert: requireElement<HTMLDivElement>('global-alert'),
  courseCountBadge: requireElement<HTMLSpanElement>('course-count-badge'),
  ayFilter: requireElement<HTMLSelectElement>('ay-filter'),
  courseSearch: requireElement<HTMLInputElement>('course-search'),
  courseList: requireElement<HTMLDivElement>('course-list'),
  lecturesPanel: requireElement<HTMLElement>('lectures-panel'),
  selectedCourseLabel: requireElement<HTMLParagraphElement>('selected-course-label'),
  rescanCourseBtn: requireElement<HTMLButtonElement>('rescan-course-btn'),
  selectAllBtn: requireElement<HTMLButtonElement>('select-all-btn'),
  selectNoneBtn: requireElement<HTMLButtonElement>('select-none-btn'),
  defaultQualitySelect: requireElement<HTMLSelectElement>('default-quality-select'),
  includeVttToggle: requireElement<HTMLInputElement>('include-vtt-toggle'),
  lecturesContainer: requireElement<HTMLDivElement>('lectures-container'),
  selectionCount: requireElement<HTMLSpanElement>('selection-count'),
  selectionSize: requireElement<HTMLSpanElement>('selection-size'),
  downloadSelectedBtn: requireElement<HTMLButtonElement>('download-selected-btn'),
  queueStatsBadge: requireElement<HTMLSpanElement>('queue-stats-badge'),
  clearFinishedBtn: requireElement<HTMLButtonElement>('clear-finished-btn'),
  queueList: requireElement<HTMLDivElement>('queue-list'),
};

async function sendExtensionMessage<T extends ExtensionRequest['type']>(
  request: Extract<ExtensionRequest, { type: T }>,
): Promise<Extract<ExtensionResponse<T>, { ok: true }>> {
  const response = (await chrome.runtime.sendMessage(request)) as ExtensionResponse<T> | undefined;
  if (!response) {
    throw new Error('No response from extension service worker.');
  }
  if (!response.ok) {
    throw new Error(response.error);
  }
  return response;
}

function showAlert(message: string | null): void {
  if (!message) {
    dom.globalAlert.hidden = true;
    dom.globalAlert.textContent = '';
    return;
  }
  dom.globalAlert.textContent = message;
  dom.globalAlert.hidden = false;
}

function renderAuthBanner(): void {
  const session = state.session;
  dom.authBanner.classList.remove('auth-checking', 'auth-ok', 'auth-required');

  if (!session) {
    dom.authBanner.classList.add('auth-checking');
    dom.authMessage.textContent = 'Checking UniPD Moodle session…';
    dom.ssoLoginBtn.hidden = true;
    return;
  }

  if (session.authenticated) {
    dom.authBanner.classList.add('auth-ok');
    dom.authMessage.textContent = 'Signed in to UniPD Moodle';
    dom.ssoLoginBtn.hidden = true;
  } else {
    dom.authBanner.classList.add('auth-required');
    dom.authMessage.textContent = 'Sign in required for psico.elearning.unipd.it';
    dom.ssoLoginBtn.hidden = false;
  }
}

function populateAcademicYearFilter(): void {
  const years = Array.from(
    new Set(
      state.courses
        .map((c) => c.academicYear)
        .filter((ay): ay is string => Boolean(ay)),
    ),
  ).sort((a, b) => b.localeCompare(a));

  const previous = state.selectedAy;
  dom.ayFilter.replaceChildren();

  const allOpt = document.createElement('option');
  allOpt.value = 'ALL';
  allOpt.textContent = 'All years';
  dom.ayFilter.appendChild(allOpt);

  for (const year of years) {
    const opt = document.createElement('option');
    opt.value = year;
    opt.textContent = year;
    dom.ayFilter.appendChild(opt);
  }

  if (previous !== 'ALL' && years.includes(previous)) {
    dom.ayFilter.value = previous;
  } else {
    state.selectedAy = 'ALL';
    dom.ayFilter.value = 'ALL';
  }
}

function getFilteredCourses(): EnrolledCourse[] {
  const q = state.searchQuery.trim().toLowerCase();
  return state.courses.filter((course) => {
    if (state.selectedAy !== 'ALL' && course.academicYear !== state.selectedAy) {
      return false;
    }
    if (!q) {
      return true;
    }
    return (
      course.title.toLowerCase().includes(q) ||
      course.fullname.toLowerCase().includes(q) ||
      (course.courseCode?.toLowerCase().includes(q) ?? false) ||
      course.shortname.toLowerCase().includes(q)
    );
  });
}

function renderCourseList(): void {
  const filtered = getFilteredCourses();
  dom.courseCountBadge.textContent = String(filtered.length);
  dom.courseList.replaceChildren();

  if (!state.session?.authenticated) {
    const p = document.createElement('p');
    p.className = 'empty-state';
    p.textContent = 'Sign in with UniPD SSO to load your enrolled courses.';
    dom.courseList.appendChild(p);
    return;
  }

  if (filtered.length === 0) {
    const p = document.createElement('p');
    p.className = 'empty-state';
    p.textContent =
      state.courses.length === 0
        ? 'No enrolled courses found.'
        : 'No courses match your current filter.';
    dom.courseList.appendChild(p);
    return;
  }

  for (const course of filtered) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'course-card';
    card.setAttribute('role', 'option');
    card.setAttribute('aria-selected', String(state.selectedCourse?.id === course.id));

    const top = document.createElement('div');
    top.className = 'course-card-top';

    const codeSpan = document.createElement('span');
    codeSpan.className = 'course-code';
    codeSpan.textContent = course.courseCode ?? `ID ${course.id}`;
    top.appendChild(codeSpan);

    if (course.academicYear) {
      const ayBadge = document.createElement('span');
      ayBadge.className = 'badge';
      ayBadge.textContent = course.academicYear;
      top.appendChild(ayBadge);
    }

    const titleSpan = document.createElement('span');
    titleSpan.className = 'course-title';
    titleSpan.textContent = course.title;

    card.append(top, titleSpan);
    card.addEventListener('click', () => {
      void selectCourse(course);
    });
    dom.courseList.appendChild(card);
  }
}

function pickFlavorForPreference(
  flavors: PublicVideoFlavor[],
  pref: 'highest' | '1080p' | '720p' | '360p',
): PublicVideoFlavor | null {
  if (flavors.length === 0) {
    return null;
  }
  if (pref === 'highest') {
    return flavors[0] ?? null;
  }
  const targetHeight = Number.parseInt(pref, 10);
  const exact = flavors.find((f) => f.height === targetHeight);
  if (exact) {
    return exact;
  }
  const nearest = [...flavors].sort(
    (a, b) => Math.abs(a.height - targetHeight) - Math.abs(b.height - targetHeight),
  );
  return nearest[0] ?? flavors[0] ?? null;
}

function formatFlavorLabel(flavor: PublicVideoFlavor): string {
  const res = flavor.height > 0 ? `${flavor.height}p` : 'MP4';
  const size = flavor.sizeBytes > 0 ? ` · ${formatFileSize(flavor.sizeBytes)}` : '';
  const orig = flavor.isOriginal ? ' (orig)' : '';
  return `${res}${orig}${size}`;
}

function getSelectedFlavor(entry: LectureUiState): PublicVideoFlavor | null {
  const flavors = entry.resolved?.flavors ?? [];
  if (flavors.length === 0) {
    return null;
  }
  if (entry.selectedFlavorId) {
    const found = flavors.find((f) => f.id === entry.selectedFlavorId);
    if (found) {
      return found;
    }
  }
  return flavors[0] ?? null;
}

function isEntryDownloadable(entry: LectureUiState): boolean {
  if (!entry.resolved) {
    return false;
  }
  return entry.resolved.flavors.length > 0 || entry.resolved.hasDirectMp4;
}

function updateSelectionSummary(): void {
  let selectedCount = 0;
  let downloadableCount = 0;
  let unresolvedSelectedCount = 0;
  let totalBytes = 0;

  for (const entry of state.lecturesByCmid.values()) {
    if (!entry.selected) {
      continue;
    }
    selectedCount += 1;
    if (!entry.resolved && !entry.error) {
      unresolvedSelectedCount += 1;
      continue;
    }
    if (isEntryDownloadable(entry)) {
      downloadableCount += 1;
      const flavor = getSelectedFlavor(entry);
      if (flavor && flavor.sizeBytes > 0) {
        totalBytes += flavor.sizeBytes;
      }
    }
  }

  dom.selectionCount.textContent = `${selectedCount} selected`;
  if (unresolvedSelectedCount > 0) {
    const sizePrefix = totalBytes > 0 ? `Est. ${formatFileSize(totalBytes)} · ` : '';
    dom.selectionSize.textContent = `${sizePrefix}Resolving ${unresolvedSelectedCount} selected…`;
  } else {
    dom.selectionSize.textContent = totalBytes > 0 ? `Est. ${formatFileSize(totalBytes)}` : '';
  }

  dom.downloadSelectedBtn.textContent = state.enqueuing ? 'Queuing…' : 'Download Selected';
  dom.downloadSelectedBtn.disabled =
    state.enqueuing || unresolvedSelectedCount > 0 || downloadableCount === 0;
}

function updateLectureRow(cmid: number): void {
  const refs = lectureRowsByCmid.get(cmid);
  const entry = state.lecturesByCmid.get(cmid);
  if (!refs || !entry) {
    return;
  }

  const activity = entry.activity;
  const nonDownloadableResolved = entry.resolved !== null && !isEntryDownloadable(entry);

  refs.checkbox.checked = entry.selected;
  refs.checkbox.disabled = nonDownloadableResolved;

  // Rebuild only the status/metadata badges inside this row — leaves focus & <select> untouched
  const metaNodes: Node[] = [];
  const typeBadge = document.createElement('span');
  typeBadge.className = 'badge';
  typeBadge.textContent =
    activity.type === 'kalvidres' ? 'Kaltura' : `Moodle ${activity.type}`;
  metaNodes.push(typeBadge);

  if (entry.resolving) {
    const loading = document.createElement('span');
    loading.textContent = 'Resolving stream…';
    metaNodes.push(loading);
  } else if (entry.error) {
    const errSpan = document.createElement('span');
    errSpan.className = 'badge badge-err';
    errSpan.textContent = entry.error;
    metaNodes.push(errSpan);
  } else if (entry.resolved) {
    const activeFlavor = getSelectedFlavor(entry);
    if (activeFlavor || entry.resolved.hasDirectMp4) {
      if (entry.resolved.durationSec) {
        const dur = document.createElement('span');
        dur.textContent = formatDuration(entry.resolved.durationSec);
        metaNodes.push(dur);
      }

      const sizeBadge = document.createElement('span');
      sizeBadge.className = 'badge badge-accent';
      sizeBadge.textContent = activeFlavor
        ? formatFileSize(activeFlavor.sizeBytes)
        : 'Direct MP4';
      metaNodes.push(sizeBadge);

      if (entry.resolved.captions.length > 0) {
        const subBadge = document.createElement('span');
        subBadge.className = 'badge badge-ok';
        subBadge.textContent = `${entry.resolved.captions.length} .vtt`;
        metaNodes.push(subBadge);
      }
    } else {
      const unsupported = document.createElement('span');
      unsupported.textContent = 'External / non-MP4 embed (not downloadable)';
      metaNodes.push(unsupported);
    }
  }
  refs.metaEl.replaceChildren(...metaNodes);

  // Preserve the <select> element and its <option> nodes in place when flavor list hasn't changed
  if (entry.resolved && entry.resolved.flavors.length > 0) {
    const flavorSig = entry.resolved.flavors
      .map((f) => `${f.id}:${f.height}:${f.sizeBytes}:${f.isOriginal ? '1' : '0'}`)
      .join('|');

    if (flavorSig !== refs.renderedFlavorSignature) {
      const optionNodes = entry.resolved.flavors.map((flavor) => {
        const opt = document.createElement('option');
        opt.value = flavor.id;
        opt.textContent = formatFlavorLabel(flavor);
        return opt;
      });
      refs.flavorSelect.replaceChildren(...optionNodes);
      refs.renderedFlavorSignature = flavorSig;
    }

    const currentFlavor = getSelectedFlavor(entry);
    if (currentFlavor && refs.flavorSelect.value !== currentFlavor.id) {
      refs.flavorSelect.value = currentFlavor.id;
    }
    refs.controlsEl.hidden = false;
  } else {
    refs.controlsEl.hidden = true;
  }
}

function renderLecturesStructure(): void {
  dom.lecturesContainer.replaceChildren();
  lectureRowsByCmid.clear();

  if (!state.selectedCourse) {
    dom.lecturesPanel.hidden = true;
    updateSelectionSummary();
    return;
  }

  dom.lecturesPanel.hidden = false;
  const coursePrefix = state.selectedCourse.courseCode
    ? `${state.selectedCourse.courseCode} — `
    : '';
  dom.selectedCourseLabel.textContent = `${coursePrefix}${state.selectedCourse.title}`;

  if (state.sections.length === 0) {
    const p = document.createElement('p');
    p.className = 'empty-state';
    p.textContent = 'No supported video lectures (Kaltura / Moodle MP4) found in this course.';
    dom.lecturesContainer.appendChild(p);
    updateSelectionSummary();
    return;
  }

  for (const section of state.sections) {
    const group = document.createElement('div');
    group.className = 'section-group';

    const header = document.createElement('div');
    header.className = 'section-header';

    const secTitle = document.createElement('span');
    secTitle.textContent = `${String(section.sectionIndex).padStart(2, '0')} · ${section.title}`;

    const secCount = document.createElement('span');
    secCount.className = 'badge';
    secCount.textContent = `${section.activities.length}`;

    header.append(secTitle, secCount);
    group.appendChild(header);

    const list = document.createElement('ul');
    list.className = 'lecture-list';

    for (const activity of section.activities) {
      const entry = state.lecturesByCmid.get(activity.cmid);
      if (!entry) {
        continue;
      }

      const li = document.createElement('li');
      li.className = 'lecture-row';

      const mainRow = document.createElement('div');
      mainRow.className = 'lecture-main';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.id = `lecture-chk-${activity.cmid}`;
      checkbox.addEventListener('change', () => {
        entry.selected = checkbox.checked;
        updateSelectionSummary();
      });

      const info = document.createElement('div');
      info.className = 'lecture-info';

      const titleLabel = document.createElement('label');
      titleLabel.className = 'lecture-title';
      titleLabel.htmlFor = checkbox.id;
      titleLabel.textContent = activity.title;

      const metaEl = document.createElement('div');
      metaEl.className = 'lecture-meta';

      info.append(titleLabel, metaEl);
      mainRow.append(checkbox, info);
      li.appendChild(mainRow);

      const controlsEl = document.createElement('div');
      controlsEl.className = 'lecture-controls';
      controlsEl.hidden = true;

      const flavorSelect = document.createElement('select');
      flavorSelect.className = 'flavor-select';
      flavorSelect.setAttribute('aria-label', `Resolution for ${activity.title}`);
      flavorSelect.addEventListener('change', () => {
        entry.selectedFlavorId = flavorSelect.value;
        updateLectureRow(activity.cmid);
        updateSelectionSummary();
      });

      controlsEl.appendChild(flavorSelect);
      li.appendChild(controlsEl);
      list.appendChild(li);

      lectureRowsByCmid.set(activity.cmid, {
        rowEl: li,
        checkbox,
        metaEl,
        controlsEl,
        flavorSelect,
        renderedFlavorSignature: '',
      });
      updateLectureRow(activity.cmid);
    }

    group.appendChild(list);
    dom.lecturesContainer.appendChild(group);
  }

  updateSelectionSummary();
}

function createQueueCard(item: DownloadQueueItem): QueueCardDomRefs {
  const cardEl = document.createElement('div');
  cardEl.className = 'queue-item';
  cardEl.dataset.taskId = item.id;

  const top = document.createElement('div');
  top.className = 'queue-item-top';

  const filenameEl = document.createElement('span');
  filenameEl.className = 'queue-filename';

  const statusBadgeEl = document.createElement('span');
  statusBadgeEl.className = 'badge';

  top.append(filenameEl, statusBadgeEl);

  const progressEl = document.createElement('progress');
  progressEl.max = 100;
  progressEl.hidden = true;

  const meta = document.createElement('div');
  meta.className = 'queue-meta';

  const bytesTextEl = document.createElement('span');

  const cancelBtnEl = document.createElement('button');
  cancelBtnEl.type = 'button';
  cancelBtnEl.className = 'btn btn-ghost btn-sm';
  cancelBtnEl.textContent = 'Cancel';
  cancelBtnEl.addEventListener('click', () => {
    void cancelDownload(item.id);
  });

  meta.append(bytesTextEl, cancelBtnEl);

  const errorEl = document.createElement('div');
  errorEl.className = 'queue-error';
  errorEl.hidden = true;

  cardEl.append(top, progressEl, meta, errorEl);

  return {
    cardEl,
    filenameEl,
    statusBadgeEl,
    progressEl,
    bytesTextEl,
    cancelBtnEl,
    errorEl,
  };
}

function updateQueueCard(refs: QueueCardDomRefs, item: DownloadQueueItem): void {
  if (refs.filenameEl.textContent !== item.filename) {
    refs.filenameEl.textContent = item.filename;
  }

  refs.statusBadgeEl.className = 'badge';
  if (item.status === 'completed') {
    refs.statusBadgeEl.classList.add('badge-ok');
  } else if (item.status === 'failed') {
    refs.statusBadgeEl.classList.add('badge-err');
  } else if (item.status === 'in_progress') {
    refs.statusBadgeEl.classList.add('badge-accent');
  }
  refs.statusBadgeEl.textContent =
    item.status === 'in_progress' ? 'Downloading' : item.status.replace('_', ' ');

  if (item.status === 'in_progress' || item.status === 'completed') {
    refs.progressEl.hidden = false;
    if (item.status === 'completed') {
      refs.progressEl.value = 100;
    } else if (item.totalBytes > 0) {
      refs.progressEl.value = Math.min(100, Math.round((item.bytesReceived / item.totalBytes) * 100));
    } else {
      refs.progressEl.removeAttribute('value');
    }
  } else {
    refs.progressEl.hidden = true;
  }

  const kindTag = item.kind === 'subtitle' ? '.vtt' : '.mp4';
  if (item.totalBytes > 0) {
    refs.bytesTextEl.textContent = `${kindTag} · ${formatFileSize(item.bytesReceived)} / ${formatFileSize(item.totalBytes)}`;
  } else if (item.bytesReceived > 0) {
    refs.bytesTextEl.textContent = `${kindTag} · ${formatFileSize(item.bytesReceived)}`;
  } else {
    refs.bytesTextEl.textContent = kindTag;
  }

  const cancellable = item.status === 'queued' || item.status === 'in_progress';
  refs.cancelBtnEl.hidden = !cancellable;
  refs.cancelBtnEl.setAttribute('aria-label', `Cancel ${item.lectureTitle}`);

  if (item.error) {
    refs.errorEl.textContent = item.error;
    refs.errorEl.hidden = false;
  } else {
    refs.errorEl.textContent = '';
    refs.errorEl.hidden = true;
  }
}

function renderQueue(): void {
  const { activeCount, queuedCount, maxConcurrent, items } = state.queue;
  dom.queueStatsBadge.textContent = `${activeCount}/${maxConcurrent} active · ${queuedCount} queued`;

  const hasFinished = items.some(
    (item) =>
      item.status === 'completed' || item.status === 'failed' || item.status === 'cancelled',
  );
  dom.clearFinishedBtn.disabled = !hasFinished;

  if (items.length === 0) {
    for (const refs of queueCardsById.values()) {
      refs.cardEl.remove();
    }
    queueCardsById.clear();

    if (!queueEmptyStateEl) {
      queueEmptyStateEl = document.createElement('p');
      queueEmptyStateEl.className = 'empty-state';
    }
    queueEmptyStateEl.textContent = `No downloads yet. Select lectures above to queue them (max ${maxConcurrent} concurrent).`;
    if (queueEmptyStateEl.parentElement !== dom.queueList) {
      dom.queueList.replaceChildren(queueEmptyStateEl);
    }
  } else {
    if (queueEmptyStateEl?.parentElement === dom.queueList) {
      queueEmptyStateEl.remove();
    } else if (queueCardsById.size === 0 && dom.queueList.children.length > 0) {
      // Remove initial static HTML empty-state paragraph once real items arrive
      dom.queueList.replaceChildren();
    }

    const ordered = [...items].reverse();
    const wantedIds = new Set(ordered.map((i) => i.id));

    for (const [id, refs] of queueCardsById.entries()) {
      if (!wantedIds.has(id)) {
        refs.cardEl.remove();
        queueCardsById.delete(id);
      }
    }

    for (let idx = 0; idx < ordered.length; idx += 1) {
      const item = ordered[idx];
      if (!item) {
        continue;
      }
      let refs = queueCardsById.get(item.id);
      if (!refs) {
        refs = createQueueCard(item);
        queueCardsById.set(item.id, refs);
      }
      updateQueueCard(refs, item);

      const currentAtIdx = dom.queueList.children[idx];
      if (currentAtIdx !== refs.cardEl) {
        dom.queueList.insertBefore(refs.cardEl, currentAtIdx ?? null);
      }
    }
  }

  syncProgressPolling();
}

function syncProgressPolling(): void {
  const hasPending = state.queue.activeCount > 0 || state.queue.queuedCount > 0;
  if (hasPending && state.progressTimerId === null) {
    state.progressTimerId = window.setInterval(() => {
      void refreshQueueState();
    }, 1200);
  } else if (!hasPending && state.progressTimerId !== null) {
    window.clearInterval(state.progressTimerId);
    state.progressTimerId = null;
  }
}

async function refreshQueueState(): Promise<void> {
  try {
    const res = await sendExtensionMessage({ type: 'GET_QUEUE_STATE' });
    state.queue = res.state;
    renderQueue();
  } catch {
    // Non-fatal during polling
  }
}

async function cancelDownload(taskId: string): Promise<void> {
  try {
    const res = await sendExtensionMessage({ type: 'CANCEL_DOWNLOAD', taskId });
    state.queue = res.state;
    renderQueue();
  } catch (err) {
    showAlert(err instanceof Error ? err.message : 'Failed to cancel download.');
  }
}

function resolveSingleLecture(entry: LectureUiState, generation: number): Promise<void> {
  if (entry.resolved || entry.error) {
    return Promise.resolve();
  }
  const existing = state.inFlightResolves.get(entry.activity.cmid);
  if (existing) {
    return existing;
  }

  const promise = (async () => {
    entry.resolving = true;
    entry.error = null;
    updateLectureRow(entry.activity.cmid);
    updateSelectionSummary();

    try {
      const res = await sendExtensionMessage({
        type: 'RESOLVE_LECTURE_MEDIA',
        activity: entry.activity,
      });
      if (state.scanGeneration !== generation) {
        return;
      }
      entry.resolved = res.media;
      const picked = pickFlavorForPreference(res.media.flavors, state.defaultQuality);
      entry.selectedFlavorId = picked?.id ?? null;
      entry.resolving = false;

      if (!isEntryDownloadable(entry)) {
        entry.selected = false;
      }
    } catch (err) {
      if (state.scanGeneration !== generation) {
        return;
      }
      entry.resolving = false;
      entry.selected = false;
      entry.error = err instanceof Error ? err.message : 'Resolution failed';
    } finally {
      state.inFlightResolves.delete(entry.activity.cmid);
    }

    if (state.scanGeneration === generation) {
      updateLectureRow(entry.activity.cmid);
      updateSelectionSummary();
    }
  })();

  state.inFlightResolves.set(entry.activity.cmid, promise);
  return promise;
}

async function resolveLecturesBounded(
  activities: LectureActivity[],
  generation: number,
): Promise<void> {
  const concurrency = 3;
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < activities.length) {
      if (state.scanGeneration !== generation) {
        return;
      }
      const activity = activities[cursor++];
      if (!activity) {
        return;
      }
      const entry = state.lecturesByCmid.get(activity.cmid);
      if (!entry) {
        continue;
      }
      await resolveSingleLecture(entry, generation);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, activities.length) }, () => worker());
  await Promise.all(workers);
}

async function selectCourse(course: EnrolledCourse): Promise<void> {
  showAlert(null);
  state.selectedCourse = course;
  state.sections = [];
  state.lecturesByCmid.clear();
  state.inFlightResolves.clear();
  lectureRowsByCmid.clear();
  const generation = ++state.scanGeneration;

  renderCourseList();
  dom.lecturesPanel.hidden = false;
  dom.selectedCourseLabel.textContent = `${course.courseCode ? `${course.courseCode} — ` : ''}${course.title}`;
  dom.lecturesContainer.replaceChildren();
  const loading = document.createElement('p');
  loading.className = 'empty-state';
  loading.textContent = 'Scanning course sections for lectures…';
  dom.lecturesContainer.appendChild(loading);
  updateSelectionSummary();

  try {
    const res = await sendExtensionMessage({
      type: 'SCAN_COURSE_LECTURES',
      courseId: course.id,
    });
    if (state.scanGeneration !== generation) {
      return;
    }

    state.sections = res.sections;
    const allActivities: LectureActivity[] = [];
    for (const section of res.sections) {
      for (const activity of section.activities) {
        state.lecturesByCmid.set(activity.cmid, {
          activity,
          selected: false,
          resolving: false,
          resolved: null,
          selectedFlavorId: null,
          error: null,
        });
        allActivities.push(activity);
      }
    }

    renderLecturesStructure();
    if (allActivities.length > 0) {
      await resolveLecturesBounded(allActivities, generation);
    }
  } catch (err) {
    showAlert(err instanceof Error ? err.message : 'Failed to scan course lectures.');
    renderLecturesStructure();
  }
}

async function enqueueSelectedDownloads(): Promise<void> {
  const course = state.selectedCourse;
  if (!course || state.enqueuing) {
    return;
  }

  const generation = state.scanGeneration;
  state.enqueuing = true;
  updateSelectionSummary();
  showAlert(null);

  try {
    // Defense-in-depth: if any selected lecture is still unresolved, await/resolve it
    // first so no selected lecture is ever silently skipped.
    const pendingSelected: LectureUiState[] = [];
    for (const entry of state.lecturesByCmid.values()) {
      if (entry.selected && !entry.resolved && !entry.error) {
        pendingSelected.push(entry);
      }
    }
    if (pendingSelected.length > 0) {
      await Promise.all(
        pendingSelected.map((entry) => resolveSingleLecture(entry, generation)),
      );
      if (state.scanGeneration !== generation) {
        return;
      }
    }

    const items: EnqueueDownloadItem[] = [];
    let skippedNonDownloadable = 0;

    for (const section of state.sections) {
      for (const activity of section.activities) {
        const entry = state.lecturesByCmid.get(activity.cmid);
        if (!entry || !entry.selected) {
          continue;
        }
        if (!entry.resolved || !isEntryDownloadable(entry)) {
          entry.selected = false;
          updateLectureRow(activity.cmid);
          skippedNonDownloadable += 1;
          continue;
        }

        const flavor = getSelectedFlavor(entry);
        const resolutionLabel = flavor && flavor.height > 0 ? `${flavor.height}p` : undefined;
        const lectureTitle = activity.title || entry.resolved.lectureTitle;

        const videoPath = buildLectureDownloadPath({
          academicYear: course.academicYear,
          courseCode: course.courseCode,
          courseTitle: course.title,
          sectionIndex: section.sectionIndex,
          sectionTitle: section.title,
          activityIndex: activity.activityIndex,
          lectureTitle,
          resolutionLabel,
          ext: flavor?.fileExt ?? 'mp4',
        });

        items.push({
          cmid: activity.cmid,
          courseId: course.id,
          lectureTitle,
          filename: videoPath,
          kind: 'video',
          sizeBytes: flavor?.sizeBytes ?? 0,
          descriptor: {
            activity,
            kind: 'video',
            filename: videoPath,
            preferredFlavorId: flavor?.id ?? null,
            preferredHeight: flavor && flavor.height > 0 ? flavor.height : null,
          },
        });

        if (state.includeVtt && entry.resolved.captions.length > 0) {
          for (const caption of entry.resolved.captions) {
            const langSuffix = caption.languageCode || caption.label;
            const captionPath = buildLectureDownloadPath({
              academicYear: course.academicYear,
              courseCode: course.courseCode,
              courseTitle: course.title,
              sectionIndex: section.sectionIndex,
              sectionTitle: section.title,
              activityIndex: activity.activityIndex,
              lectureTitle,
              resolutionLabel: langSuffix,
              ext: 'vtt',
            });

            items.push({
              cmid: activity.cmid,
              courseId: course.id,
              lectureTitle: `${lectureTitle} (${caption.label})`,
              filename: captionPath,
              kind: 'subtitle',
              descriptor: {
                activity,
                kind: 'subtitle',
                filename: captionPath,
                captionLanguageCode: caption.languageCode,
                captionLabel: caption.label,
                captionIndex: caption.index,
              },
            });
          }
        }
      }
    }

    if (skippedNonDownloadable > 0) {
      showAlert(
        `${skippedNonDownloadable} selected lecture(s) could not be downloaded (external or unavailable stream) and were unselected.`,
      );
    }

    if (items.length === 0) {
      return;
    }

    const res = await sendExtensionMessage({
      type: 'ENQUEUE_DOWNLOADS',
      items,
    });
    state.queue = res.state;
    renderQueue();
  } catch (err) {
    showAlert(err instanceof Error ? err.message : 'Failed to enqueue downloads.');
  } finally {
    state.enqueuing = false;
    updateSelectionSummary();
  }
}

function loadSessionAndCourses(): Promise<void> {
  if (state.sessionLoadPromise) {
    return state.sessionLoadPromise;
  }

  const run = (async () => {
    showAlert(null);
    state.session = null;
    renderAuthBanner();

    try {
      const sessionRes = await sendExtensionMessage({ type: 'GET_SESSION_STATUS' });
      state.session = sessionRes.session;
      renderAuthBanner();

      if (sessionRes.session.authenticated) {
        const coursesRes = await sendExtensionMessage({ type: 'LIST_COURSES' });
        state.courses = coursesRes.courses;
        populateAcademicYearFilter();
      } else {
        state.courses = [];
        state.selectedCourse = null;
        state.sections = [];
        state.lecturesByCmid.clear();
        state.inFlightResolves.clear();
        populateAcademicYearFilter();
        renderLecturesStructure();
      }

      renderCourseList();
    } catch (err) {
      state.session = {
        authenticated: false,
        userId: null,
        loginUrl: 'https://psico.elearning.unipd.it/auth/shibboleth/index.php',
      };
      renderAuthBanner();
      renderCourseList();
      showAlert(err instanceof Error ? err.message : 'Unable to reach UniPD Moodle.');
    } finally {
      state.sessionLoadPromise = null;
      const shouldRetry = state.pendingSessionReload && !state.session?.authenticated;
      state.pendingSessionReload = false;
      if (shouldRetry) {
        void loadSessionAndCourses();
      }
    }
  })();

  state.sessionLoadPromise = run;
  return run;
}

function wireEvents(): void {
  dom.refreshSessionBtn.addEventListener('click', () => {
    void loadSessionAndCourses();
  });

  dom.ssoLoginBtn.addEventListener('click', () => {
    void (async () => {
      try {
        await sendExtensionMessage({ type: 'OPEN_SSO_LOGIN' });
      } catch (err) {
        showAlert(err instanceof Error ? err.message : 'Could not open UniPD SSO login tab.');
      }
    })();
  });

  dom.ayFilter.addEventListener('change', () => {
    state.selectedAy = dom.ayFilter.value;
    renderCourseList();
  });

  dom.courseSearch.addEventListener('input', () => {
    state.searchQuery = dom.courseSearch.value;
    renderCourseList();
  });

  dom.rescanCourseBtn.addEventListener('click', () => {
    if (state.selectedCourse) {
      void selectCourse(state.selectedCourse);
    }
  });

  dom.selectAllBtn.addEventListener('click', () => {
    for (const [cmid, entry] of state.lecturesByCmid.entries()) {
      if (entry.resolved === null ? !entry.error : isEntryDownloadable(entry)) {
        entry.selected = true;
        updateLectureRow(cmid);
      }
    }
    updateSelectionSummary();
  });

  dom.selectNoneBtn.addEventListener('click', () => {
    for (const [cmid, entry] of state.lecturesByCmid.entries()) {
      entry.selected = false;
      updateLectureRow(cmid);
    }
    updateSelectionSummary();
  });

  dom.defaultQualitySelect.addEventListener('change', () => {
    state.defaultQuality = dom.defaultQualitySelect.value as typeof state.defaultQuality;
    for (const [cmid, entry] of state.lecturesByCmid.entries()) {
      if (entry.resolved && entry.resolved.flavors.length > 0) {
        const picked = pickFlavorForPreference(entry.resolved.flavors, state.defaultQuality);
        entry.selectedFlavorId = picked?.id ?? null;
        updateLectureRow(cmid);
      }
    }
    updateSelectionSummary();
  });

  dom.includeVttToggle.addEventListener('change', () => {
    state.includeVtt = dom.includeVttToggle.checked;
  });

  dom.downloadSelectedBtn.addEventListener('click', () => {
    void enqueueSelectedDownloads();
  });

  dom.clearFinishedBtn.addEventListener('click', () => {
    void (async () => {
      try {
        const res = await sendExtensionMessage({ type: 'CLEAR_FINISHED_DOWNLOADS' });
        state.queue = res.state;
        renderQueue();
      } catch (err) {
        showAlert(err instanceof Error ? err.message : 'Failed to clear finished downloads.');
      }
    })();
  });

  chrome.runtime.onMessage.addListener((event: ExtensionBroadcastEvent, sender) => {
    if (sender.id !== chrome.runtime.id) {
      return;
    }
    if (!event || typeof event !== 'object') {
      return;
    }
    if (event.type === 'QUEUE_UPDATED') {
      state.queue = event.state;
      renderQueue();
    } else if (event.type === 'SESSION_UPDATED') {
      if (state.sessionLoadPromise) {
        if (event.session.authenticated) {
          state.pendingSessionReload = true;
        }
        return;
      }
      const wasAuth = state.session?.authenticated ?? false;
      state.session = event.session;
      renderAuthBanner();
      if (!wasAuth && event.session.authenticated) {
        void loadSessionAndCourses();
      }
    }
  });
}

async function init(): Promise<void> {
  wireEvents();
  await Promise.all([loadSessionAndCourses(), refreshQueueState()]);
}

void init();
