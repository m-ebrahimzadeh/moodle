import {
  AUTH_META_STORAGE_KEY,
  AUTH_VAULT_STORAGE_KEY,
  DEFAULT_MOODLE_BASE_URL,
  DEFAULT_UNIPD_DOMAIN,
  ShibbolethAuthError,
  clearCredentialsFromVault,
  detectDomainFromUsername,
  executeHeadlessShibbolethLogin,
  fetchMoodleSession,
  isSessionExpiredError,
  loadCredentialsFromVault,
  normalizeShibbolethUsername,
  normalizeUnipdDomain,
  saveCredentialsToVault,
  type EncryptedCredentialEnvelope,
  type MoodleSessionInfo,
  type ShibbolethCredentials,
  type StoredAuthConfig,
  type UnipdDomain,
  type VaultCipherStorage,
  type VaultKeyStore,
} from '../core/index.js';
import { sanitizeErrorMessage } from './download-manager.js';

const KEY_DB_NAME = 'unipd_moodle_vault_db';
const KEY_DB_VERSION = 1;
const KEY_STORE_NAME = 'vault_keys';
const KEY_RECORD_ID = 'shibboleth_aes_gcm_v1';

export interface AuthMetaRecord {
  enabled: boolean;
  username: string | null;
  domain: UnipdDomain;
  blockedReason: string | null;
}

export interface AuthMetaStorage {
  getMeta(): Promise<AuthMetaRecord | null>;
  setMeta(meta: AuthMetaRecord): Promise<void>;
  deleteMeta(): Promise<void>;
}

const DEFAULT_META_RECORD: AuthMetaRecord = {
  enabled: false,
  username: null,
  domain: DEFAULT_UNIPD_DOMAIN,
  blockedReason: null,
};

function openVaultKeyDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable in this environment.'));
      return;
    }
    const req = indexedDB.open(KEY_DB_NAME, KEY_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(KEY_STORE_NAME)) {
        db.createObjectStore(KEY_STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open vault IndexedDB.'));
  });
}

export function createIndexedDbVaultKeyStore(): VaultKeyStore {
  return {
    async getKey() {
      if (typeof indexedDB === 'undefined') {
        return null;
      }
      const db = await openVaultKeyDb();
      try {
        return await new Promise<CryptoKey | null>((resolve, reject) => {
          const tx = db.transaction(KEY_STORE_NAME, 'readonly');
          const store = tx.objectStore(KEY_STORE_NAME);
          const req = store.get(KEY_RECORD_ID);
          req.onsuccess = () => {
            const val = req.result as CryptoKey | undefined;
            resolve(val ?? null);
          };
          req.onerror = () => reject(req.error ?? new Error('Failed to read vault key.'));
        });
      } finally {
        db.close();
      }
    },
    async setKey(key) {
      const db = await openVaultKeyDb();
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(KEY_STORE_NAME, 'readwrite');
          const store = tx.objectStore(KEY_STORE_NAME);
          store.put(key, KEY_RECORD_ID);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error ?? new Error('Failed to persist vault key.'));
          tx.onabort = () => reject(tx.error ?? new Error('Vault key transaction aborted.'));
        });
      } finally {
        db.close();
      }
    },
    async deleteKey() {
      if (typeof indexedDB === 'undefined') {
        return;
      }
      const db = await openVaultKeyDb();
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(KEY_STORE_NAME, 'readwrite');
          const store = tx.objectStore(KEY_STORE_NAME);
          store.delete(KEY_RECORD_ID);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error ?? new Error('Failed to delete vault key.'));
        });
      } finally {
        db.close();
      }
    },
  };
}

export function createChromeVaultCipherStorage(): VaultCipherStorage {
  return {
    async getEnvelope() {
      if (typeof chrome === 'undefined' || !chrome.storage?.local) {
        return null;
      }
      const res = await chrome.storage.local.get(AUTH_VAULT_STORAGE_KEY);
      const raw = res[AUTH_VAULT_STORAGE_KEY] as EncryptedCredentialEnvelope | undefined;
      return raw ?? null;
    },
    async setEnvelope(envelope) {
      if (typeof chrome === 'undefined' || !chrome.storage?.local) {
        throw new Error('chrome.storage.local is unavailable.');
      }
      await chrome.storage.local.set({ [AUTH_VAULT_STORAGE_KEY]: envelope });
    },
    async deleteEnvelope() {
      if (typeof chrome === 'undefined' || !chrome.storage?.local?.remove) {
        return;
      }
      await chrome.storage.local.remove(AUTH_VAULT_STORAGE_KEY);
    },
  };
}

function normalizeMetaRecord(raw: unknown): AuthMetaRecord {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_META_RECORD };
  }
  const obj = raw as Record<string, unknown>;
  const domain = normalizeUnipdDomain(obj.domain);
  const username =
    typeof obj.username === 'string' && obj.username.trim()
      ? normalizeShibbolethUsername(obj.username, domain)
      : null;
  const blockedReason =
    typeof obj.blockedReason === 'string' && obj.blockedReason.trim()
      ? obj.blockedReason.trim()
      : null;

  return {
    enabled: Boolean(obj.enabled),
    username,
    domain: username ? detectDomainFromUsername(username, domain) : domain,
    blockedReason,
  };
}

export function createChromeAuthMetaStorage(): AuthMetaStorage {
  return {
    async getMeta() {
      if (typeof chrome === 'undefined' || !chrome.storage?.local) {
        return null;
      }
      const res = await chrome.storage.local.get(AUTH_META_STORAGE_KEY);
      return res[AUTH_META_STORAGE_KEY] ? normalizeMetaRecord(res[AUTH_META_STORAGE_KEY]) : null;
    },
    async setMeta(meta) {
      if (typeof chrome === 'undefined' || !chrome.storage?.local) {
        return;
      }
      await chrome.storage.local.set({ [AUTH_META_STORAGE_KEY]: meta });
    },
    async deleteMeta() {
      if (typeof chrome === 'undefined' || !chrome.storage?.local?.remove) {
        return;
      }
      await chrome.storage.local.remove(AUTH_META_STORAGE_KEY);
    },
  };
}

export interface AuthManagerOptions {
  keyStore?: VaultKeyStore;
  cipherStorage?: VaultCipherStorage;
  metaStorage?: AuthMetaStorage;
  fetchImpl?: typeof fetch;
  moodleBaseUrl?: string;
  onSessionUpdated?: (session: MoodleSessionInfo) => void | Promise<void>;
  onAuthConfigUpdated?: (config: StoredAuthConfig) => void | Promise<void>;
}

/**
 * Coordinates S1 encrypted local credentials, T1 headless Shibboleth login,
 * singleflight concurrency deduplication, retry-once expiry recovery, and
 * persistent failed-login circuit breaking inside the MV3 service worker.
 */
export class AuthManager {
  private readonly keyStore: VaultKeyStore;
  private readonly cipherStorage: VaultCipherStorage;
  private readonly metaStorage: AuthMetaStorage;
  private readonly customFetchImpl?: typeof fetch;
  private readonly moodleBaseUrl: string;
  private readonly onSessionUpdated?: (session: MoodleSessionInfo) => void | Promise<void>;
  private readonly onAuthConfigUpdated?: (config: StoredAuthConfig) => void | Promise<void>;

  private inFlightAuth: Promise<MoodleSessionInfo> | null = null;
  private mutationChain: Promise<unknown> = Promise.resolve();

  constructor(options: AuthManagerOptions = {}) {
    this.keyStore = options.keyStore ?? createIndexedDbVaultKeyStore();
    this.cipherStorage = options.cipherStorage ?? createChromeVaultCipherStorage();
    this.metaStorage = options.metaStorage ?? createChromeAuthMetaStorage();
    this.customFetchImpl = options.fetchImpl;
    this.moodleBaseUrl = options.moodleBaseUrl ?? DEFAULT_MOODLE_BASE_URL;
    this.onSessionUpdated = options.onSessionUpdated;
    this.onAuthConfigUpdated = options.onAuthConfigUpdated;
  }

  private resolveFetchImpl(): typeof fetch {
    return this.customFetchImpl ?? fetch;
  }

  private runSerialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutationChain.then(fn, fn);
    this.mutationChain = next.catch(() => undefined);
    return next;
  }

  async getAuthConfig(): Promise<StoredAuthConfig> {
    try {
      const [meta, envelope] = await Promise.all([
        this.metaStorage.getMeta(),
        this.cipherStorage.getEnvelope(),
      ]);
      const normalized = meta ?? { ...DEFAULT_META_RECORD };
      const configured = Boolean(envelope);
      return {
        configured,
        enabled: configured && normalized.enabled,
        username: configured ? normalized.username : null,
        domain: normalized.domain,
        blockedReason: normalized.blockedReason,
      };
    } catch {
      return {
        configured: false,
        enabled: false,
        username: null,
        domain: DEFAULT_UNIPD_DOMAIN,
        blockedReason: null,
      };
    }
  }

  private async emitConfigUpdated(): Promise<StoredAuthConfig> {
    const config = await this.getAuthConfig();
    await this.onAuthConfigUpdated?.(config);
    return config;
  }

  async saveCredentials(params: {
    username: string;
    domain: UnipdDomain;
    password: string;
    enabled: boolean;
  }): Promise<StoredAuthConfig> {
    return this.runSerialized(async () => {
      const creds: ShibbolethCredentials = {
        username: params.username,
        domain: normalizeUnipdDomain(params.domain),
        password: params.password,
      };
      const normalized = await saveCredentialsToVault(
        creds,
        this.keyStore,
        this.cipherStorage,
      );
      await this.metaStorage.setMeta({
        enabled: Boolean(params.enabled),
        username: normalized.username,
        domain: normalized.domain,
        blockedReason: null,
      });
      return this.emitConfigUpdated();
    });
  }

  async setAutoLoginEnabled(enabled: boolean): Promise<StoredAuthConfig> {
    return this.runSerialized(async () => {
      const current = (await this.metaStorage.getMeta()) ?? { ...DEFAULT_META_RECORD };
      await this.metaStorage.setMeta({
        ...current,
        enabled: Boolean(enabled),
      });
      return this.emitConfigUpdated();
    });
  }

  async clearCredentials(): Promise<StoredAuthConfig> {
    return this.runSerialized(async () => {
      await clearCredentialsFromVault(this.keyStore, this.cipherStorage);
      await this.metaStorage.deleteMeta();
      return this.emitConfigUpdated();
    });
  }

  private async recordBlockedReason(reason: string | null): Promise<void> {
    await this.runSerialized(async () => {
      const current = (await this.metaStorage.getMeta()) ?? { ...DEFAULT_META_RECORD };
      await this.metaStorage.setMeta({
        ...current,
        blockedReason: reason,
      });
      await this.emitConfigUpdated();
    });
  }

  /**
   * Checks the active browser Moodle session first, and if unauthenticated and
   * eligible, runs at most one concurrent headless UniPD Shibboleth login.
   */
  async ensureAuthenticated(
    options: { allowAutoLogin?: boolean; forceAutoLogin?: boolean } = {},
  ): Promise<MoodleSessionInfo> {
    const allowAutoLogin = options.allowAutoLogin ?? true;
    const forceAutoLogin = options.forceAutoLogin ?? false;

    if (this.inFlightAuth) {
      return this.inFlightAuth;
    }

    const run = (async (): Promise<MoodleSessionInfo> => {
      const fetchImpl = this.resolveFetchImpl();
      const existing = await fetchMoodleSession(this.moodleBaseUrl, fetchImpl);
      if (existing.authenticated) {
        return existing;
      }

      if (!allowAutoLogin) {
        return existing;
      }

      const config = await this.getAuthConfig();
      if (!config.configured) {
        return existing;
      }
      if (!forceAutoLogin && (!config.enabled || config.blockedReason)) {
        return existing;
      }

      const loaded = await loadCredentialsFromVault(this.keyStore, this.cipherStorage);
      if (loaded.status === 'empty') {
        return existing;
      }
      if (loaded.status === 'corrupted') {
        await this.runSerialized(async () => {
          await clearCredentialsFromVault(this.keyStore, this.cipherStorage);
          await this.metaStorage.setMeta({
            enabled: false,
            username: null,
            domain: config.domain,
            blockedReason: 'Saved credentials could not be unlocked; please re-enter them.',
          });
          await this.emitConfigUpdated();
        });
        if (forceAutoLogin) {
          throw new Error('Saved credentials could not be unlocked; please re-enter them.');
        }
        return existing;
      }

      try {
        const session = await executeHeadlessShibbolethLogin({
          credentials: loaded.credentials,
          moodleBaseUrl: this.moodleBaseUrl,
          fetchImpl,
        });

        if (config.blockedReason) {
          await this.recordBlockedReason(null);
        }
        await this.onSessionUpdated?.(session);
        return session;
      } catch (err) {
        if (err instanceof ShibbolethAuthError && err.tripCircuitBreaker) {
          await this.recordBlockedReason(sanitizeErrorMessage(err.message));
        }
        throw err;
      }
    })();

    this.inFlightAuth = run;
    try {
      return await run;
    } finally {
      if (this.inFlightAuth === run) {
        this.inFlightAuth = null;
      }
    }
  }

  /**
   * Executes `operation` and, if it fails due to an expired Moodle session while
   * auto-login is enabled and unblocked, re-authenticates once via singleflight
   * and retries `operation` at most once.
   */
  async withAutoReauth<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (err) {
      if (!isSessionExpiredError(err)) {
        throw err;
      }

      const config = await this.getAuthConfig();
      if (!config.configured || !config.enabled || config.blockedReason) {
        throw err;
      }

      const session = await this.ensureAuthenticated({ allowAutoLogin: true });
      if (!session.authenticated) {
        throw err;
      }

      return await operation();
    }
  }
}
