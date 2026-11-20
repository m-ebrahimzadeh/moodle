import { parse, type HTMLElement } from 'node-html-parser';
import {
  DEFAULT_MOODLE_BASE_URL,
  type CourseContentScan,
  type CourseMaterialActivity,
  type CourseMaterialSection,
  type CourseSection,
  type FolderFileEntry,
  type LectureActivity,
  type LectureActivityType,
  type MaterialActivityType,
} from './types.js';

const SUPPORTED_MOD_TYPES: ReadonlyArray<LectureActivityType | 'folder'> = [
  'kalvidres',
  'videotime',
  'resource',
  'folder',
];

const TRAILING_VIDEO_EXT_PATTERN = /\.(mp4|m4v|webm|mov)\s*$/i;
const VIDEO_EXT_PATTERN = /\.(mp4|m4v|webm|mov)(?:\b|$)/i;
const VIDEO_ICON_PATTERN = /(?:\/f\/mpeg|\/f\/video|video-icon|icon-video)/i;
const NON_VIDEO_ICON_PATTERN = /(?:\/f\/pdf|\/f\/powerpoint|\/f\/document|\/f\/spreadsheet|\/f\/archive|\/f\/text)/i;
const NON_VIDEO_EXT_PATTERN = /\.(pdf|pptx?|docx?|xlsx?|zip|rar|csv|txt|r|rmd|sav|jasp)\s*$/i;

const KNOWN_MATERIAL_EXTENSIONS = new Set([
  'pdf',
  'ppt',
  'pptx',
  'odp',
  'key',
  'doc',
  'docx',
  'odt',
  'rtf',
  'xls',
  'xlsx',
  'ods',
  'csv',
  'tsv',
  'zip',
  'rar',
  '7z',
  'tar',
  'gz',
  'tgz',
  'txt',
  'md',
  'r',
  'rmd',
  'rds',
  'rdata',
  'sav',
  'zsav',
  'jasp',
  'sps',
  'do',
  'dta',
  'py',
  'ipynb',
  'm',
  'json',
  'xml',
  'html',
  'htm',
  'epub',
  'png',
  'jpg',
  'jpeg',
  'svg',
  'gif',
  'mp3',
  'wav',
]);

function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

function resolveUrl(href: string, baseUrl: string): string {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
}

function extractCleanText(element: HTMLElement | null): string {
  if (!element) {
    return '';
  }

  // Clone-free clean extraction: remove `.accesshide` / `.sr-only` text spans
  const cloned = parse(element.outerHTML);
  for (const hidden of cloned.querySelectorAll('.accesshide, .sr-only')) {
    hidden.remove();
  }
  return normalizeWhitespace(cloned.textContent);
}

function detectActivityType(
  activityEl: HTMLElement,
  linkHref: string | null,
): LectureActivityType | 'folder' | null {
  const classes = (activityEl.getAttribute('class') ?? '').split(/\s+/);
  for (const modType of SUPPORTED_MOD_TYPES) {
    if (classes.includes(`modtype_${modType}`)) {
      return modType;
    }
  }

  if (linkHref) {
    const hrefMatch = linkHref.match(/\/mod\/(kalvidres|videotime|resource|folder)\/view\.php/i);
    const matched = hrefMatch?.[1]?.toLowerCase();
    if (
      matched === 'kalvidres' ||
      matched === 'videotime' ||
      matched === 'resource' ||
      matched === 'folder'
    ) {
      return matched;
    }
  }

  return null;
}

function extractTrailingKnownExtension(input: string | null | undefined): string | null {
  if (!input) {
    return null;
  }
  const clean = input.split(/[?#]/)[0]?.trim() ?? '';
  const match = clean.match(/\.([a-zA-Z0-9]{1,8})\s*$/);
  const ext = match?.[1]?.toLowerCase();
  if (ext && KNOWN_MATERIAL_EXTENSIONS.has(ext)) {
    return ext;
  }
  return null;
}

function extractMaterialFileTypeHint(
  activityEl: HTMLElement,
  title: string,
  linkHref: string | null,
  detailsText: string | null,
  type: MaterialActivityType,
): string | null {
  if (type === 'folder') {
    return 'folder';
  }

  const titleExt = extractTrailingKnownExtension(title);
  if (titleExt) {
    return titleExt;
  }

  const hrefExt = extractTrailingKnownExtension(linkHref);
  if (hrefExt) {
    return hrefExt;
  }

  const iconEl = activityEl.querySelector('img.activityicon, img.icon');
  const iconSrc = (iconEl?.getAttribute('src') ?? '').toLowerCase();
  const detailsLower = (detailsText ?? '').toLowerCase();

  if (iconSrc.includes('/f/pdf') || /\bpdf\b/.test(detailsLower)) {
    return 'pdf';
  }
  if (
    iconSrc.includes('/f/powerpoint') ||
    /\b(powerpoint|presentation|slides)\b/.test(detailsLower)
  ) {
    return 'slides';
  }
  if (iconSrc.includes('/f/document') || /\b(word|document)\b/.test(detailsLower)) {
    return 'doc';
  }
  if (
    iconSrc.includes('/f/spreadsheet') ||
    /\b(excel|spreadsheet|csv)\b/.test(detailsLower)
  ) {
    return 'sheet';
  }
  if (iconSrc.includes('/f/archive') || /\b(zip|archive|compressed)\b/.test(detailsLower)) {
    return 'archive';
  }
  if (iconSrc.includes('/f/text') || /\bplain text\b/.test(detailsLower)) {
    return 'txt';
  }

  return null;
}

function isVideoHintedResource(activityEl: HTMLElement, title: string, linkHref: string | null): boolean {
  const detailsText = normalizeWhitespace(
    activityEl.querySelector('.resourcelinkdetails')?.textContent ?? '',
  );
  const badgeText = normalizeWhitespace(
    activityEl.querySelector('.activitybadge')?.textContent ?? '',
  );
  const iconEl = activityEl.querySelector('img.activityicon, img.icon');
  const iconSrc = iconEl?.getAttribute('src') ?? '';
  const iconAlt = iconEl?.getAttribute('alt') ?? '';

  const linkPath = linkHref ? (linkHref.split(/[?#]/)[0] ?? '') : '';
  const hasTrailingVideoExt =
    TRAILING_VIDEO_EXT_PATTERN.test(title) ||
    (linkPath.length > 0 && TRAILING_VIDEO_EXT_PATTERN.test(linkPath));

  // Explicit trailing video extension takes precedence over mid-title non-video tokens
  // (e.g. "Class_1.R.mp4" or "Notes.pdf - Recording.mp4").
  if (hasTrailingVideoExt) {
    return !NON_VIDEO_ICON_PATTERN.test(iconSrc);
  }

  // Positive video signals
  if (
    VIDEO_EXT_PATTERN.test(title) ||
    (linkHref !== null && VIDEO_EXT_PATTERN.test(linkHref)) ||
    VIDEO_ICON_PATTERN.test(iconSrc) ||
    /\b(mp4|video\/mp4|video file|video)\b/i.test(detailsText) ||
    /\b(mp4|video)\b/i.test(badgeText) ||
    /\bvideo\b/i.test(iconAlt)
  ) {
    // Reject obvious PDFs/slides even if the title mentions "video" (e.g. "Video notes.pdf")
    if (NON_VIDEO_ICON_PATTERN.test(iconSrc) || NON_VIDEO_EXT_PATTERN.test(title)) {
      return false;
    }
    return true;
  }

  return false;
}

function extractCmid(activityEl: HTMLElement, linkHref: string | null): number | null {
  const dataId = activityEl.getAttribute('data-id');
  if (dataId && /^\d+$/.test(dataId)) {
    return Number.parseInt(dataId, 10);
  }

  const elId = activityEl.getAttribute('id') ?? '';
  const moduleMatch = elId.match(/^module-(\d+)$/);
  if (moduleMatch?.[1]) {
    return Number.parseInt(moduleMatch[1], 10);
  }

  if (linkHref) {
    const queryMatch = linkHref.match(/[?&]id=(\d+)/);
    if (queryMatch?.[1]) {
      return Number.parseInt(queryMatch[1], 10);
    }
  }

  return null;
}

function extractSectionIndex(sectionEl: HTMLElement, fallbackIndex: number): number {
  const dataSection = sectionEl.getAttribute('data-section') ?? sectionEl.getAttribute('data-number');
  if (dataSection && /^\d+$/.test(dataSection)) {
    return Number.parseInt(dataSection, 10);
  }

  const elId = sectionEl.getAttribute('id') ?? '';
  const idMatch = elId.match(/^section-(\d+)$/);
  if (idMatch?.[1]) {
    return Number.parseInt(idMatch[1], 10);
  }

  return fallbackIndex;
}

/**
 * Parses Moodle 4.5 course HTML strictly scoped to `#region-main` to prevent
 * duplicate captures from the left-hand `#course-index` navigation drawer.
 *
 * Extracts both video lectures (`sections`: `mod_kalvidres`, `mod_videotime`,
 * video-hinted `mod_resource`) and static course materials (`materialSections`:
 * non-video `mod_resource` and `mod_folder`) in a single pass (`0` extra HTTP calls).
 */
export function parseCourseContentFromHtml(
  html: string,
  courseId: number,
  baseUrl: string = DEFAULT_MOODLE_BASE_URL,
): CourseContentScan {
  const root = parse(html);
  const regionMain = root.querySelector('#region-main');
  if (!regionMain) {
    return { sections: [], materialSections: [] };
  }

  const sectionElements = regionMain.querySelectorAll('li.section.course-section[data-sectionid]');
  const sections: CourseSection[] = [];
  const materialSections: CourseMaterialSection[] = [];

  for (let i = 0; i < sectionElements.length; i += 1) {
    const sectionEl = sectionElements[i];
    if (!sectionEl) {
      continue;
    }

    const sectionId = sectionEl.getAttribute('data-sectionid') ?? String(i);
    const sectionIndex = extractSectionIndex(sectionEl, i);
    const sectionNameEl = sectionEl.querySelector('.sectionname');
    const sectionTitle = extractCleanText(sectionNameEl) || `Section ${sectionIndex}`;

    const activityElements = sectionEl.querySelectorAll('li.activity');
    const activities: LectureActivity[] = [];
    const materials: CourseMaterialActivity[] = [];
    const seenCmids = new Set<number>();

    for (const activityEl of activityElements) {
      const linkEl = activityEl.querySelector('a.aalink') ?? activityEl.querySelector('a[href*="/mod/"]');
      const rawHref = linkEl?.getAttribute('href') ?? null;

      const type = detectActivityType(activityEl, rawHref);
      if (!type) {
        continue;
      }

      const cmid = extractCmid(activityEl, rawHref);
      if (cmid === null || seenCmids.has(cmid)) {
        continue;
      }

      const instanceNameEl = activityEl.querySelector('.instancename');
      const fallbackLabel = type === 'folder' ? `Folder ${cmid}` : `Lecture ${cmid}`;
      const title =
        extractCleanText(instanceNameEl) ||
        extractCleanText(linkEl) ||
        fallbackLabel;

      const url = rawHref
        ? resolveUrl(rawHref, baseUrl)
        : resolveUrl(`/mod/${type}/view.php?id=${cmid}`, baseUrl);

      seenCmids.add(cmid);

      if (type === 'folder' || (type === 'resource' && !isVideoHintedResource(activityEl, title, rawHref))) {
        const detailsText =
          normalizeWhitespace(activityEl.querySelector('.resourcelinkdetails')?.textContent ?? '') || null;
        const fileTypeHint = extractMaterialFileTypeHint(activityEl, title, rawHref, detailsText, type);
        materials.push({
          cmid,
          courseId,
          sectionIndex,
          sectionTitle,
          activityIndex: materials.length + 1,
          title,
          type,
          url,
          fileTypeHint,
          detailsText,
        });
        continue;
      }

      activities.push({
        cmid,
        courseId,
        sectionIndex,
        sectionTitle,
        activityIndex: activities.length + 1,
        title,
        type,
        url,
      });
    }

    if (activities.length > 0) {
      sections.push({
        sectionIndex,
        sectionId,
        title: sectionTitle,
        activities,
      });
    }

    if (materials.length > 0) {
      materialSections.push({
        sectionIndex,
        sectionId,
        title: sectionTitle,
        materials,
      });
    }
  }

  return { sections, materialSections };
}

/**
 * Backward-compatible wrapper returning only video lecture sections from
 * `parseCourseContentFromHtml()`.
 */
export function parseCourseSectionsFromHtml(
  html: string,
  courseId: number,
  baseUrl: string = DEFAULT_MOODLE_BASE_URL,
): CourseSection[] {
  return parseCourseContentFromHtml(html, courseId, baseUrl).sections;
}

function resolveSameOriginUrl(candidate: string, baseUrl: string): string | null {
  try {
    const expectedOrigin = new URL(baseUrl).origin;
    const resolved = new URL(candidate, baseUrl);
    if (resolved.protocol !== 'https:' && resolved.protocol !== 'http:') {
      return null;
    }
    if (resolved.origin !== expectedOrigin) {
      return null;
    }
    return resolved.toString();
  } catch {
    return null;
  }
}

/**
 * Extracts a same-origin Moodle-hosted `/pluginfile.php/.../*.mp4` stream URL
 * from a `mod_videotime` or `mod_resource` HTML page. Returns `null` for
 * external/cross-origin embeds (e.g. YouTube) or non-MP4 resources.
 */
export function extractPluginfileMp4Url(
  html: string,
  baseUrl: string = DEFAULT_MOODLE_BASE_URL,
): string | null {
  const root = parse(html);

  // 1. <video><source src=".../pluginfile.php/...mp4"></video>
  const sourceEls = root.querySelectorAll('video source[src], video[src]');
  for (const el of sourceEls) {
    const src = el.getAttribute('src')?.trim();
    if (src && src.includes('/pluginfile.php/') && /\.mp4(?:[?#]|$)/i.test(src)) {
      const validated = resolveSameOriginUrl(src, baseUrl);
      if (validated) {
        return validated;
      }
    }
  }

  // 2. Direct anchor link to Moodle pluginfile MP4
  const linkEls = root.querySelectorAll('a[href*="/pluginfile.php/"]');
  for (const el of linkEls) {
    const href = el.getAttribute('href')?.trim();
    if (href && /\.mp4(?:[?#]|$)/i.test(href)) {
      const validated = resolveSameOriginUrl(href, baseUrl);
      if (validated) {
        return validated;
      }
    }
  }

  // 3. Embedded JSON / VideoJS data-setup attributes or inline script URLs
  const unescaped = html.replace(/\\\//g, '/').replace(/&amp;/g, '&');
  for (const absMatch of unescaped.matchAll(
    /https?:\/\/[^"'\s<>]+\/pluginfile\.php\/[^"'\s<>]+\.mp4(?:\?[^"'\s<>]*)?/gi,
  )) {
    const validated = resolveSameOriginUrl(absMatch[0], baseUrl);
    if (validated) {
      return validated;
    }
  }

  for (const relMatch of unescaped.matchAll(
    /(?:^|["'\s(])((?:\/\/[^"'\s<>]+)?\/pluginfile\.php\/[^"'\s<>]+\.mp4(?:\?[^"'\s<>]*)?)/gi,
  )) {
    const candidate = relMatch[1];
    if (!candidate) {
      continue;
    }
    const validated = resolveSameOriginUrl(candidate, baseUrl);
    if (validated) {
      return validated;
    }
  }

  return null;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function extractFilenameExtension(filename: string): string {
  const clean = filename.split(/[?#]/)[0]?.trim() ?? '';
  const dotIdx = clean.lastIndexOf('.');
  if (dotIdx > 0 && dotIdx < clean.length - 1) {
    const ext = clean.slice(dotIdx + 1).replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    if (ext) {
      return ext;
    }
  }
  return 'bin';
}

function sanitizeHeaderFilenameBasename(raw: string): string | null {
  const normalized = raw.replace(/\\/g, '/').split('/').pop()?.trim() ?? '';
  if (!normalized || normalized === '.' || normalized === '..') {
    return null;
  }
  return normalized;
}

/**
 * Extracts a same-origin `/pluginfile.php/...` target URL from a Moodle
 * `mod_resource` HTML wrapper page (`.resourceworkaround a[href]`, `object[data]`,
 * `embed[src]`, `iframe[src]`, or `#region-main a[href*="/pluginfile.php/"]`).
 */
export function extractPluginfileResourceUrl(
  html: string,
  baseUrl: string = DEFAULT_MOODLE_BASE_URL,
): string | null {
  const root = parse(html);

  const candidates: Array<{ el: HTMLElement; attr: 'href' | 'data' | 'src' }> = [];
  for (const el of root.querySelectorAll('.resourceworkaround a[href]')) {
    candidates.push({ el, attr: 'href' });
  }
  for (const el of root.querySelectorAll('object[data]')) {
    candidates.push({ el, attr: 'data' });
  }
  for (const el of root.querySelectorAll('embed[src]')) {
    candidates.push({ el, attr: 'src' });
  }
  for (const el of root.querySelectorAll('iframe[src]')) {
    candidates.push({ el, attr: 'src' });
  }
  for (const el of root.querySelectorAll('#region-main a[href*="/pluginfile.php/"]')) {
    candidates.push({ el, attr: 'href' });
  }

  for (const { el, attr } of candidates) {
    const raw = el.getAttribute(attr)?.trim();
    if (!raw || !raw.includes('/pluginfile.php/')) {
      continue;
    }
    const validated = resolveSameOriginUrl(raw, baseUrl);
    if (validated) {
      return validated;
    }
  }

  return null;
}

function extractFolderDomSubPath(anchorEl: HTMLElement, stopAt: HTMLElement): string[] {
  const segments: string[] = [];
  let cursor = anchorEl.parentNode as HTMLElement | null;
  let skippedOwnLi = false;

  while (cursor && cursor !== stopAt) {
    if (cursor.tagName === 'LI') {
      if (!skippedOwnLi) {
        skippedOwnLi = true;
      } else {
        const labelEl =
          cursor.querySelector(':scope > span .fp-filename') ??
          cursor.querySelector(':scope > div .fp-filename') ??
          cursor.querySelector(':scope > span');
        const folderLabel = extractCleanText(labelEl);
        if (folderLabel && folderLabel !== '.' && folderLabel !== '..') {
          segments.unshift(folderLabel);
        }
      }
    }
    cursor = cursor.parentNode as HTMLElement | null;
  }

  return segments;
}

/**
 * Parses `mod_folder` HTML strictly scoped to `#region-main`
 * (`.foldertree a[href*="/pluginfile.php/"]` with `#region-main` fallback),
 * enforcing same-origin validation, safe `decodeURIComponent`, subfolder
 * `subPath` preservation, and URL deduplication.
 */
export function parseFolderFilesFromHtml(
  html: string,
  baseUrl: string = DEFAULT_MOODLE_BASE_URL,
): FolderFileEntry[] {
  const root = parse(html);
  const regionMain = root.querySelector('#region-main');
  if (!regionMain) {
    return [];
  }

  const treeEl = regionMain.querySelector('.foldertree');
  const treeAnchors = treeEl
    ? treeEl.querySelectorAll('a[href*="/pluginfile.php/"]')
    : [];
  const anchors =
    treeAnchors.length > 0
      ? treeAnchors
      : regionMain.querySelectorAll('a[href*="/pluginfile.php/"]');

  const entries: FolderFileEntry[] = [];
  const seenUrls = new Set<string>();

  for (const anchorEl of anchors) {
    const href = anchorEl.getAttribute('href')?.trim();
    if (!href) {
      continue;
    }

    const validatedUrl = resolveSameOriginUrl(href, baseUrl);
    if (!validatedUrl) {
      continue;
    }

    let parsed: URL;
    try {
      parsed = new URL(validatedUrl);
    } catch {
      continue;
    }

    const dedupeKey = `${parsed.origin}${parsed.pathname}`;
    if (seenUrls.has(dedupeKey)) {
      continue;
    }
    seenUrls.add(dedupeKey);

    let subPath: string[] = [];
    let fileName = '';

    const folderPathMatch = parsed.pathname.match(/\/mod_folder\/content\/[^/]+\/(.+)$/i);
    if (folderPathMatch?.[1]) {
      const rawSegments = folderPathMatch[1]
        .split('/')
        .map((seg) => safeDecodeURIComponent(seg).trim())
        .filter((seg) => seg.length > 0 && seg !== '.' && seg !== '..');

      if (rawSegments.length > 0) {
        fileName = rawSegments[rawSegments.length - 1] ?? '';
        subPath = rawSegments.slice(0, -1);
      }
    }

    if (!fileName) {
      const lastSeg = parsed.pathname.split('/').pop() ?? '';
      const decodedSeg = safeDecodeURIComponent(lastSeg).trim();
      const domLabel = extractCleanText(anchorEl.querySelector('.fp-filename') ?? anchorEl);
      fileName =
        (decodedSeg && decodedSeg !== '.' && decodedSeg !== '..' ? decodedSeg : '') ||
        domLabel ||
        `file_${entries.length + 1}`;
    }

    if (subPath.length === 0 && treeEl) {
      subPath = extractFolderDomSubPath(anchorEl, treeEl);
    }

    const ext = extractFilenameExtension(fileName);
    entries.push({
      fileIndex: entries.length + 1,
      name: fileName,
      subPath,
      ext,
      url: validatedUrl,
    });
  }

  return entries;
}

/**
 * Safely parses RFC 5987 `filename*=` and standard `filename=` parameters
 * from an HTTP `Content-Disposition` header, stripping any directory traversal.
 */
export function parseContentDispositionFilename(header: string | null): string | null {
  if (!header || !header.trim()) {
    return null;
  }

  // 1. Prefer RFC 5987 `filename*` (e.g. filename*=UTF-8''Week%203%20Slides.pptx)
  const extMatch = header.match(/(?:^|;)\s*filename\*\s*=\s*(?:"([^"]*)"|([^;\r\n]+))/i);
  const rawExtVal = (extMatch?.[1] ?? extMatch?.[2])?.trim();
  if (rawExtVal) {
    const firstQuote = rawExtVal.indexOf("'");
    const secondQuote = firstQuote >= 0 ? rawExtVal.indexOf("'", firstQuote + 1) : -1;
    const encodedPart =
      secondQuote >= 0 ? rawExtVal.slice(secondQuote + 1).trim() : rawExtVal;
    const decoded = safeDecodeURIComponent(encodedPart);
    const clean = sanitizeHeaderFilenameBasename(decoded);
    if (clean) {
      return clean;
    }
  }

  // 2. Fallback to standard quoted or unquoted `filename`
  const quotedMatch = header.match(/(?:^|;)\s*filename\s*=\s*"((?:\\.|[^"\\])*)"/i);
  if (quotedMatch?.[1]) {
    const unescaped = quotedMatch[1].replace(/\\(.)/g, '$1');
    const clean = sanitizeHeaderFilenameBasename(unescaped);
    if (clean) {
      return clean;
    }
  }

  const unquotedMatch = header.match(/(?:^|;)\s*filename\s*=\s*([^;\r\n"]+)/i);
  if (unquotedMatch?.[1]) {
    const clean = sanitizeHeaderFilenameBasename(unquotedMatch[1]);
    if (clean) {
      return clean;
    }
  }

  return null;
}
