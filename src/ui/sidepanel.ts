import {
  buildLectureDownloadPath,
  buildMaterialDownloadPath,
  formatDuration,
  formatFileSize,
  type CourseMaterialActivity,
  type CourseMaterialSection,
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
  PublicFolderFile,
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

interface MaterialFolderFileUiState {
  file: PublicFolderFile;
  selected: boolean;
}

interface MaterialUiState {
  material: CourseMaterialActivity;
  selected: boolean;
  folderExpanded: boolean;
  folderLoading: boolean;
  folderLoaded: boolean;
  folderError: string | null;
  folderFiles: MaterialFolderFileUiState[];
}

interface LectureRowDomRefs {
  rowEl: HTMLLIElement;
  checkbox: HTMLInputElement;
  metaEl: HTMLDivElement;
  controlsEl: HTMLDivElement;
  flavorSelect: HTMLSelectElement;
  renderedFlavorSignature: string;
}

interface MaterialRowDomRefs {
  rowEl: HTMLLIElement;
  checkbox: HTMLInputElement;
  metaEl: HTMLDivElement;
  expandBtn: HTMLButtonElement | null;
  filesContainerEl: HTMLDivElement | null;
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
  activeContentTab: 'videos' as 'videos' | 'materials',
  sections: [] as CourseSection[],
  materialSections: [] as CourseMaterialSection[],
  lecturesByCmid: new Map<number, LectureUiState>(),
  materialsByCmid: new Map<number, MaterialUiState>(),
  inFlightResolves: new Map<number, Promise<void>>(),
  inFlightFolderResolves: new Map<number, Promise<void>>(),
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
const materialRowsByCmid = new Map<number, MaterialRowDomRefs>();
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
  tabVideos: requireElement<HTMLButtonElement>('tab-videos'),
  tabMaterials: requireElement<HTMLButtonElement>('tab-materials'),
  videosTabpanel: requireElement<HTMLDivElement>('videos-tabpanel'),
  materialsTabpanel: requireElement<HTMLDivElement>('materials-tabpanel'),
  selectAllBtn: requireElement<HTMLButtonElement>('select-all-btn'),
  selectNoneBtn: requireElement<HTMLButtonElement>('select-none-btn'),
  defaultQualitySelect: requireElement<HTMLSelectElement>('default-quality-select'),
  includeVttToggle: requireElement<HTMLInputElement>('include-vtt-toggle'),
  lecturesContainer: requireElement<HTMLDivElement>('lectures-container'),
  materialsSelectAllBtn: requireElement<HTMLButtonElement>('materials-select-all-btn'),
  materialsSelectNoneBtn: requireElement<HTMLButtonElement>('materials-select-none-btn'),
  materialsContainer: requireElement<HTMLDivElement>('materials-container'),
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

const GENERIC_TYPE_HINTS = new Set(['slides', 'doc', 'sheet', 'archive', 'folder']);

function formatMaterialTypeBadge(material: CourseMaterialActivity): string {
  const hint = material.fileTypeHint?.toLowerCase() ?? '';
  switch (hint) {
    case 'pdf':
      return 'PDF';
    case 'ppt':
    case 'pptx':
    case 'odp':
    case 'key':
    case 'slides':
      return 'Slides';
    case 'doc':
    case 'docx':
    case 'odt':
    case 'rtf':
      return 'Doc';
    case 'xls':
    case 'xlsx':
    case 'ods':
    case 'csv':
    case 'tsv':
    case 'sheet':
      return hint === 'csv' || hint === 'tsv' ? hint.toUpperCase() : 'Sheet';
    case 'zip':
    case 'rar':
    case '7z':
    case 'tar':
    case 'gz':
    case 'tgz':
    case 'archive':
      return 'Archive';
    case 'folder':
      return 'Folder';
    default:
      return hint ? hint.toUpperCase() : 'File';
  }
}

function inferInitialMaterialExtension(material: CourseMaterialActivity): string {
  const hint = material.fileTypeHint?.toLowerCase() ?? '';
  if (!hint || GENERIC_TYPE_HINTS.has(hint)) {
    return 'bin';
  }
  return hint;
}

function updateContentTabCounts(): void {
  const videoCount = state.lecturesByCmid.size;
  const materialCount = state.materialsByCmid.size;
  dom.tabVideos.textContent = `Videos (${videoCount})`;
  dom.tabMaterials.textContent = `Materials (${materialCount})`;
}

function setActiveContentTab(tab: 'videos' | 'materials'): void {
  state.activeContentTab = tab;
  const isVideos = tab === 'videos';

  dom.tabVideos.setAttribute('aria-selected', String(isVideos));
  dom.tabVideos.tabIndex = isVideos ? 0 : -1;
  dom.tabMaterials.setAttribute('aria-selected', String(!isVideos));
  dom.tabMaterials.tabIndex = isVideos ? -1 : 0;

  dom.videosTabpanel.hidden = !isVideos;
  dom.materialsTabpanel.hidden = isVideos;
}

function updateSelectionSummary(): void {
  let selectedVideoCount = 0;
  let downloadableVideoCount = 0;
  let unresolvedVideoCount = 0;
  let totalBytes = 0;

  for (const entry of state.lecturesByCmid.values()) {
    if (!entry.selected) {
      continue;
    }
    selectedVideoCount += 1;
    if (!entry.resolved && !entry.error) {
      unresolvedVideoCount += 1;
      continue;
    }
    if (isEntryDownloadable(entry)) {
      downloadableVideoCount += 1;
      const flavor = getSelectedFlavor(entry);
      if (flavor && flavor.sizeBytes > 0) {
        totalBytes += flavor.sizeBytes;
      }
    }
  }

  let selectedMaterialCount = 0;
  let downloadableMaterialCount = 0;
  let loadingFolderCount = 0;

  for (const entry of state.materialsByCmid.values()) {
    if (entry.material.type === 'resource') {
      if (entry.selected) {
        selectedMaterialCount += 1;
        downloadableMaterialCount += 1;
      }
      continue;
    }

    if (entry.folderLoaded) {
      for (const fileEntry of entry.folderFiles) {
        if (fileEntry.selected) {
          selectedMaterialCount += 1;
          downloadableMaterialCount += 1;
        }
      }
    } else if (entry.selected) {
      selectedMaterialCount += 1;
      if (entry.folderLoading || !entry.folderError) {
        loadingFolderCount += 1;
      }
    }
  }

  const totalSelectedCount = selectedVideoCount + selectedMaterialCount;
  const unresolvedTotal = unresolvedVideoCount + loadingFolderCount;
  const downloadableTotal = downloadableVideoCount + downloadableMaterialCount;

  dom.selectionCount.textContent = `${totalSelectedCount} selected`;
  const parts: string[] = [];
  if (totalBytes > 0) {
    parts.push(`Est. ${formatFileSize(totalBytes)}`);
  }
  if (downloadableMaterialCount > 0) {
    parts.push(
      `${downloadableMaterialCount} material${downloadableMaterialCount === 1 ? '' : 's'}`,
    );
  }
  if (unresolvedTotal > 0) {
    parts.push(`Resolving ${unresolvedTotal} selected…`);
  }
  dom.selectionSize.textContent = parts.join(' · ');

  dom.downloadSelectedBtn.textContent = state.enqueuing ? 'Queuing…' : 'Download Selected';
  dom.downloadSelectedBtn.disabled =
    state.enqueuing || unresolvedTotal > 0 || downloadableTotal === 0;
}

function updateLectureRow(cmid: number): void {
  const refs = lectureRowsByCmid.get(cmid);
  const entry = state.lecturesByCmid.get(cmid);
  if (!refs || !entry) {
    return;
  }

  const activity = entry.activity;
  const nonDownloadableResolved = entry.resolved !== null && !isEntryDownloadable(entry);
  const failedResolution = entry.error !== null;

  refs.checkbox.checked = entry.selected;
  refs.checkbox.disabled = nonDownloadableResolved || failedResolution;

  // Rebuild only the status/metadata badges inside this row — leaves focus & <select> untouched
  const metaNodes: Node[] = [];
  const typeBadge = document.createElement('span');
  typeBadge.className = 'badge';
  typeBadge.textContent =
    activity.type === 'kalvidres' ? 'Kaltura' : `Moodle ${activity.type}`;
  metaNodes.push(typeBadge);

  if (entry.resolving) {
    refs.checkbox.removeAttribute('aria-describedby');
    const loading = document.createElement('span');
    loading.textContent = 'Resolving stream…';
    metaNodes.push(loading);
  } else if (entry.error) {
    const errId = `lecture-err-${activity.cmid}`;
    const errSpan = document.createElement('span');
    errSpan.id = errId;
    errSpan.className = 'badge badge-err';
    errSpan.textContent = entry.error;
    metaNodes.push(errSpan);
    refs.checkbox.setAttribute('aria-describedby', errId);

    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'btn btn-sm';
    retryBtn.textContent = 'Retry';
    retryBtn.setAttribute('aria-label', `Retry ${activity.title}`);
    retryBtn.addEventListener('click', () => {
      entry.error = null;
      void resolveSingleLecture(entry, state.scanGeneration);
    });
    metaNodes.push(retryBtn);
  } else if (entry.resolved) {
    refs.checkbox.removeAttribute('aria-describedby');
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

function updateMaterialRow(cmid: number): void {
  const refs = materialRowsByCmid.get(cmid);
  const entry = state.materialsByCmid.get(cmid);
  if (!refs || !entry) {
    return;
  }

  const { material } = entry;
  if (material.type === 'resource') {
    refs.checkbox.checked = entry.selected;
    refs.checkbox.indeterminate = false;
    refs.checkbox.disabled = false;

    const metaNodes: Node[] = [];
    const typeBadge = document.createElement('span');
    typeBadge.className = 'badge';
    typeBadge.textContent = formatMaterialTypeBadge(material);
    metaNodes.push(typeBadge);

    if (material.detailsText) {
      const details = document.createElement('span');
      details.textContent = material.detailsText;
      metaNodes.push(details);
    }

    refs.metaEl.replaceChildren(...metaNodes);
    return;
  }

  // mod_folder row
  if (entry.folderLoaded) {
    const selectedFiles = entry.folderFiles.filter((f) => f.selected).length;
    const totalFiles = entry.folderFiles.length;
    refs.checkbox.checked = totalFiles > 0 && selectedFiles === totalFiles;
    refs.checkbox.indeterminate = selectedFiles > 0 && selectedFiles < totalFiles;
    refs.checkbox.disabled = totalFiles === 0;
    entry.selected = refs.checkbox.checked;
  } else {
    refs.checkbox.checked = entry.selected;
    refs.checkbox.indeterminate = false;
    refs.checkbox.disabled = entry.folderError !== null;
  }

  const metaNodes: Node[] = [];
  const folderBadge = document.createElement('span');
  folderBadge.className = 'badge';
  folderBadge.textContent = entry.folderLoaded
    ? `Folder · ${entry.folderFiles.length} file${entry.folderFiles.length === 1 ? '' : 's'}`
    : 'Folder';
  metaNodes.push(folderBadge);

  if (entry.folderLoading) {
    const loading = document.createElement('span');
    loading.textContent = 'Loading files…';
    metaNodes.push(loading);
  } else if (entry.folderError) {
    const errSpan = document.createElement('span');
    errSpan.className = 'badge badge-err';
    errSpan.textContent = entry.folderError;
    metaNodes.push(errSpan);

    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'btn btn-sm';
    retryBtn.textContent = 'Retry';
    retryBtn.setAttribute('aria-label', `Retry loading ${material.title}`);
    retryBtn.addEventListener('click', () => {
      entry.folderError = null;
      void loadFolderFiles(entry, state.scanGeneration, { selectAllOnLoad: entry.selected });
    });
    metaNodes.push(retryBtn);
  } else if (material.detailsText) {
    const details = document.createElement('span');
    details.textContent = material.detailsText;
    metaNodes.push(details);
  }
  refs.metaEl.replaceChildren(...metaNodes);

  if (refs.expandBtn) {
    refs.expandBtn.disabled = entry.folderLoading;
    refs.expandBtn.setAttribute('aria-expanded', String(entry.folderExpanded));
    if (!entry.folderLoaded) {
      refs.expandBtn.textContent = entry.folderLoading ? 'Loading…' : 'Load files';
      refs.expandBtn.setAttribute('aria-label', `Load files for ${material.title}`);
    } else if (entry.folderExpanded) {
      refs.expandBtn.textContent = 'Hide files';
      refs.expandBtn.setAttribute('aria-label', `Hide files for ${material.title}`);
    } else {
      refs.expandBtn.textContent = 'Show files';
      refs.expandBtn.setAttribute('aria-label', `Show files for ${material.title}`);
    }
  }

  if (refs.filesContainerEl) {
    if (!entry.folderExpanded || !entry.folderLoaded) {
      refs.filesContainerEl.hidden = true;
      refs.filesContainerEl.replaceChildren();
    } else {
      refs.filesContainerEl.hidden = false;
      if (entry.folderFiles.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'muted-caption';
        empty.textContent = 'No downloadable files found in this folder.';
        refs.filesContainerEl.replaceChildren(empty);
      } else {
        const fileList = document.createElement('ul');
        fileList.className = 'material-folder-files';

        for (const fileEntry of entry.folderFiles) {
          const itemLi = document.createElement('li');
          itemLi.className = 'material-folder-file-row';

          const chk = document.createElement('input');
          chk.type = 'checkbox';
          chk.id = `folder-file-chk-${material.cmid}-${fileEntry.file.fileIndex}`;
          chk.checked = fileEntry.selected;
          chk.addEventListener('change', () => {
            fileEntry.selected = chk.checked;
            updateMaterialRow(material.cmid);
            updateSelectionSummary();
          });

          const fileInfo = document.createElement('div');
          fileInfo.className = 'material-folder-file-info';

          const label = document.createElement('label');
          label.className = 'material-folder-file-name';
          label.htmlFor = chk.id;
          label.textContent = fileEntry.file.name;
          fileInfo.appendChild(label);

          if (fileEntry.file.subPath.length > 0) {
            const subSpan = document.createElement('span');
            subSpan.className = 'material-subpath';
            subSpan.textContent = fileEntry.file.subPath.join(' / ');
            fileInfo.appendChild(subSpan);
          }

          const extBadge = document.createElement('span');
          extBadge.className = 'badge';
          extBadge.textContent = `.${fileEntry.file.ext}`;
          fileInfo.appendChild(extBadge);

          itemLi.append(chk, fileInfo);
          fileList.appendChild(itemLi);
        }

        refs.filesContainerEl.replaceChildren(fileList);
      }
    }
  }
}

function renderMaterialsStructure(): void {
  dom.materialsContainer.replaceChildren();
  materialRowsByCmid.clear();

  if (!state.selectedCourse) {
    updateContentTabCounts();
    updateSelectionSummary();
    return;
  }

  updateContentTabCounts();

  if (state.materialSections.length === 0) {
    const p = document.createElement('p');
    p.className = 'empty-state';
    p.textContent = 'No static course materials (PDFs, slides, folders) found in this course.';
    dom.materialsContainer.appendChild(p);
    updateSelectionSummary();
    return;
  }

  for (const section of state.materialSections) {
    const group = document.createElement('div');
    group.className = 'section-group';

    const header = document.createElement('div');
    header.className = 'section-header';

    const secTitle = document.createElement('span');
    secTitle.textContent = `${String(section.sectionIndex).padStart(2, '0')} · ${section.title}`;

    const secCount = document.createElement('span');
    secCount.className = 'badge';
    secCount.textContent = `${section.materials.length}`;

    header.append(secTitle, secCount);
    group.appendChild(header);

    const list = document.createElement('ul');
    list.className = 'lecture-list';

    for (const material of section.materials) {
      const entry = state.materialsByCmid.get(material.cmid);
      if (!entry) {
        continue;
      }

      const li = document.createElement('li');
      li.className = 'lecture-row';

      const mainRow = document.createElement('div');
      mainRow.className = 'lecture-main';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.id = `material-chk-${material.cmid}`;
      checkbox.addEventListener('change', () => {
        if (material.type === 'resource') {
          entry.selected = checkbox.checked;
          updateSelectionSummary();
          return;
        }

        entry.selected = checkbox.checked;
        if (entry.folderLoaded) {
          for (const f of entry.folderFiles) {
            f.selected = checkbox.checked;
          }
          updateMaterialRow(material.cmid);
          updateSelectionSummary();
        } else if (checkbox.checked) {
          entry.folderExpanded = true;
          updateMaterialRow(material.cmid);
          updateSelectionSummary();
          void loadFolderFiles(entry, state.scanGeneration, { selectAllOnLoad: true });
        } else {
          updateMaterialRow(material.cmid);
          updateSelectionSummary();
        }
      });

      const info = document.createElement('div');
      info.className = 'lecture-info';

      const titleLabel = document.createElement('label');
      titleLabel.className = 'lecture-title';
      titleLabel.htmlFor = checkbox.id;
      titleLabel.textContent = material.title;

      const metaEl = document.createElement('div');
      metaEl.className = 'lecture-meta';

      info.append(titleLabel, metaEl);
      mainRow.append(checkbox, info);

      let expandBtn: HTMLButtonElement | null = null;
      let filesContainerEl: HTMLDivElement | null = null;

      if (material.type === 'folder') {
        expandBtn = document.createElement('button');
        expandBtn.type = 'button';
        expandBtn.className = 'btn btn-ghost btn-sm';
        expandBtn.addEventListener('click', () => {
          if (!entry.folderLoaded && !entry.folderLoading) {
            entry.folderExpanded = true;
            entry.folderError = null;
            updateMaterialRow(material.cmid);
            void loadFolderFiles(entry, state.scanGeneration, { selectAllOnLoad: entry.selected });
          } else {
            entry.folderExpanded = !entry.folderExpanded;
            updateMaterialRow(material.cmid);
          }
        });
        mainRow.appendChild(expandBtn);

        filesContainerEl = document.createElement('div');
        filesContainerEl.hidden = true;
      }

      li.appendChild(mainRow);
      if (filesContainerEl) {
        li.appendChild(filesContainerEl);
      }
      list.appendChild(li);

      materialRowsByCmid.set(material.cmid, {
        rowEl: li,
        checkbox,
        metaEl,
        expandBtn,
        filesContainerEl,
      });
      updateMaterialRow(material.cmid);
    }

    group.appendChild(list);
    dom.materialsContainer.appendChild(group);
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

function getQueueExtensionTag(item: DownloadQueueItem): string {
  if (item.kind === 'subtitle') {
    return '.vtt';
  }
  const base = item.filename.split('/').pop() ?? item.filename;
  const dotIdx = base.lastIndexOf('.');
  if (dotIdx > 0 && dotIdx < base.length - 1) {
    const ext = base.slice(dotIdx).toLowerCase();
    return ext === '.bin' && item.kind === 'material' ? 'file' : ext;
  }
  return item.kind === 'video' ? '.mp4' : 'file';
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

  const kindTag = getQueueExtensionTag(item);
  if (item.totalBytes > 0) {
    const receivedLabel = item.bytesReceived > 0 ? formatFileSize(item.bytesReceived) : '0 B';
    refs.bytesTextEl.textContent = `${kindTag} · ${receivedLabel} / ${formatFileSize(item.totalBytes)}`;
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

function loadFolderFiles(
  entry: MaterialUiState,
  generation: number,
  options: { selectAllOnLoad: boolean } = { selectAllOnLoad: false },
): Promise<void> {
  if (entry.folderLoaded) {
    if (options.selectAllOnLoad) {
      for (const f of entry.folderFiles) {
        f.selected = true;
      }
      updateMaterialRow(entry.material.cmid);
      updateSelectionSummary();
    }
    return Promise.resolve();
  }

  const existing = state.inFlightFolderResolves.get(entry.material.cmid);
  if (existing) {
    return existing;
  }

  const promise = (async () => {
    entry.folderLoading = true;
    entry.folderError = null;
    updateMaterialRow(entry.material.cmid);
    updateSelectionSummary();

    try {
      const res = await sendExtensionMessage({
        type: 'RESOLVE_FOLDER_FILES',
        material: entry.material,
      });
      if (state.scanGeneration !== generation) {
        return;
      }
      const selectAll = options.selectAllOnLoad || entry.selected;
      entry.folderFiles = res.files.map((file) => ({
        file,
        selected: selectAll,
      }));
      entry.folderLoaded = true;
      entry.folderLoading = false;
      if (entry.folderFiles.length === 0) {
        entry.selected = false;
      }
    } catch (err) {
      if (state.scanGeneration !== generation) {
        return;
      }
      entry.folderLoading = false;
      entry.selected = false;
      entry.folderError = err instanceof Error ? err.message : 'Failed to load folder files';
    } finally {
      state.inFlightFolderResolves.delete(entry.material.cmid);
    }

    if (state.scanGeneration === generation) {
      updateMaterialRow(entry.material.cmid);
      updateSelectionSummary();
    }
  })();

  state.inFlightFolderResolves.set(entry.material.cmid, promise);
  return promise;
}

async function selectCourse(course: EnrolledCourse): Promise<void> {
  showAlert(null);
  state.selectedCourse = course;
  state.sections = [];
  state.materialSections = [];
  state.lecturesByCmid.clear();
  state.materialsByCmid.clear();
  state.inFlightResolves.clear();
  state.inFlightFolderResolves.clear();
  lectureRowsByCmid.clear();
  materialRowsByCmid.clear();
  const generation = ++state.scanGeneration;

  renderCourseList();
  dom.lecturesPanel.hidden = false;
  dom.selectedCourseLabel.textContent = `${course.courseCode ? `${course.courseCode} — ` : ''}${course.title}`;
  updateContentTabCounts();

  dom.lecturesContainer.replaceChildren();
  const loading = document.createElement('p');
  loading.className = 'empty-state';
  loading.textContent = 'Scanning course sections for lectures and materials…';
  dom.lecturesContainer.appendChild(loading);

  dom.materialsContainer.replaceChildren();
  const matLoading = document.createElement('p');
  matLoading.className = 'empty-state';
  matLoading.textContent = 'Scanning course sections for static materials…';
  dom.materialsContainer.appendChild(matLoading);

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
    state.materialSections = res.materialSections ?? [];

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

    for (const section of state.materialSections) {
      for (const material of section.materials) {
        state.materialsByCmid.set(material.cmid, {
          material,
          selected: false,
          folderExpanded: false,
          folderLoading: false,
          folderLoaded: false,
          folderError: null,
          folderFiles: [],
        });
      }
    }

    if (allActivities.length === 0 && state.materialsByCmid.size > 0) {
      setActiveContentTab('materials');
    } else if (allActivities.length > 0 && state.materialsByCmid.size === 0) {
      setActiveContentTab('videos');
    }

    renderLecturesStructure();
    renderMaterialsStructure();
    if (allActivities.length > 0) {
      await resolveLecturesBounded(allActivities, generation);
    }
  } catch (err) {
    if (state.scanGeneration !== generation) {
      return;
    }
    showAlert(err instanceof Error ? err.message : 'Failed to scan course content.');
    renderLecturesStructure();
    renderMaterialsStructure();
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

    const pendingFolders: MaterialUiState[] = [];
    for (const entry of state.materialsByCmid.values()) {
      if (
        entry.material.type === 'folder' &&
        entry.selected &&
        !entry.folderLoaded &&
        !entry.folderError
      ) {
        pendingFolders.push(entry);
      }
    }
    if (pendingFolders.length > 0) {
      await Promise.all(
        pendingFolders.map((entry) =>
          loadFolderFiles(entry, generation, { selectAllOnLoad: true }),
        ),
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
          const baseCounts = new Map<string, number>();
          for (const caption of entry.resolved.captions) {
            const base = (caption.languageCode || caption.label).trim().toLowerCase();
            baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);
          }
          const usedSuffixes = new Set<string>();

          for (const caption of entry.resolved.captions) {
            const baseSuffix = (caption.languageCode || caption.label).trim();
            const baseKey = baseSuffix.toLowerCase();
            let langSuffix = baseSuffix;
            if ((baseCounts.get(baseKey) ?? 0) > 1) {
              const labelPart = caption.label.trim();
              langSuffix =
                labelPart && labelPart.toLowerCase() !== baseKey
                  ? `${baseSuffix}-${labelPart}`
                  : `${baseSuffix}-${caption.index + 1}`;
            }
            if (usedSuffixes.has(langSuffix.toLowerCase())) {
              langSuffix = `${baseSuffix}-${caption.index + 1}`;
            }
            usedSuffixes.add(langSuffix.toLowerCase());

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

    for (const section of state.materialSections) {
      for (const material of section.materials) {
        const entry = state.materialsByCmid.get(material.cmid);
        if (!entry) {
          continue;
        }

        if (material.type === 'resource') {
          if (!entry.selected) {
            continue;
          }
          const initialExt = inferInitialMaterialExtension(material);
          const materialPath = buildMaterialDownloadPath({
            academicYear: course.academicYear,
            courseCode: course.courseCode,
            courseTitle: course.title,
            sectionIndex: section.sectionIndex,
            sectionTitle: section.title,
            activityIndex: material.activityIndex,
            materialTitle: material.title,
            ext: initialExt,
          });

          items.push({
            cmid: material.cmid,
            courseId: course.id,
            lectureTitle: material.title,
            filename: materialPath,
            kind: 'material',
            descriptor: {
              kind: 'material',
              material,
              filename: materialPath,
              pathContext: {
                academicYear: course.academicYear,
                courseCode: course.courseCode,
                courseTitle: course.title,
              },
            },
          });
          continue;
        }

        if (!entry.folderLoaded) {
          continue;
        }
        for (const fileEntry of entry.folderFiles) {
          if (!fileEntry.selected) {
            continue;
          }
          const folderFilePath = buildMaterialDownloadPath({
            academicYear: course.academicYear,
            courseCode: course.courseCode,
            courseTitle: course.title,
            sectionIndex: section.sectionIndex,
            sectionTitle: section.title,
            activityIndex: material.activityIndex,
            materialTitle: material.title,
            folderName: material.title,
            subPath: fileEntry.file.subPath,
            fileName: fileEntry.file.name,
            ext: fileEntry.file.ext,
          });

          items.push({
            cmid: material.cmid,
            courseId: course.id,
            lectureTitle: `${material.title} / ${fileEntry.file.name}`,
            filename: folderFilePath,
            kind: 'material',
            descriptor: {
              kind: 'material',
              material,
              filename: folderFilePath,
              folderFileIndex: fileEntry.file.fileIndex,
              expectedFileName: fileEntry.file.name,
              pathContext: {
                academicYear: course.academicYear,
                courseCode: course.courseCode,
                courseTitle: course.title,
              },
            },
          });
        }
      }
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
        state.materialSections = [];
        state.lecturesByCmid.clear();
        state.materialsByCmid.clear();
        state.inFlightResolves.clear();
        state.inFlightFolderResolves.clear();
        populateAcademicYearFilter();
        renderLecturesStructure();
        renderMaterialsStructure();
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

  const handleTabKeydown = (event: KeyboardEvent) => {
    if (
      event.key !== 'ArrowLeft' &&
      event.key !== 'ArrowRight' &&
      event.key !== 'Home' &&
      event.key !== 'End'
    ) {
      return;
    }
    event.preventDefault();
    const nextTab: 'videos' | 'materials' =
      event.key === 'Home'
        ? 'videos'
        : event.key === 'End'
          ? 'materials'
          : state.activeContentTab === 'videos'
            ? 'materials'
            : 'videos';
    setActiveContentTab(nextTab);
    (nextTab === 'videos' ? dom.tabVideos : dom.tabMaterials).focus();
  };

  dom.tabVideos.addEventListener('click', () => {
    setActiveContentTab('videos');
  });
  dom.tabMaterials.addEventListener('click', () => {
    setActiveContentTab('materials');
  });
  dom.tabVideos.addEventListener('keydown', handleTabKeydown);
  dom.tabMaterials.addEventListener('keydown', handleTabKeydown);

  dom.materialsSelectAllBtn.addEventListener('click', () => {
    for (const [cmid, entry] of state.materialsByCmid.entries()) {
      if (entry.material.type === 'resource') {
        entry.selected = true;
        updateMaterialRow(cmid);
      } else if (entry.folderLoaded) {
        entry.selected = entry.folderFiles.length > 0;
        for (const f of entry.folderFiles) {
          f.selected = true;
        }
        updateMaterialRow(cmid);
      } else if (!entry.folderError) {
        entry.selected = true;
        entry.folderExpanded = true;
        updateMaterialRow(cmid);
        void loadFolderFiles(entry, state.scanGeneration, { selectAllOnLoad: true });
      }
    }
    updateSelectionSummary();
  });

  dom.materialsSelectNoneBtn.addEventListener('click', () => {
    for (const [cmid, entry] of state.materialsByCmid.entries()) {
      entry.selected = false;
      for (const f of entry.folderFiles) {
        f.selected = false;
      }
      updateMaterialRow(cmid);
    }
    updateSelectionSummary();
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
