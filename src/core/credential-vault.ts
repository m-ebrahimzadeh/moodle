import type { ShibbolethCredentials, UnipdDomain } from './types.js';

export const AUTH_VAULT_STORAGE_KEY = 'unipd_auth_vault_v1';
export const AUTH_META_STORAGE_KEY = 'unipd_auth_meta_v1';
export const DEFAULT_UNIPD_DOMAIN: UnipdDomain = '@studenti.unipd.it';

const VALID_DOMAINS: ReadonlySet<string> = new Set<UnipdDomain>([
  '@studenti.unipd.it',
  '@unipd.it',
]);

const KNOWN_UNIPD_DOMAIN_SUFFIXES: ReadonlyArray<string> = [
  '@studenti.unipd.it',
  '@unipd.it',
  '@ext.unipd.it',
];

const IV_BYTE_LENGTH = 12;
const MIN_GCM_CIPHERTEXT_BYTES = 16;

export interface EncryptedCredentialEnvelope {
  version: 1;
  iv: string;
  ciphertext: string;
  updatedAt: number;
}

export interface VaultKeyStore {
  getKey(): Promise<CryptoKey | null>;
  setKey(key: CryptoKey): Promise<void>;
  deleteKey(): Promise<void>;
}

export interface VaultCipherStorage {
  getEnvelope(): Promise<EncryptedCredentialEnvelope | null>;
  setEnvelope(envelope: EncryptedCredentialEnvelope): Promise<void>;
  deleteEnvelope(): Promise<void>;
}

export type LoadVaultResult =
  | { status: 'empty' }
  | { status: 'ok'; credentials: ShibbolethCredentials }
  | { status: 'corrupted' };

function getWebCrypto(): Crypto {
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
    return globalThis.crypto;
  }
  throw new Error('Web Crypto API (crypto.subtle) is unavailable in this environment.');
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function normalizeUnipdDomain(raw: unknown): UnipdDomain {
  if (typeof raw === 'string') {
    const trimmed = raw.trim().toLowerCase();
    if (VALID_DOMAINS.has(trimmed)) {
      return trimmed as UnipdDomain;
    }
  }
  return DEFAULT_UNIPD_DOMAIN;
}

/**
 * Normalizes a UniPD Shibboleth username.
 * Preserves complete addresses (e.g. `name.surname@studenti.unipd.it`) as entered,
 * and appends `fallbackDomain` only when no `@domain` suffix is provided.
 */
export function normalizeShibbolethUsername(
  rawUsername: string,
  fallbackDomain: UnipdDomain = DEFAULT_UNIPD_DOMAIN,
): string {
  const trimmed = rawUsername.trim().replace(/[\r\n\0]/g, '');
  if (!trimmed) {
    return '';
  }
  if (trimmed.includes('@')) {
    return trimmed;
  }
  return `${trimmed}${normalizeUnipdDomain(fallbackDomain)}`;
}

export function detectDomainFromUsername(
  username: string,
  fallback: UnipdDomain = DEFAULT_UNIPD_DOMAIN,
): UnipdDomain {
  const lower = username.trim().toLowerCase();
  for (const suffix of KNOWN_UNIPD_DOMAIN_SUFFIXES) {
    if (lower.endsWith(suffix) && VALID_DOMAINS.has(suffix)) {
      return suffix as UnipdDomain;
    }
  }
  return normalizeUnipdDomain(fallback);
}

/**
 * Generates a random 256-bit non-extractable AES-GCM `CryptoKey` for `S1` vault storage.
 */
export async function generateNonExtractableVaultKey(
  cryptoApi: Crypto = getWebCrypto(),
): Promise<CryptoKey> {
  return cryptoApi.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function isValidEnvelopeShape(raw: unknown): raw is EncryptedCredentialEnvelope {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return false;
  }
  const obj = raw as Record<string, unknown>;
  return (
    obj.version === 1 &&
    typeof obj.iv === 'string' &&
    obj.iv.trim().length > 0 &&
    typeof obj.ciphertext === 'string' &&
    obj.ciphertext.trim().length > 0
  );
}

/**
 * Encrypts UniPD Shibboleth credentials using AES-256-GCM and a non-extractable `CryptoKey`.
 */
export async function saveCredentialsToVault(
  credentials: ShibbolethCredentials,
  keyStore: VaultKeyStore,
  cipherStorage: VaultCipherStorage,
  cryptoApi: Crypto = getWebCrypto(),
): Promise<ShibbolethCredentials> {
  const domain = normalizeUnipdDomain(credentials.domain);
  const username = normalizeShibbolethUsername(credentials.username, domain);
  const password = credentials.password;

  if (!username) {
    throw new Error('UniPD username is required.');
  }
  if (!password) {
    throw new Error('UniPD password is required.');
  }

  let key = await keyStore.getKey();
  if (!key) {
    key = await generateNonExtractableVaultKey(cryptoApi);
    await keyStore.setKey(key);
  }

  const normalizedCreds: ShibbolethCredentials = {
    username,
    domain: detectDomainFromUsername(username, domain),
    password,
  };

  const iv = cryptoApi.getRandomValues(new Uint8Array(IV_BYTE_LENGTH));
  const plaintext = new TextEncoder().encode(JSON.stringify(normalizedCreds));
  const encryptedBuffer = await cryptoApi.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    plaintext as BufferSource,
  );

  const envelope: EncryptedCredentialEnvelope = {
    version: 1,
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(encryptedBuffer)),
    updatedAt: Date.now(),
  };

  await cipherStorage.setEnvelope(envelope);
  return normalizedCreds;
}

/**
 * Loads and decrypts saved UniPD Shibboleth credentials.
 * Returns `{ status: 'corrupted' }` cleanly if the IndexedDB key or ciphertext is unusable.
 */
export async function loadCredentialsFromVault(
  keyStore: VaultKeyStore,
  cipherStorage: VaultCipherStorage,
  cryptoApi: Crypto = getWebCrypto(),
): Promise<LoadVaultResult> {
  let envelope: EncryptedCredentialEnvelope | null;
  try {
    envelope = await cipherStorage.getEnvelope();
  } catch {
    return { status: 'corrupted' };
  }
  if (!envelope) {
    return { status: 'empty' };
  }

  if (!isValidEnvelopeShape(envelope)) {
    return { status: 'corrupted' };
  }

  let key: CryptoKey | null;
  try {
    key = await keyStore.getKey();
  } catch {
    return { status: 'corrupted' };
  }
  if (!key) {
    return { status: 'corrupted' };
  }

  try {
    const iv = base64ToBytes(envelope.iv.trim());
    const ciphertext = base64ToBytes(envelope.ciphertext.trim());
    if (iv.byteLength !== IV_BYTE_LENGTH || ciphertext.byteLength < MIN_GCM_CIPHERTEXT_BYTES) {
      return { status: 'corrupted' };
    }

    const decryptedBuffer = await cryptoApi.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      ciphertext as BufferSource,
    );

    const parsed = JSON.parse(new TextDecoder().decode(decryptedBuffer)) as Partial<ShibbolethCredentials>;
    const domain = normalizeUnipdDomain(parsed.domain);
    const username =
      typeof parsed.username === 'string' ? normalizeShibbolethUsername(parsed.username, domain) : '';
    const password = typeof parsed.password === 'string' ? parsed.password : '';

    if (!username || !password) {
      return { status: 'corrupted' };
    }

    return {
      status: 'ok',
      credentials: {
        username,
        domain: detectDomainFromUsername(username, domain),
        password,
      },
    };
  } catch {
    return { status: 'corrupted' };
  }
}

export async function clearCredentialsFromVault(
  keyStore: VaultKeyStore,
  cipherStorage: VaultCipherStorage,
): Promise<void> {
  await Promise.all([cipherStorage.deleteEnvelope(), keyStore.deleteKey()]);
}
