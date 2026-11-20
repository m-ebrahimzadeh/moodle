import { describe, expect, it, vi } from 'vitest';
import {
  extractMoodleSessionInfo,
  fetchCoursePageHtml,
  fetchEnrolledCourses,
  fetchMoodleSession,
  parseCourseMetadata,
} from '../src/core/moodle-client.js';
import { DEFAULT_MOODLE_BASE_URL } from '../src/core/types.js';
import {
  REDACTED_AUTHENTICATED_MY_COURSES_HTML,
  REDACTED_GUEST_MY_COURSES_HTML,
  REDACTED_IDP_PAGE_HTML,
  REDACTED_LOGIN_PAGE_HTML,
  REDACTED_RAW_COURSES,
} from './fixtures/moodle-fixtures.js';

describe('moodle-client', () => {
  describe('extractMoodleSessionInfo', () => {
    it('detects authenticated session with userId and sesskey on /my/courses.php', () => {
      const info = extractMoodleSessionInfo(
        REDACTED_AUTHENTICATED_MY_COURSES_HTML,
        'https://psico.elearning.unipd.it/my/courses.php',
      );

      expect(info).toEqual({
        authenticated: true,
        userId: 424242,
        sesskey: 'TESTKEY123',
        loginUrl: 'https://psico.elearning.unipd.it/auth/shibboleth/index.php',
      });
    });

    it('marks /login/index.php with notloggedin and userId=0 as unauthenticated', () => {
      const info = extractMoodleSessionInfo(
        REDACTED_LOGIN_PAGE_HTML,
        'https://psico.elearning.unipd.it/login/index.php',
      );

      expect(info).toEqual({
        authenticated: false,
        userId: null,
        sesskey: null,
        loginUrl: 'https://psico.elearning.unipd.it/auth/shibboleth/index.php',
      });
    });

    it('marks Shibboleth IdP redirect as unauthenticated and preserves UniPD SP loginUrl', () => {
      const info = extractMoodleSessionInfo(
        REDACTED_IDP_PAGE_HTML,
        'https://shibidp.cca.unipd.it/idp/profile/SAML2/Redirect/SSO?execution=e2s1',
      );

      expect(info.authenticated).toBe(false);
      expect(info.sesskey).toBeNull();
      expect(info.loginUrl).toBe('https://psico.elearning.unipd.it/auth/shibboleth/index.php');
    });

    it('rejects live UniPD Moodle guest session (userId=1 on HTTP 200 /my/courses.php) as unauthenticated [LIVE-001]', () => {
      const info = extractMoodleSessionInfo(
        REDACTED_GUEST_MY_COURSES_HTML,
        'https://psico.elearning.unipd.it/my/courses.php',
      );

      expect(info).toEqual({
        authenticated: false,
        userId: null,
        sesskey: null,
        loginUrl: 'https://psico.elearning.unipd.it/auth/shibboleth/index.php',
      });
    });

    it('requires positive auth signal when userId is omitted from M.cfg', () => {
      const guestWithoutUserId = `<!doctype html>
        <body class="path-my">
          <div class="usermenu"><a href="https://psico.elearning.unipd.it/login/index.php">Log in</a></div>
          <script>M.cfg = {"wwwroot":"https://psico.elearning.unipd.it","sesskey":"GUESTNOID1"};</script>
        </body>`;

      expect(
        extractMoodleSessionInfo(
          guestWithoutUserId,
          'https://psico.elearning.unipd.it/my/courses.php',
        ).authenticated,
      ).toBe(false);

      const authWithLogoutWithoutUserId = `<!doctype html>
        <body class="path-my">
          <div class="usermenu"><a href="https://psico.elearning.unipd.it/login/logout.php?sesskey=AUTHNOID1">Log out</a></div>
          <script>M.cfg = {"wwwroot":"https://psico.elearning.unipd.it","sesskey":"AUTHNOID1"};</script>
        </body>`;

      const authInfo = extractMoodleSessionInfo(
        authWithLogoutWithoutUserId,
        'https://psico.elearning.unipd.it/my/courses.php',
      );
      expect(authInfo.authenticated).toBe(true);
      expect(authInfo.sesskey).toBe('AUTHNOID1');
    });
  });

  describe('fetchMoodleSession & fetchCoursePageHtml', () => {
    it('throws on HTTP 503 outage in fetchMoodleSession instead of returning unauthenticated [LIVE-001]', async () => {
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        new Response('Service Temporarily Unavailable', {
          status: 503,
          headers: { 'Content-Type': 'text/html' },
        }),
      );

      await expect(fetchMoodleSession(DEFAULT_MOODLE_BASE_URL, mockFetch)).rejects.toThrow(
        'HTTP 503',
      );
    });

    it('throws session expired in fetchCoursePageHtml when Moodle returns guest userId=1 HTML', async () => {
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(REDACTED_GUEST_MY_COURSES_HTML, {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        }),
      );

      await expect(fetchCoursePageHtml(DEFAULT_MOODLE_BASE_URL, 7075, mockFetch)).rejects.toThrow(
        /session expired/i,
      );
    });
  });

  describe('parseCourseMetadata', () => {
    it('extracts AY, courseCode, and clean title from UniPD fullname and shortname', () => {
      const course = parseCourseMetadata(REDACTED_RAW_COURSES[0]!);
      expect(course).toEqual({
        id: 7075,
        fullname: 'PSQ4107809 - PRINCIPLES AND APPLICATIONS OF PSYCHOLOGICAL TESTING 2026-2027',
        shortname: '2026-PS3049-000ZZ-2026-PSQ4107809-N0-PS3049',
        courseCode: 'PSQ4107809',
        title: 'PRINCIPLES AND APPLICATIONS OF PSYCHOLOGICAL TESTING',
        academicYear: '2026-2027',
        category: 'PS3049 - APPLIED CHILD AND ADOLESCENT PSYCHOLOGY',
        viewUrl: 'https://psico.elearning.unipd.it/course/view.php?id=7075',
      });
    });

    it('falls back to shortname for courseCode when fullname omits it', () => {
      const course = parseCourseMetadata(REDACTED_RAW_COURSES[1]!);
      expect(course.courseCode).toBe('PSQ4106920');
      expect(course.academicYear).toBe('2025-2026');
      expect(course.title).toBe('DEVELOPMENTAL PSYCHOPATHOLOGY');
    });

    it('falls back to coursecategory breadcrumb for AY and generates viewUrl if omitted', () => {
      const course = parseCourseMetadata(REDACTED_RAW_COURSES[2]!);
      expect(course.academicYear).toBe('2024-2025');
      expect(course.courseCode).toBeNull();
      expect(course.viewUrl).toBe(`${DEFAULT_MOODLE_BASE_URL}/course/view.php?id=6100`);
    });
  });

  describe('fetchEnrolledCourses', () => {
    it('posts limit=0 timeline classification payload and sorts courses newest AY first', async () => {
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify([
            {
              error: false,
              data: {
                courses: REDACTED_RAW_COURSES,
                nextoffset: 3,
              },
            },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const courses = await fetchEnrolledCourses(
        DEFAULT_MOODLE_BASE_URL,
        'TESTKEY123',
        mockFetch,
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0]!;
      expect(String(url)).toContain(
        '/lib/ajax/service.php?sesskey=TESTKEY123&info=core_course_get_enrolled_courses_by_timeline_classification',
      );
      expect(init?.method).toBe('POST');
      expect(init?.credentials).toBe('include');

      const sentBody = JSON.parse(String(init?.body)) as Array<{ args: { limit: number; classification: string } }>;
      expect(sentBody[0]?.args.limit).toBe(0);
      expect(sentBody[0]?.args.classification).toBe('all');

      expect(courses.map((c) => c.academicYear)).toEqual(['2026-2027', '2025-2026', '2024-2025']);
    });

    it('throws descriptive error on Moodle AJAX exception', async () => {
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify([
            {
              error: true,
              exception: {
                errorcode: 'invalidsesskey',
                message: 'Invalid session key',
              },
            },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      await expect(
        fetchEnrolledCourses(DEFAULT_MOODLE_BASE_URL, 'EXPIREDKEY', mockFetch),
      ).rejects.toThrow('invalidsesskey');
    });
  });
});
