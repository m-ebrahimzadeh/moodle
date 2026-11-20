import {
  DEFAULT_MOODLE_BASE_URL,
  UNIPD_SHIBBOLETH_LOGIN_PATH,
  type AcademicYear,
  type EnrolledCourse,
  type MoodleSessionInfo,
  type RawMoodleCourse,
} from './types.js';

interface MoodleAjaxError {
  error: true;
  exception?: {
    errorcode?: string;
    message?: string;
  };
}

interface MoodleAjaxSuccess {
  error: false;
  data?: {
    courses?: RawMoodleCourse[];
    nextoffset?: number;
  };
}

type MoodleAjaxResponseItem = MoodleAjaxError | MoodleAjaxSuccess;

/**
 * Typed error signaling that the active Moodle browser session expired,
 * redirected to login/Shibboleth, fell back to Guest (`userId <= 1`), or
 * rejected `sesskey` (`invalidsesskey` / `requirelogin`).
 */
export class MoodleSessionExpiredError extends Error {
  constructor(message: string = 'Moodle session expired. Please sign in again.') {
    super(message);
    this.name = 'MoodleSessionExpiredError';
  }
}

export function isSessionExpiredError(err: unknown): boolean {
  if (err instanceof MoodleSessionExpiredError) {
    return true;
  }
  if (!(err instanceof Error)) {
    return false;
  }
  return (
    err.name === 'MoodleSessionExpiredError' ||
    /session expired|invalidsesskey|requirelogin/i.test(err.message)
  );
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function getOriginOrDefault(urlString: string): string {
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return parsed.origin;
    }
  } catch {
    // Fallback to default Moodle host if URL cannot be parsed
  }
  return DEFAULT_MOODLE_BASE_URL;
}

function extractMoodleConfigBlock(html: string): string | null {
  const match = html.match(/M\.cfg\s*=\s*(\{[\s\S]*?\})\s*;/);
  return match?.[1] ?? null;
}

function extractSesskey(html: string, cfgBlock: string | null): string | null {
  const source = cfgBlock ?? html;
  const match = source.match(/["']?sesskey["']?\s*:\s*["']([A-Za-z0-9_-]{6,64})["']/);
  return match?.[1] ?? null;
}

function extractUserId(html: string, cfgBlock: string | null): number | null {
  const source = cfgBlock ?? html;
  const match = source.match(/["']?userId["']?\s*:\s*["']?(\d+)["']?/i);
  if (!match?.[1]) {
    return null;
  }
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function hasBodyClass(html: string, className: string): boolean {
  const bodyMatch = html.match(/<body\b[^>]*class=["']([^"']+)["']/i);
  if (!bodyMatch?.[1]) {
    return false;
  }
  return bodyMatch[1].split(/\s+/).includes(className);
}

export function isLoginPageUrl(urlString: string): boolean {
  const lower = urlString.toLowerCase();
  return (
    lower.includes('/login/') ||
    lower.includes('shibidp.cca.unipd.it') ||
    lower.includes('/idp/profile/saml2/') ||
    lower.includes('/auth/shibboleth/')
  );
}

function hasLogoutLink(html: string): boolean {
  return /\/login\/logout\.php\b/i.test(html);
}

function hasLoginIndexLink(html: string): boolean {
  return /href=["'][^"']*\/login\/index\.php(?:\?[^"']*)?["']/i.test(html);
}

function hasGuestAccessText(html: string): boolean {
  return /you are currently using guest access|sei attualmente collegato come ospite|accesso come ospite/i.test(
    html,
  );
}

/**
 * Detects whether a Moodle HTML response represents an unauthenticated, login,
 * or built-in Guest (`userId <= 1`, where `0` = anonymous and `1` = `$CFG->siteguest`)
 * page rather than an authenticated student session.
 */
export function isUnauthenticatedMoodleHtml(html: string, finalUrl: string): boolean {
  if (
    isLoginPageUrl(finalUrl) ||
    hasBodyClass(html, 'notloggedin') ||
    hasBodyClass(html, 'pagelayout-login') ||
    hasBodyClass(html, 'guest') ||
    /<form\b[^>]*\bid=["']login["']/i.test(html) ||
    /<form\b[^>]*\bid=["']user-login-form["']/i.test(html)
  ) {
    return true;
  }

  // Scope M.cfg.userId inspection strictly to Moodle's M.cfg block so non-M.cfg
  // HTML (e.g. Kaltura player_bridge.php PlayKit analytics JSON) cannot trigger
  // false-positive session-expiry errors on unrelated "userId": 0|1 fields.
  const cfgBlock = extractMoodleConfigBlock(html);
  const cfgUserId = cfgBlock !== null ? extractUserId(cfgBlock, cfgBlock) : null;
  if (cfgUserId !== null && cfgUserId <= 1) {
    return true;
  }

  // Only fall back to guest text-phrase heuristics when no positive M.cfg.userId > 1
  // is present, so authenticated course pages mentioning "accesso come ospite" in
  // course syllabi or announcements are not falsely rejected.
  if (cfgUserId === null && hasGuestAccessText(html)) {
    return true;
  }

  // Full Moodle page (contains M.cfg) without userId that links to login but not logout
  if (cfgBlock !== null && cfgUserId === null && hasLoginIndexLink(html) && !hasLogoutLink(html)) {
    return true;
  }

  return false;
}

/**
 * Inspects HTML and final resolved URL from Moodle to determine whether the
 * user has an active authenticated session, along with `userId` and CSRF `sesskey`.
 */
export function extractMoodleSessionInfo(html: string, finalUrl: string): MoodleSessionInfo {
  const origin = isLoginPageUrl(finalUrl) && finalUrl.toLowerCase().includes('shibidp')
    ? DEFAULT_MOODLE_BASE_URL
    : getOriginOrDefault(finalUrl);
  const loginUrl = `${origin}${UNIPD_SHIBBOLETH_LOGIN_PATH}`;

  const cfgBlock = extractMoodleConfigBlock(html);
  const sesskey = extractSesskey(html, cfgBlock);
  const userId = extractUserId(html, cfgBlock);

  if (isUnauthenticatedMoodleHtml(html, finalUrl)) {
    return {
      authenticated: false,
      userId: null,
      sesskey: null,
      loginUrl,
    };
  }

  const hasUserMenu = /class=["'][^"']*\busermenu\b[^"']*["']/i.test(html);
  const hasPositiveAuthSignal =
    userId !== null
      ? userId > 1
      : hasLogoutLink(html) || (hasUserMenu && !hasLoginIndexLink(html));

  const authenticated = Boolean(sesskey && hasPositiveAuthSignal);

  return {
    authenticated,
    userId: authenticated ? userId : null,
    sesskey: authenticated ? sesskey : null,
    loginUrl,
  };
}

function extractAcademicYear(rawCourse: RawMoodleCourse): AcademicYear | null {
  const shortname = rawCourse.shortname.trim();
  const fullname = rawCourse.fullname.trim();
  const category = (rawCourse.coursecategory ?? '').trim();

  // 1a. Full AY range already in shortname (e.g. 2025-2026-...)
  const shortnameRange = shortname.match(/^(20\d{2})-(20\d{2})(?:-|$)/);
  if (shortnameRange?.[1] && shortnameRange[2]) {
    return `${shortnameRange[1]}-${shortnameRange[2]}`;
  }

  // 1b. UniPD shortname prefix (e.g. 2025-PS3049-000ZZ-2025-PSQ4106920-N0-PS3049 -> 2025-2026)
  const shortnameYear = shortname.match(/^(20\d{2})-/);
  if (shortnameYear?.[1]) {
    const startYear = Number.parseInt(shortnameYear[1], 10);
    return `${startYear}-${startYear + 1}`;
  }

  // 2. Fullname trailing/embedded AY token (e.g. ... 2026-2027)
  const fullnameRange = fullname.match(/\b(20\d{2})\s*[-/]\s*(20\d{2})\b/);
  if (fullnameRange?.[1] && fullnameRange[2]) {
    return `${fullnameRange[1]}-${fullnameRange[2]}`;
  }

  // 3. Course category fallback (e.g. A.A. 2025 - 2026)
  const categoryRange = category.match(/\b(20\d{2})\s*[-/]\s*(20\d{2})\b/);
  if (categoryRange?.[1] && categoryRange[2]) {
    return `${categoryRange[1]}-${categoryRange[2]}`;
  }

  return null;
}

function extractCourseCode(rawCourse: RawMoodleCourse): string | null {
  const fullname = rawCourse.fullname.trim();
  const shortname = rawCourse.shortname.trim();

  // 1. Explicit course code prefix in fullname (e.g. "PSQ4107809 - PRINCIPLES...")
  const fullnamePrefix = fullname.match(/^([A-Z]{2,5}\d{5,10})\s*[-–—:]/);
  if (fullnamePrefix?.[1]) {
    return fullnamePrefix[1];
  }

  // 2. UniPD course code in shortname (e.g. "2025-PS3049-000ZZ-2025-PSQ4106920-N0-PS3049")
  const shortnameUnipd = shortname.match(/(?:^|-)([A-Z]{3}\d{5,10})(?:-|$)/);
  if (shortnameUnipd?.[1]) {
    return shortnameUnipd[1];
  }

  // 3. Shorter code in fullname prefix (e.g. "PS3049 - ...")
  const shortPrefix = fullname.match(/^([A-Z]{2,5}\d{3,10})\s*[-–—:]/);
  if (shortPrefix?.[1]) {
    return shortPrefix[1];
  }

  return null;
}

function cleanCourseTitle(fullname: string, courseCode: string | null): string {
  let title = fullname.trim();

  if (courseCode) {
    const escaped = courseCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    title = title.replace(new RegExp(`^${escaped}\\s*[-–—:]\\s*`), '');
  }

  // Remove trailing academic year suffix such as "2026-2027" or "(2025-2026)"
  title = title.replace(/\s*[-–—(]?\s*20\d{2}\s*[-/]\s*20\d{2}\s*\)?\s*$/, '');
  title = title.replace(/\s+/g, ' ').trim();

  return title || fullname.trim();
}

/**
 * Normalizes a raw Moodle course payload into a structured `EnrolledCourse`.
 */
export function parseCourseMetadata(
  rawCourse: RawMoodleCourse,
  baseUrl: string = DEFAULT_MOODLE_BASE_URL,
): EnrolledCourse {
  const normalizedBase = normalizeBaseUrl(baseUrl);
  const academicYear = extractAcademicYear(rawCourse);
  const courseCode = extractCourseCode(rawCourse);
  const title = cleanCourseTitle(rawCourse.fullname, courseCode);
  const viewUrl = rawCourse.viewurl?.trim() || `${normalizedBase}/course/view.php?id=${rawCourse.id}`;

  return {
    id: rawCourse.id,
    fullname: rawCourse.fullname.trim(),
    shortname: rawCourse.shortname.trim(),
    courseCode,
    title,
    academicYear,
    category: (rawCourse.coursecategory ?? '').trim(),
    viewUrl,
  };
}

/**
 * Checks whether the current browser session is authenticated on Moodle by
 * requesting `/my/courses.php` with browser cookies included.
 */
export async function fetchMoodleSession(
  baseUrl: string = DEFAULT_MOODLE_BASE_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<MoodleSessionInfo> {
  const normalizedBase = normalizeBaseUrl(baseUrl);
  const targetUrl = `${normalizedBase}/my/courses.php`;

  const response = await fetchImpl(targetUrl, {
    method: 'GET',
    credentials: 'include',
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`UniPD Moodle session check failed (HTTP ${response.status}).`);
  }

  const html = await response.text();
  const finalUrl = response.url || targetUrl;
  return extractMoodleSessionInfo(html, finalUrl);
}

/**
 * Fetches all enrolled courses (`limit: 0`) via Moodle's timeline classification
 * AJAX service (`core_course_get_enrolled_courses_by_timeline_classification`).
 */
export async function fetchEnrolledCourses(
  baseUrl: string,
  sesskey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<EnrolledCourse[]> {
  if (!sesskey.trim()) {
    throw new Error('Missing Moodle sesskey for course listing request.');
  }

  const normalizedBase = normalizeBaseUrl(baseUrl);
  const endpoint =
    `${normalizedBase}/lib/ajax/service.php` +
    `?sesskey=${encodeURIComponent(sesskey)}` +
    `&info=core_course_get_enrolled_courses_by_timeline_classification`;

  const requestBody = [
    {
      index: 0,
      methodname: 'core_course_get_enrolled_courses_by_timeline_classification',
      args: {
        offset: 0,
        limit: 0,
        classification: 'all',
        sort: 'fullname',
        customfieldname: '',
        customfieldvalue: '',
        requiredfields: [
          'id',
          'fullname',
          'shortname',
          'showcoursecategory',
          'showshortname',
          'visible',
          'enddate',
        ],
      },
    },
  ];

  const response = await fetchImpl(endpoint, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    throw new Error(`Moodle enrolled courses request failed with HTTP ${response.status}.`);
  }

  const payload = (await response.json()) as unknown;
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error('Unexpected Moodle AJAX response format for enrolled courses.');
  }

  const first = payload[0] as MoodleAjaxResponseItem;
  if (first.error) {
    const code = first.exception?.errorcode ?? 'moodle_ajax_error';
    const message = first.exception?.message ?? 'Moodle returned an AJAX error.';
    if (/^(?:invalidsesskey|requirelogin)$/i.test(code)) {
      throw new MoodleSessionExpiredError(`Moodle AJAX error (${code}): ${message}`);
    }
    throw new Error(`Moodle AJAX error (${code}): ${message}`);
  }

  const rawCourses = first.data?.courses ?? [];
  return rawCourses
    .map((course) => parseCourseMetadata(course, normalizedBase))
    .sort((a, b) => {
      const ayA = a.academicYear ?? '';
      const ayB = b.academicYear ?? '';
      if (ayA !== ayB) {
        return ayB.localeCompare(ayA);
      }
      return a.title.localeCompare(b.title);
    });
}

/**
 * Fetches authenticated HTML for a single Moodle course page.
 */
export async function fetchCoursePageHtml(
  baseUrl: string,
  courseId: number,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const normalizedBase = normalizeBaseUrl(baseUrl);
  const url = `${normalizedBase}/course/view.php?id=${encodeURIComponent(String(courseId))}`;
  const response = await fetchImpl(url, {
    method: 'GET',
    credentials: 'include',
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch course page ${courseId} (HTTP ${response.status}).`);
  }

  const html = await response.text();
  const finalUrl = response.url || url;
  if (isUnauthenticatedMoodleHtml(html, finalUrl)) {
    throw new MoodleSessionExpiredError(
      'Moodle session expired while loading course page. Please sign in again.',
    );
  }

  return html;
}
