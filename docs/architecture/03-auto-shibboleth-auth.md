# Automatic UniPD Shibboleth SSO & Encrypted Credential Storage (`DEC-006`)
* **Document ID**: MOODLE-DOC-007
* **Canonical Path**: docs/architecture/03-auto-shibboleth-auth.md
* **Version**: 0.1.0
* **Status**: Approved
* **Owner**: Architect
* **Last Updated**: 2026-11-20

## 1. Purpose & Scope (`DSC-001`, `DEC-006`)
Define the minimal, maintainable architecture for opt-in automatic login to UniPD Shibboleth SSO (`https://shibidp.cca.unipd.it` -> `https://psico.elearning.unipd.it/sp-shibboleth.sso/SAML2/POST`) using locally encrypted credentials, preserving strict independence from `polisdk` (`DEC-002`) and unidirectional layer isolation (`DEC-003`).

* **Supported Login Scope**: UniPD Shibboleth username (full email such as `name.surname@studenti.unipd.it`, or local part with default `@studenti.unipd.it` / selectable `@unipd.it` appended), and password.
* **Explicit Non-Goals**: Moodle Standard Login (`#login`), SPID/CIE, TOTP/2FA automation, `chrome.storage.sync`, master PIN prompts (`S2`), or hidden iframes (`CSP: frame-ancestors 'none'`).

## 2. Verified UniPD Shibboleth Protocol Flow (`[VERIFIED]` Live Unauthenticated Probe)
1. `GET https://psico.elearning.unipd.it/auth/shibboleth/index.php` redirects (`302`) to `https://shibidp.cca.unipd.it/idp/profile/SAML2/Redirect/SSO?...` (`_opensaml_req_*` `HttpOnly` cookie set on Moodle; `__Host-JSESSIONID` + `ROUTEID` set on IdP).
2. **Interstitial (`execution=e1s1`)**: Shibboleth IdP v5 renders `form[name="form1"]` (`Loading Session Information`) with `shib_idp_ls_*` fields and `_eventId_proceed`. `POST`ing `shib_idp_ls_supported=false` with `Origin: chrome-extension://...` returns `302 -> 200` (`execution=e1s2`).
3. **Login Form (`execution=e1s2`)**: Renders `form#user-login-form` with **zero CSRF token**. Page JS (`login_via_js()`) copies full `@studenti.unipd.it` / `@unipd.it` / `@ext.unipd.it` usernames straight into `j_username` (and appends `dominio` only if omitted).
4. **SAML2 Callback (`T1`)**: On successful authentication (or IdP cookie reuse), IdP returns an auto-POST `<form>` containing `SAMLResponse` (+ optional `RelayState`) targeting `https://psico.elearning.unipd.it/sp-shibboleth.sso/SAML2/POST`, establishing `_shibsession_*` (`HttpOnly`) and rotating `MoodleSessionpsico`.
   * **Contingency (`T2`)**: If authenticated live testing reveals WAF/`Origin` rejection on `/sp-shibboleth.sso/SAML2/POST`, replace only the transport step in `AuthManager` with an on-demand background tab + `chrome.scripting` runner without altering vault or queue contracts.

## 3. Security & Layer Architecture

### 3.1 Encrypted Storage (`S1`) & Threat Boundary
* **Encryption**: Native Web Crypto `AES-256-GCM` with a random `256`-bit **non-extractable** `CryptoKey` (`extractable: false`) persisted in IndexedDB (`unipd_moodle_vault_db`), and fresh `12`-byte random IV ciphertext (`{ version: 1, iv, ciphertext, updatedAt }`) stored in `chrome.storage.local` (`unipd_auth_vault_v1`).
* **Non-Secret Metadata**: `{ enabled, username, domain, blockedReason }` stored separately in `chrome.storage.local` (`unipd_auth_meta_v1`) so UI status reads never decrypt passwords and lockout state survives 30s MV3 service worker suspension.
* **Write-Only UI Boundary**: UI sends `{ username, domain, password, enabled }` to Service Worker on save; Service Worker **never** returns `password` back to UI.
* **Honest Threat Model**: Prevents plaintext exposure in `chrome.storage.local`, logs, and UI state; like any unattended zero-prompt browser credential store, it trusts the local OS user's Chrome profile.
* **Corruption Recovery**: If IndexedDB key is lost/mismatching (`OperationError`), `AuthManager` clears stale ciphertext, sets a recoverable notice in `blockedReason`, and never loops or crashes.

### 3.2 Session Reuse, Expiry Recovery & Lockout Prevention
* **Session Reuse First**: `AuthManager.ensureAuthenticated()` always calls `fetchMoodleSession()` first; if `authenticated === true`, existing browser cookies are reused with zero login calls.
* **Singleflight + Retry-Once (`withAutoReauth`)**: Concurrent callers (`LIST_COURSES`, `SCAN_COURSE_LECTURES`, `RESOLVE_LECTURE_MEDIA`, `RESOLVE_FOLDER_FILES`, and `resolveDownloadUrlFromDescriptor`) join a single in-flight login Promise on `MoodleSessionExpiredError` and retry the failed request **at most once**.
* **Lockout Circuit Breaker**: If `shibidp.cca.unipd.it` returns back to `#user-login-form` after credential submission (invalid password/username) or displays an unsupported challenge (MFA/SPID/CIE), `ShibbolethAuthError` (`tripCircuitBreaker: true`) persists `blockedReason` in `chrome.storage.local` and halts all automatic login retries until the user saves updated credentials (or clears credentials). Transient `5xx`/network errors do **not** trip the permanent breaker.

## 4. Module Contracts (`TASK-009`)
1. **`src/core/types.ts`**: `UnipdDomain = '@studenti.unipd.it' | '@unipd.it'`, `ShibbolethCredentials`, `StoredAuthConfig`.
2. **`src/core/credential-vault.ts`** (pure, zero `chrome.*`): `VaultKeyStore`, `VaultCipherStorage`, `normalizeUnipdDomain()`, `normalizeShibbolethUsername()`, `saveCredentialsToVault()`, `loadCredentialsFromVault()`, `clearCredentialsFromVault()`.
3. **`src/core/unipd-sso.ts`** (pure, zero `chrome.*`): `UNIPD_IDP_ORIGIN`, `ShibbolethAuthError`, `buildCompleteShibbolethUsername()`, `inspectShibbolethStepHtml()`, `executeHeadlessShibbolethLogin()`.
4. **`src/core/moodle-client.ts`**: `MoodleSessionExpiredError` thrown on expired/guest/login HTML and `invalidsesskey`/`requirelogin` AJAX responses (preserving existing error messages).
5. **`src/extension/auth-manager.ts`**: IndexedDB + `chrome.storage.local` adapters, singleflight `ensureAuthenticated()`, `withAutoReauth()`, credential save/toggle/clear, and `AUTH_CONFIG_UPDATED` / `SESSION_UPDATED` state synchronization.
6. **`src/extension/messages.ts`, `download-manager.ts`, `service-worker.ts`, `public/manifest.json`**:
   * `public/manifest.json`: add `"https://shibidp.cca.unipd.it/*"` to `host_permissions`.
   * `download-manager.ts`: extend `sanitizeErrorMessage()` to redact `j_password`, `password`, `SAMLResponse`, `RelayState`, and `__Host-JSESSIONID`.
   * `messages.ts` / `service-worker.ts`: add `GET_AUTH_CONFIG`, `SAVE_AUTH_CREDENTIALS`, `CLEAR_AUTH_CREDENTIALS`, `SET_AUTO_LOGIN_ENABLED`, `AUTO_LOGIN_NOW`, and `AUTH_CONFIG_UPDATED` broadcast; wrap Moodle/download resolvers with `withAutoReauth`.
7. **`src/ui/sidepanel.{html,css,ts}`**: Compact collapsible `<details>` Auto-Login card (`<form>`, `autocomplete="username"` / `"current-password"`, accessible password visibility toggle, `@studenti.unipd.it` default domain select, enable toggle, Save & Forget buttons, live status/blocked alert).
