import { parse, type HTMLElement } from 'node-html-parser';
import { detectDomainFromUsername, normalizeShibbolethUsername } from './credential-vault.js';
import { extractMoodleSessionInfo, fetchMoodleSession } from './moodle-client.js';
import {
  DEFAULT_MOODLE_BASE_URL,
  UNIPD_SHIBBOLETH_LOGIN_PATH,
  type MoodleSessionInfo,
  type ShibbolethCredentials,
  type UnipdDomain,
} from './types.js';

export const UNIPD_IDP_ORIGIN = 'https://shibidp.cca.unipd.it';

export type ShibbolethAuthErrorCode =
  | 'INVALID_CREDENTIALS'
  | 'UNSUPPORTED_CHALLENGE'
  | 'IDP_UNEXPECTED_STATE'
  | 'NETWORK_OR_HTTP';

/**
 * Structured error from headless UniPD Shibboleth authentication.
 * `tripCircuitBreaker === true` indicates an explicit credential rejection or
 * unsupported interactive challenge (MFA/SPID/CIE) so auto-login stops until
 * user intervention, preventing UniPD account lockout.
 */
export class ShibbolethAuthError extends Error {
  readonly code: ShibbolethAuthErrorCode;
  readonly tripCircuitBreaker: boolean;

  constructor(message: string, code: ShibbolethAuthErrorCode, tripCircuitBreaker: boolean) {
    super(message);
    this.name = 'ShibbolethAuthError';
    this.code = code;
    this.tripCircuitBreaker = tripCircuitBreaker;
  }
}

export type ShibbolethStep =
  | { kind: 'moodle_authenticated'; session: MoodleSessionInfo }
  | { kind: 'ls_interstitial'; actionUrl: string; fields: Record<string, string> }
  | { kind: 'login_form'; actionUrl: string; errorMessage: string | null }
  | { kind: 'saml_post'; actionUrl: string; fields: Record<string, string> }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'unexpected'; reason: string };

export function buildCompleteShibbolethUsername(
  username: string,
  domain: UnipdDomain = '@studenti.unipd.it',
): string {
  return normalizeShibbolethUsername(username, domain);
}

function validateAllowedOriginUrl(
  rawUrl: string,
  baseUrl: string,
  allowedOrigins: ReadonlySet<string>,
  label: string,
): string {
  let resolved: URL;
  try {
    resolved = new URL(rawUrl, baseUrl);
  } catch {
    throw new ShibbolethAuthError(
      `Invalid ${label} URL returned during UniPD SSO.`,
      'IDP_UNEXPECTED_STATE',
      false,
    );
  }

  if (resolved.protocol !== 'https:' || !allowedOrigins.has(resolved.origin)) {
    throw new ShibbolethAuthError(
      `UniPD SSO redirected outside allowed hosts (${resolved.origin}).`,
      'UNSUPPORTED_CHALLENGE',
      true,
    );
  }

  return resolved.toString();
}

function collectFormInputs(form: HTMLElement): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const input of form.querySelectorAll('input')) {
    const name = input.getAttribute('name')?.trim();
    if (!name) {
      continue;
    }
    const type = (input.getAttribute('type') ?? '').trim().toLowerCase();
    if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') {
      continue;
    }
    fields[name] = input.getAttribute('value') ?? '';
  }
  return fields;
}

function sanitizeIdpBannerText(rawText: string): string {
  return rawText.replace(/\s+/g, ' ').trim().slice(0, 180);
}

function extractIdpErrorMessage(root: HTMLElement): string | null {
  const errorSelectors = [
    '.alert-danger',
    '.alert.alert-error',
    '.output--error',
    '.form-error',
    '#error',
    '[role="alert"]',
    '.login-error',
  ];

  for (const selector of errorSelectors) {
    const el = root.querySelector(selector);
    if (el) {
      const text = sanitizeIdpBannerText(el.text);
      if (text) {
        return text;
      }
    }
  }

  const bodyText = root.text;
  const knownErrorMatch = bodyText.match(
    /(?:credenziali non valide|username o password(?:\s+\w+){0,4}\s+errat[ei]|autenticazione fallita|invalid username or password|the password you entered was incorrect|account(?: is)? locked|password (?:expired|scaduta))/i,
  );
  if (knownErrorMatch?.[0]) {
    return sanitizeIdpBannerText(knownErrorMatch[0]);
  }

  return null;
}

/**
 * Pure parser identifying the active stage of a UniPD Shibboleth SAML2 HTML response.
 */
export function inspectShibbolethStepHtml(
  html: string,
  pageUrl: string,
  moodleBaseUrl: string = DEFAULT_MOODLE_BASE_URL,
  idpOrigin: string = UNIPD_IDP_ORIGIN,
): ShibbolethStep {
  const moodleOrigin = new URL(moodleBaseUrl).origin;
  const normalizedIdpOrigin = new URL(idpOrigin).origin;
  const allowedOrigins = new Set([moodleOrigin, normalizedIdpOrigin]);

  let currentOrigin: string;
  try {
    currentOrigin = new URL(pageUrl).origin;
  } catch {
    return { kind: 'unexpected', reason: 'Unrecognized URL encountered during UniPD SSO.' };
  }

  if (currentOrigin === moodleOrigin) {
    const session = extractMoodleSessionInfo(html, pageUrl);
    if (session.authenticated) {
      return { kind: 'moodle_authenticated', session };
    }
  }

  const root = parse(html);

  // 1. SAML2 Auto-POST response form targeting UniPD Moodle SP (/sp-shibboleth.sso/SAML2/POST)
  for (const form of root.querySelectorAll('form')) {
    const samlInput = form.querySelector('input[name="SAMLResponse"]');
    if (!samlInput) {
      continue;
    }
    const rawAction = form.getAttribute('action')?.trim();
    if (!rawAction) {
      return {
        kind: 'unexpected',
        reason: 'SAML response form is missing its target action URL.',
      };
    }
    const actionUrl = validateAllowedOriginUrl(
      rawAction,
      pageUrl,
      new Set([moodleOrigin]),
      'SAML callback',
    );
    const fields = collectFormInputs(form);
    if (!fields.SAMLResponse) {
      return {
        kind: 'unexpected',
        reason: 'SAML response form is missing a SAMLResponse payload.',
      };
    }
    return {
      kind: 'saml_post',
      actionUrl,
      fields,
    };
  }

  // 2. Shibboleth IdP v5 pages (shibidp.cca.unipd.it)
  if (currentOrigin === normalizedIdpOrigin) {
    // 2a. e1s1 "Loading Session Information" localStorage interstitial
    const lsForm = root.querySelector('form[name="form1"]');
    if (lsForm && lsForm.querySelector('input[name="shib_idp_ls_supported"]')) {
      const rawAction = lsForm.getAttribute('action')?.trim() || pageUrl;
      const actionUrl = validateAllowedOriginUrl(
        rawAction,
        pageUrl,
        new Set([normalizedIdpOrigin]),
        'IdP interstitial',
      );
      const fields = collectFormInputs(lsForm);
      fields['shib_idp_ls_supported'] = 'false';
      fields['shib_idp_ls_success.shib_idp_session_ss'] = 'false';
      fields['shib_idp_ls_success.shib_idp_persistent_ss'] = 'false';
      fields['_eventId_proceed'] = '';
      return {
        kind: 'ls_interstitial',
        actionUrl,
        fields,
      };
    }

    // 2b. e1s2/e2s1 standard UniPD login form (#user-login-form)
    const loginForm = root.querySelector('form#user-login-form');
    if (loginForm) {
      const rawAction = loginForm.getAttribute('action')?.trim() || pageUrl;
      const actionUrl = validateAllowedOriginUrl(
        rawAction,
        pageUrl,
        new Set([normalizedIdpOrigin]),
        'IdP login form',
      );
      const errorMessage = extractIdpErrorMessage(root);
      return {
        kind: 'login_form',
        actionUrl,
        errorMessage,
      };
    }

    // 2c. Any other IdP prompt (MFA, SPID, CIE, password-expiry flow, etc.)
    return {
      kind: 'unsupported',
      reason:
        'UniPD SSO presented an additional verification step. Please sign in with UniPD SSO manually.',
    };
  }

  if (!allowedOrigins.has(currentOrigin)) {
    return {
      kind: 'unsupported',
      reason: 'UniPD SSO redirected to an external verification provider.',
    };
  }

  return {
    kind: 'unexpected',
    reason: 'UniPD SSO did not reach the expected Shibboleth login page.',
  };
}

export interface ExecuteHeadlessShibbolethLoginParams {
  credentials: ShibbolethCredentials;
  moodleBaseUrl?: string;
  idpOrigin?: string;
  fetchImpl?: typeof fetch;
  maxSteps?: number;
}

/**
 * Executes the headless UniPD Shibboleth SAML2 login flow (`T1`) inside the browser session
 * cookie jar (`credentials: 'include'`) and verifies the resulting Moodle session.
 */
export async function executeHeadlessShibbolethLogin(
  params: ExecuteHeadlessShibbolethLoginParams,
): Promise<MoodleSessionInfo> {
  const moodleBaseUrl = (params.moodleBaseUrl ?? DEFAULT_MOODLE_BASE_URL).replace(/\/+$/, '');
  const moodleOrigin = new URL(moodleBaseUrl).origin;
  const idpOrigin = new URL(params.idpOrigin ?? UNIPD_IDP_ORIGIN).origin;
  const fetchImpl = params.fetchImpl ?? fetch;
  const maxSteps = Math.max(3, params.maxSteps ?? 6);
  const allowedOrigins = new Set([moodleOrigin, idpOrigin]);

  const fullUsername = buildCompleteShibbolethUsername(
    params.credentials.username,
    params.credentials.domain,
  );
  if (!fullUsername || !params.credentials.password) {
    throw new ShibbolethAuthError(
      'UniPD username and password are required for automatic login.',
      'INVALID_CREDENTIALS',
      false,
    );
  }
  const effectiveDomain = detectDomainFromUsername(fullUsername, params.credentials.domain);

  let response = await fetchImpl(`${moodleOrigin}${UNIPD_SHIBBOLETH_LOGIN_PATH}`, {
    method: 'GET',
    credentials: 'include',
    redirect: 'follow',
  });

  let submittedCredentials = false;
  let interstitialCount = 0;

  for (let stepIdx = 0; stepIdx < maxSteps; stepIdx += 1) {
    if (!response.ok) {
      throw new ShibbolethAuthError(
        `UniPD SSO request failed (HTTP ${response.status}).`,
        'NETWORK_OR_HTTP',
        false,
      );
    }

    const finalUrl = validateAllowedOriginUrl(
      response.url || `${moodleOrigin}${UNIPD_SHIBBOLETH_LOGIN_PATH}`,
      moodleOrigin,
      allowedOrigins,
      'SSO step',
    );
    const html = await response.text();
    const step = inspectShibbolethStepHtml(html, finalUrl, moodleOrigin, idpOrigin);

    if (step.kind === 'moodle_authenticated') {
      return step.session;
    }

    if (step.kind === 'ls_interstitial') {
      interstitialCount += 1;
      if (interstitialCount > 2) {
        throw new ShibbolethAuthError(
          'UniPD SSO session initialization looped unexpectedly.',
          'IDP_UNEXPECTED_STATE',
          false,
        );
      }
      response = await fetchImpl(step.actionUrl, {
        method: 'POST',
        credentials: 'include',
        redirect: 'follow',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(step.fields).toString(),
      });
      continue;
    }

    if (step.kind === 'login_form') {
      if (submittedCredentials) {
        const detail = step.errorMessage
          ? `UniPD rejected login: ${step.errorMessage}`
          : 'UniPD rejected the saved username or password.';
        throw new ShibbolethAuthError(detail, 'INVALID_CREDENTIALS', true);
      }

      submittedCredentials = true;
      const formBody = new URLSearchParams({
        j_username: fullUsername,
        j_username_js: fullUsername,
        j_password: params.credentials.password,
        dominio: effectiveDomain,
        _eventId_proceed: '',
      });

      response = await fetchImpl(step.actionUrl, {
        method: 'POST',
        credentials: 'include',
        redirect: 'follow',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formBody.toString(),
      });
      continue;
    }

    if (step.kind === 'saml_post') {
      response = await fetchImpl(step.actionUrl, {
        method: 'POST',
        credentials: 'include',
        redirect: 'follow',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(step.fields).toString(),
      });

      if (!response.ok) {
        throw new ShibbolethAuthError(
          `UniPD Moodle SAML callback failed (HTTP ${response.status}).`,
          'NETWORK_OR_HTTP',
          false,
        );
      }

      const callbackFinalUrl = validateAllowedOriginUrl(
        response.url || step.actionUrl,
        moodleOrigin,
        allowedOrigins,
        'SAML callback result',
      );
      const callbackHtml = await response.text();
      const callbackSession = extractMoodleSessionInfo(callbackHtml, callbackFinalUrl);
      if (callbackSession.authenticated) {
        return callbackSession;
      }

      const verifiedSession = await fetchMoodleSession(moodleOrigin, fetchImpl);
      if (verifiedSession.authenticated) {
        return verifiedSession;
      }

      throw new ShibbolethAuthError(
        'UniPD SSO completed SAML callback, but Moodle session is still unauthenticated.',
        'IDP_UNEXPECTED_STATE',
        false,
      );
    }

    if (step.kind === 'unsupported') {
      throw new ShibbolethAuthError(step.reason, 'UNSUPPORTED_CHALLENGE', true);
    }

    throw new ShibbolethAuthError(step.reason, 'IDP_UNEXPECTED_STATE', false);
  }

  throw new ShibbolethAuthError(
    'UniPD SSO did not complete within expected redirects.',
    'IDP_UNEXPECTED_STATE',
    false,
  );
}
