import { describe, expect, it, vi } from 'vitest';
import type { EncryptedCredentialEnvelope, VaultCipherStorage, VaultKeyStore } from '../src/core/credential-vault.js';
import { MoodleSessionExpiredError } from '../src/core/moodle-client.js';
import { AuthManager, type AuthMetaRecord, type AuthMetaStorage } from '../src/extension/auth-manager.js';
import {
  REDACTED_AUTHENTICATED_MY_COURSES_HTML,
  REDACTED_GUEST_MY_COURSES_HTML,
  REDACTED_SHIB_E1S1_INTERSTITIAL_HTML,
  REDACTED_SHIB_E1S2_INVALID_LOGIN_HTML,
  REDACTED_SHIB_E1S2_LOGIN_HTML,
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

function createMemoryAuthBacking() {
  let key: CryptoKey | null = null;
  let envelope: EncryptedCredentialEnvelope | null = null;
  let meta: AuthMetaRecord | null = null;

  const keyStore: VaultKeyStore = {
    async getKey() {
      return key;
    },
    async setKey(next) {
      key = next;
    },
    async deleteKey() {
      key = null;
    },
  };

  const cipherStorage: VaultCipherStorage = {
    async getEnvelope() {
      return envelope ? { ...envelope } : null;
    },
    async setEnvelope(next) {
      envelope = { ...next };
    },
    async deleteEnvelope() {
      envelope = null;
    },
  };

  const metaStorage: AuthMetaStorage = {
    async getMeta() {
      return meta ? { ...meta } : null;
    },
    async setMeta(next) {
      meta = { ...next };
    },
    async deleteMeta() {
      meta = null;
    },
  };

  return {
    keyStore,
    cipherStorage,
    metaStorage,
    corruptKey: () => {
      key = null;
    },
  };
}

describe('AuthManager (singleflight, session reuse, circuit breaker, write-only config)', () => {
  it('exposes write-only config and skips IdP login when browser session is already active', async () => {
    const backing = createMemoryAuthBacking();
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/my/courses.php')) {
        return makeHtmlResponse(
          REDACTED_AUTHENTICATED_MY_COURSES_HTML,
          'https://psico.elearning.unipd.it/my/courses.php',
        );
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });

    const auth = new AuthManager({ ...backing, fetchImpl: fetchMock });
    const cfg = await auth.saveCredentials({
      username: 'name.surname@studenti.unipd.it',
      domain: '@studenti.unipd.it',
      password: 'VerySecretPassword!',
      enabled: true,
    });

    expect(cfg).toEqual({
      configured: true,
      enabled: true,
      username: 'name.surname@studenti.unipd.it',
      domain: '@studenti.unipd.it',
      blockedReason: null,
    });
    expect(JSON.stringify(cfg)).not.toContain('VerySecretPassword!');

    const session = await auth.ensureAuthenticated();
    expect(session.authenticated).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent expired calls via singleflight and retries operation once', async () => {
    const backing = createMemoryAuthBacking();
    let authenticated = false;
    let idpLoginCount = 0;

    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/my/courses.php')) {
        return makeHtmlResponse(
          authenticated ? REDACTED_AUTHENTICATED_MY_COURSES_HTML : REDACTED_GUEST_MY_COURSES_HTML,
          'https://psico.elearning.unipd.it/my/courses.php',
        );
      }
      if (url.endsWith('/auth/shibboleth/index.php')) {
        return makeHtmlResponse(
          REDACTED_SHIB_E1S1_INTERSTITIAL_HTML,
          'https://shibidp.cca.unipd.it/idp/profile/SAML2/Redirect/SSO?execution=e1s1',
        );
      }
      if (url.includes('execution=e1s1') && init?.method === 'POST') {
        return makeHtmlResponse(
          REDACTED_SHIB_E1S2_LOGIN_HTML,
          'https://shibidp.cca.unipd.it/idp/profile/SAML2/Redirect/SSO?execution=e1s2',
        );
      }
      if (url.includes('execution=e1s2') && init?.method === 'POST') {
        idpLoginCount += 1;
        await new Promise((r) => setTimeout(r, 15));
        return makeHtmlResponse(
          REDACTED_SHIB_SAML_POST_HTML,
          'https://shibidp.cca.unipd.it/idp/profile/SAML2/Redirect/SSO?execution=e1s2',
        );
      }
      if (url.endsWith('/sp-shibboleth.sso/SAML2/POST') && init?.method === 'POST') {
        authenticated = true;
        return makeHtmlResponse(
          REDACTED_AUTHENTICATED_MY_COURSES_HTML,
          'https://psico.elearning.unipd.it/my/courses.php',
        );
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const onSessionUpdated = vi.fn();
    const auth = new AuthManager({
      ...backing,
      fetchImpl: fetchMock,
      onSessionUpdated,
    });

    await auth.saveCredentials({
      username: 'name.surname@studenti.unipd.it',
      domain: '@studenti.unipd.it',
      password: 'ValidPassword123',
      enabled: true,
    });

    const attemptCounter = [0, 0, 0];
    const results = await Promise.all(
      [0, 1, 2].map((idx) =>
        auth.withAutoReauth(async () => {
          attemptCounter[idx]! += 1;
          if (!authenticated) {
            throw new MoodleSessionExpiredError('Moodle session expired.');
          }
          return `ok-${idx}`;
        }),
      ),
    );

    expect(results).toEqual(['ok-0', 'ok-1', 'ok-2']);
    expect(attemptCounter).toEqual([2, 2, 2]);
    expect(idpLoginCount).toBe(1);
    expect(onSessionUpdated).toHaveBeenCalledTimes(1);
  });

  it('persists failed-login circuit breaker across AuthManager restarts until credentials update', async () => {
    const backing = createMemoryAuthBacking();
    let rejectLogin = true;
    let idpPostCount = 0;

    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/my/courses.php')) {
        return makeHtmlResponse(
          REDACTED_GUEST_MY_COURSES_HTML,
          'https://psico.elearning.unipd.it/my/courses.php',
        );
      }
      if (url.endsWith('/auth/shibboleth/index.php')) {
        return makeHtmlResponse(
          REDACTED_SHIB_E1S2_LOGIN_HTML,
          'https://shibidp.cca.unipd.it/idp/profile/SAML2/Redirect/SSO?execution=e1s2',
        );
      }
      if (url.includes('execution=e1s2') && init?.method === 'POST') {
        idpPostCount += 1;
        return makeHtmlResponse(
          rejectLogin ? REDACTED_SHIB_E1S2_INVALID_LOGIN_HTML : REDACTED_SHIB_SAML_POST_HTML,
          'https://shibidp.cca.unipd.it/idp/profile/SAML2/Redirect/SSO?execution=e1s3',
        );
      }
      if (url.endsWith('/sp-shibboleth.sso/SAML2/POST') && init?.method === 'POST') {
        return makeHtmlResponse(
          REDACTED_AUTHENTICATED_MY_COURSES_HTML,
          'https://psico.elearning.unipd.it/my/courses.php',
        );
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const auth1 = new AuthManager({ ...backing, fetchImpl: fetchMock });
    await auth1.saveCredentials({
      username: 'name.surname@studenti.unipd.it',
      domain: '@studenti.unipd.it',
      password: 'WrongPassword',
      enabled: true,
    });

    await expect(auth1.ensureAuthenticated()).rejects.toThrow(/Credenziali non valide/i);
    expect(idpPostCount).toBe(1);

    // Simulate MV3 service worker restart (brand new AuthManager instance reading persisted meta)
    const auth2 = new AuthManager({ ...backing, fetchImpl: fetchMock });
    const blockedConfig = await auth2.getAuthConfig();
    expect(blockedConfig.blockedReason).toContain('Credenziali non valide');

    // Subsequent auto-login is halted by circuit breaker (zero IdP POSTs!)
    const skippedSession = await auth2.ensureAuthenticated();
    expect(skippedSession.authenticated).toBe(false);
    expect(idpPostCount).toBe(1);

    // Updating credentials clears breaker and allows login again
    rejectLogin = false;
    await auth2.saveCredentials({
      username: 'name.surname@studenti.unipd.it',
      domain: '@studenti.unipd.it',
      password: 'CorrectedPassword',
      enabled: true,
    });

    const recoveredSession = await auth2.ensureAuthenticated();
    expect(recoveredSession.authenticated).toBe(true);
    expect(idpPostCount).toBe(2);
  });

  it('cleans up corrupted vault state gracefully when IndexedDB key is missing', async () => {
    const backing = createMemoryAuthBacking();
    const fetchMock = vi.fn<typeof fetch>(async () =>
      makeHtmlResponse(
        REDACTED_GUEST_MY_COURSES_HTML,
        'https://psico.elearning.unipd.it/my/courses.php',
      ),
    );

    const auth = new AuthManager({ ...backing, fetchImpl: fetchMock });
    await auth.saveCredentials({
      username: 'name.surname@studenti.unipd.it',
      domain: '@studenti.unipd.it',
      password: 'Secret',
      enabled: true,
    });

    backing.corruptKey();

    const session = await auth.ensureAuthenticated();
    expect(session.authenticated).toBe(false);

    const cfg = await auth.getAuthConfig();
    expect(cfg.configured).toBe(false);
    expect(cfg.enabled).toBe(false);
    expect(cfg.blockedReason).toMatch(/re-enter/i);
  });
});
