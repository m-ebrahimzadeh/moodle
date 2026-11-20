import { describe, expect, it, vi } from 'vitest';
import {
  ShibbolethAuthError,
  executeHeadlessShibbolethLogin,
  inspectShibbolethStepHtml,
} from '../src/core/unipd-sso.js';
import {
  REDACTED_AUTHENTICATED_MY_COURSES_HTML,
  REDACTED_SHIB_E1S1_INTERSTITIAL_HTML,
  REDACTED_SHIB_E1S2_INVALID_LOGIN_HTML,
  REDACTED_SHIB_E1S2_LOGIN_HTML,
  REDACTED_SHIB_MFA_CHALLENGE_HTML,
  REDACTED_SHIB_SAML_POST_HTML,
} from './fixtures/moodle-fixtures.js';

function makeHtmlResponse(html: string, url: string, status = 200): Response {
  const res = new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
  Object.defineProperty(res, 'url', { value: url });
  return res;
}

describe('unipd-sso (T1 headless Shibboleth SAML2 flow)', () => {
  it('parses e1s1 interstitial, e1s2 login form, SAML2 POST form, and Moodle authenticated state', () => {
    const s1 = inspectShibbolethStepHtml(
      REDACTED_SHIB_E1S1_INTERSTITIAL_HTML,
      'https://shibidp.cca.unipd.it/idp/profile/SAML2/Redirect/SSO?execution=e1s1',
    );
    expect(s1.kind).toBe('ls_interstitial');
    if (s1.kind === 'ls_interstitial') {
      expect(s1.actionUrl).toBe(
        'https://shibidp.cca.unipd.it/idp/profile/SAML2/Redirect/SSO?execution=e1s1',
      );
      expect(s1.fields.shib_idp_ls_supported).toBe('false');
    }

    const s2 = inspectShibbolethStepHtml(
      REDACTED_SHIB_E1S2_INVALID_LOGIN_HTML,
      'https://shibidp.cca.unipd.it/idp/profile/SAML2/Redirect/SSO?execution=e1s3',
    );
    expect(s2).toEqual({
      kind: 'login_form',
      actionUrl: 'https://shibidp.cca.unipd.it/idp/profile/SAML2/Redirect/SSO?execution=e1s3',
      errorMessage: 'Credenziali non valide o utente non abilitato.',
    });

    const s3 = inspectShibbolethStepHtml(
      REDACTED_SHIB_SAML_POST_HTML,
      'https://shibidp.cca.unipd.it/idp/profile/SAML2/Redirect/SSO?execution=e1s2',
    );
    expect(s3).toEqual({
      kind: 'saml_post',
      actionUrl: 'https://psico.elearning.unipd.it/sp-shibboleth.sso/SAML2/POST',
      fields: {
        RelayState: 'ss:mem:REDACTED_RELAY',
        SAMLResponse: 'REDACTED_BASE64_SAML_ASSERTION',
      },
    });
  });

  it('completes full e1s1 -> e1s2 -> SAML2 POST flow preserving complete username', async () => {
    const calls: Array<{ url: string; method: string; body: string | null }> = [];
    const mockFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body ? String(init.body) : null;
      calls.push({ url, method, body });

      if (url.endsWith('/auth/shibboleth/index.php')) {
        return makeHtmlResponse(
          REDACTED_SHIB_E1S1_INTERSTITIAL_HTML,
          'https://shibidp.cca.unipd.it/idp/profile/SAML2/Redirect/SSO?execution=e1s1',
        );
      }
      if (url.includes('execution=e1s1') && method === 'POST') {
        return makeHtmlResponse(
          REDACTED_SHIB_E1S2_LOGIN_HTML,
          'https://shibidp.cca.unipd.it/idp/profile/SAML2/Redirect/SSO?execution=e1s2',
        );
      }
      if (url.includes('execution=e1s2') && method === 'POST') {
        return makeHtmlResponse(
          REDACTED_SHIB_SAML_POST_HTML,
          'https://shibidp.cca.unipd.it/idp/profile/SAML2/Redirect/SSO?execution=e1s2',
        );
      }
      if (url.endsWith('/sp-shibboleth.sso/SAML2/POST') && method === 'POST') {
        return makeHtmlResponse(
          REDACTED_AUTHENTICATED_MY_COURSES_HTML,
          'https://psico.elearning.unipd.it/my/courses.php',
        );
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const session = await executeHeadlessShibbolethLogin({
      credentials: {
        username: 'name.surname@studenti.unipd.it',
        domain: '@studenti.unipd.it',
        password: 'SecretValue#1',
      },
      fetchImpl: mockFetch,
    });

    expect(session).toEqual({
      authenticated: true,
      userId: 424242,
      sesskey: 'TESTKEY123',
      loginUrl: 'https://psico.elearning.unipd.it/auth/shibboleth/index.php',
    });

    expect(calls).toHaveLength(4);
    const loginPost = new URLSearchParams(calls[2]!.body ?? '');
    expect(loginPost.get('j_username')).toBe('name.surname@studenti.unipd.it');
    expect(loginPost.get('j_username_js')).toBe('name.surname@studenti.unipd.it');
    expect(loginPost.get('j_password')).toBe('SecretValue#1');
    expect(loginPost.get('dominio')).toBe('@studenti.unipd.it');
    expect(loginPost.get('_eventId_proceed')).toBe('');

    const samlPost = new URLSearchParams(calls[3]!.body ?? '');
    expect(samlPost.get('SAMLResponse')).toBe('REDACTED_BASE64_SAML_ASSERTION');
    expect(samlPost.get('RelayState')).toBe('ss:mem:REDACTED_RELAY');
  });

  it('reuses an active Shibboleth IdP session directly to SAML2 POST without submitting password', async () => {
    const mockFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/auth/shibboleth/index.php')) {
        return makeHtmlResponse(
          REDACTED_SHIB_E1S1_INTERSTITIAL_HTML,
          'https://shibidp.cca.unipd.it/idp/profile/SAML2/Redirect/SSO?execution=e1s1',
        );
      }
      if (url.includes('execution=e1s1') && init?.method === 'POST') {
        return makeHtmlResponse(
          REDACTED_SHIB_SAML_POST_HTML,
          'https://shibidp.cca.unipd.it/idp/profile/SAML2/Redirect/SSO?execution=e1s2',
        );
      }
      if (url.endsWith('/sp-shibboleth.sso/SAML2/POST') && init?.method === 'POST') {
        return makeHtmlResponse(
          REDACTED_AUTHENTICATED_MY_COURSES_HTML,
          'https://psico.elearning.unipd.it/',
        );
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const session = await executeHeadlessShibbolethLogin({
      credentials: {
        username: 'name.surname@studenti.unipd.it',
        domain: '@studenti.unipd.it',
        password: 'ShouldNotBePosted',
      },
      fetchImpl: mockFetch,
    });

    expect(session.authenticated).toBe(true);
    const postedBodies = mockFetch.mock.calls.map((c) => String(c[1]?.body ?? ''));
    expect(postedBodies.join('\n')).not.toContain('ShouldNotBePosted');
  });

  it('trips circuit breaker immediately on invalid credentials without retrying or leaking password', async () => {
    let loginPosts = 0;
    const mockFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/auth/shibboleth/index.php')) {
        return makeHtmlResponse(
          REDACTED_SHIB_E1S2_LOGIN_HTML,
          'https://shibidp.cca.unipd.it/idp/profile/SAML2/Redirect/SSO?execution=e1s2',
        );
      }
      if (url.includes('execution=e1s2') && init?.method === 'POST') {
        loginPosts += 1;
        return makeHtmlResponse(
          REDACTED_SHIB_E1S2_INVALID_LOGIN_HTML,
          'https://shibidp.cca.unipd.it/idp/profile/SAML2/Redirect/SSO?execution=e1s3',
        );
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    let caught: unknown;
    try {
      await executeHeadlessShibbolethLogin({
        credentials: {
          username: 'name.surname@studenti.unipd.it',
          domain: '@studenti.unipd.it',
          password: 'WrongSuperSecretPassword99!',
        },
        fetchImpl: mockFetch,
      });
    } catch (err) {
      caught = err;
    }

    expect(loginPosts).toBe(1);
    expect(caught).toBeInstanceOf(ShibbolethAuthError);
    const authErr = caught as ShibbolethAuthError;
    expect(authErr.code).toBe('INVALID_CREDENTIALS');
    expect(authErr.tripCircuitBreaker).toBe(true);
    expect(authErr.message).toContain('Credenziali non valide');
    expect(authErr.message).not.toContain('WrongSuperSecretPassword99!');
  });

  it('trips circuit breaker on MFA/unsupported challenge and refuses cross-origin SAML targets', async () => {
    const mfaFetch = vi.fn<typeof fetch>(async () =>
      makeHtmlResponse(
        REDACTED_SHIB_MFA_CHALLENGE_HTML,
        'https://shibidp.cca.unipd.it/idp/profile/SAML2/Redirect/SSO?execution=e1s4',
      ),
    );

    let mfaErr: unknown;
    try {
      await executeHeadlessShibbolethLogin({
        credentials: {
          username: 'name.surname@studenti.unipd.it',
          domain: '@studenti.unipd.it',
          password: 'Secret',
        },
        fetchImpl: mfaFetch,
      });
    } catch (err) {
      mfaErr = err;
    }
    expect(mfaErr).toBeInstanceOf(ShibbolethAuthError);
    expect((mfaErr as ShibbolethAuthError).code).toBe('UNSUPPORTED_CHALLENGE');
    expect((mfaErr as ShibbolethAuthError).tripCircuitBreaker).toBe(true);

    // Cross-origin SAML callback rejection
    expect(() =>
      inspectShibbolethStepHtml(
        '<form action="https://evil.example/steal" method="post"><input name="SAMLResponse" value="ABC"></form>',
        'https://shibidp.cca.unipd.it/idp/profile/SAML2/Redirect/SSO?execution=e1s2',
      ),
    ).toThrow(/outside allowed hosts/i);
  });

  it('does NOT trip circuit breaker on transient HTTP 503 outage', async () => {
    const outageFetch = vi.fn<typeof fetch>(async () =>
      makeHtmlResponse('Service Unavailable', 'https://shibidp.cca.unipd.it/idp', 503),
    );

    let caught: unknown;
    try {
      await executeHeadlessShibbolethLogin({
        credentials: {
          username: 'name.surname@studenti.unipd.it',
          domain: '@studenti.unipd.it',
          password: 'Secret',
        },
        fetchImpl: outageFetch,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ShibbolethAuthError);
    expect((caught as ShibbolethAuthError).code).toBe('NETWORK_OR_HTTP');
    expect((caught as ShibbolethAuthError).tripCircuitBreaker).toBe(false);
  });

  it('pins SAMLResponse form to shibidp origin and /sp-shibboleth.sso/SAML2/POST path', () => {
    expect(() =>
      inspectShibbolethStepHtml(
        '<form action="https://psico.elearning.unipd.it/evil/endpoint" method="post"><input name="SAMLResponse" value="ABC"></form>',
        'https://shibidp.cca.unipd.it/idp/profile/SAML2/Redirect/SSO?execution=e1s2',
      ),
    ).toThrow(/expected Shibboleth SP endpoint/i);
  });

  it('guards against e1s1 interstitial loops and falls back to fetchMoodleSession after SAML callback', async () => {
    const loopFetch = vi.fn<typeof fetch>(async () =>
      makeHtmlResponse(
        REDACTED_SHIB_E1S1_INTERSTITIAL_HTML,
        'https://shibidp.cca.unipd.it/idp/profile/SAML2/Redirect/SSO?execution=e1s1',
      ),
    );
    await expect(
      executeHeadlessShibbolethLogin({
        credentials: {
          username: 'name.surname@studenti.unipd.it',
          domain: '@studenti.unipd.it',
          password: 'Secret',
        },
        fetchImpl: loopFetch,
      }),
    ).rejects.toThrow(/looped unexpectedly/i);

    let step = 0;
    const fallbackFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      step += 1;
      if (url.endsWith('/auth/shibboleth/index.php')) {
        return makeHtmlResponse(
          REDACTED_SHIB_E1S2_LOGIN_HTML,
          'https://shibidp.cca.unipd.it/idp/profile/SAML2/Redirect/SSO?execution=e1s2',
        );
      }
      if (url.includes('execution=e1s2') && init?.method === 'POST') {
        return makeHtmlResponse(
          REDACTED_SHIB_SAML_POST_HTML,
          'https://shibidp.cca.unipd.it/idp/profile/SAML2/Redirect/SSO?execution=e1s2',
        );
      }
      if (url.endsWith('/sp-shibboleth.sso/SAML2/POST')) {
        return makeHtmlResponse('<html><body>Redirecting...</body></html>', 'https://psico.elearning.unipd.it/');
      }
      if (url.endsWith('/my/courses.php')) {
        return makeHtmlResponse(
          REDACTED_AUTHENTICATED_MY_COURSES_HTML,
          'https://psico.elearning.unipd.it/my/courses.php',
        );
      }
      throw new Error(`Unexpected step ${step}: ${url}`);
    });

    const verified = await executeHeadlessShibbolethLogin({
      credentials: {
        username: 'name.surname@studenti.unipd.it',
        domain: '@studenti.unipd.it',
        password: 'Secret',
      },
      fetchImpl: fallbackFetch,
    });
    expect(verified.authenticated).toBe(true);
  });
});
