import { parse, type HTMLElement } from 'node-html-parser';
import {
  DEFAULT_MOODLE_BASE_URL,
  type CourseSection,
  type LectureActivity,
  type LectureActivityType,
} from './types.js';

const SUPPORTED_MOD_TYPES: ReadonlyArray<LectureActivityType> = ['kalvidres', 'videotime', 'resource'];

const TRAILING_VIDEO_EXT_PATTERN = /\.(mp4|m4v|webm|mov)\s*$/i;
const VIDEO_EXT_PATTERN = /\.(mp4|m4v|webm|mov)(?:\b|$)/i;
const VIDEO_ICON_PATTERN = /(?:\/f\/mpeg|\/f\/video|video-icon|icon-video)/i;
const NON_VIDEO_ICON_PATTERN = /(?:\/f\/pdf|\/f\/powerpoint|\/f\/document|\/f\/spreadsheet|\/f\/archive|\/f\/text)/i;
const NON_VIDEO_EXT_PATTERN = /\.(pdf|pptx?|docx?|xlsx?|zip|rar|csv|txt|r|rmd|sav|jasp)\s*$/i;

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

function detectActivityType(activityEl: HTMLElement, linkHref: string | null): LectureActivityType | null {
  const classes = (activityEl.getAttribute('class') ?? '').split(/\s+/);
  for (const modType of SUPPORTED_MOD_TYPES) {
    if (classes.includes(`modtype_${modType}`)) {
      return modType;
    }
  }

  if (linkHref) {
    const hrefMatch = linkHref.match(/\/mod\/(kalvidres|videotime|resource)\/view\.php/i);
    const matched = hrefMatch?.[1]?.toLowerCase();
    if (matched === 'kalvidres' || matched === 'videotime' || matched === 'resource') {
      return matched;
    }
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
 * Extracts `mod_kalvidres`, `mod_videotime`, and video-hinted `mod_resource`
 * activities grouped by `li.section.course-section[data-sectionid]`.
 */
export function parseCourseSectionsFromHtml(
  html: string,
  courseId: number,
  baseUrl: string = DEFAULT_MOODLE_BASE_URL,
): CourseSection[] {
  const root = parse(html);
  const regionMain = root.querySelector('#region-main');
  if (!regionMain) {
    return [];
  }

  const sectionElements = regionMain.querySelectorAll('li.section.course-section[data-sectionid]');
  const sections: CourseSection[] = [];

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
      const title =
        extractCleanText(instanceNameEl) ||
        extractCleanText(linkEl) ||
        `Lecture ${cmid}`;

      if (type === 'resource' && !isVideoHintedResource(activityEl, title, rawHref)) {
        continue;
      }

      const url = rawHref
        ? resolveUrl(rawHref, baseUrl)
        : resolveUrl(`/mod/${type}/view.php?id=${cmid}`, baseUrl);

      seenCmids.add(cmid);
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
  }

  return sections;
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
