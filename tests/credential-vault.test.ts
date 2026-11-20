import { describe, expect, it } from 'vitest';
import {
  clearCredentialsFromVault,
  detectDomainFromUsername,
  loadCredentialsFromVault,
  normalizeShibbolethUsername,
  normalizeUnipdDomain,
  saveCredentialsToVault,
  type EncryptedCredentialEnvelope,
  type VaultCipherStorage,
  type VaultKeyStore,
} from '../src/core/credential-vault.js';

function createMemoryVaultAdapters() {
  let key: CryptoKey | null = null;
  let envelope: EncryptedCredentialEnvelope | null = null;

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

  return {
    keyStore,
    cipherStorage,
    getRawKey: () => key,
    getRawEnvelope: () => envelope,
    setRawEnvelope: (next: EncryptedCredentialEnvelope | null) => {
      envelope = next;
    },
  };
}

describe('credential-vault (S1 AES-256-GCM + non-extractable key)', () => {
  it('normalizes complete and local-part UniPD usernames with @studenti.unipd.it default', () => {
    expect(normalizeUnipdDomain(undefined)).toBe('@studenti.unipd.it');
    expect(normalizeUnipdDomain('@unipd.it')).toBe('@unipd.it');
    expect(normalizeUnipdDomain('@evil.com')).toBe('@studenti.unipd.it');

    expect(normalizeShibbolethUsername('  mario.rossi@studenti.unipd.it  ', '@unipd.it')).toBe(
      'mario.rossi@studenti.unipd.it',
    );
    expect(normalizeShibbolethUsername('mario.rossi', '@studenti.unipd.it')).toBe(
      'mario.rossi@studenti.unipd.it',
    );
    expect(normalizeShibbolethUsername('prof.bianchi', '@unipd.it')).toBe(
      'prof.bianchi@unipd.it',
    );

    expect(detectDomainFromUsername('mario.rossi@unipd.it')).toBe('@unipd.it');
    expect(detectDomainFromUsername('mario.rossi@studenti.unipd.it')).toBe('@studenti.unipd.it');
  });

  it('encrypts with a non-extractable CryptoKey and unique random IVs per save', async () => {
    const adapters = createMemoryVaultAdapters();

    const saved = await saveCredentialsToVault(
      {
        username: 'mario.rossi@studenti.unipd.it',
        domain: '@studenti.unipd.it',
        password: 'My$ecretPassword!42',
      },
      adapters.keyStore,
      adapters.cipherStorage,
    );

    expect(saved).toEqual({
      username: 'mario.rossi@studenti.unipd.it',
      domain: '@studenti.unipd.it',
      password: 'My$ecretPassword!42',
    });

    const rawKey = adapters.getRawKey();
    expect(rawKey).not.toBeNull();
    expect(rawKey?.extractable).toBe(false);
    expect(rawKey?.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });

    const firstEnvelope = adapters.getRawEnvelope();
    expect(firstEnvelope).not.toBeNull();
    expect(firstEnvelope?.ciphertext).not.toContain('My$ecretPassword');
    expect(firstEnvelope?.ciphertext).not.toContain('mario.rossi');

    const loaded = await loadCredentialsFromVault(adapters.keyStore, adapters.cipherStorage);
    expect(loaded).toEqual({
      status: 'ok',
      credentials: saved,
    });

    // Updating reuses key with a fresh random IV
    await saveCredentialsToVault(
      {
        username: 'mario.rossi@studenti.unipd.it',
        domain: '@studenti.unipd.it',
        password: 'UpdatedPassword#99',
      },
      adapters.keyStore,
      adapters.cipherStorage,
    );
    const secondEnvelope = adapters.getRawEnvelope();
    expect(secondEnvelope?.iv).not.toBe(firstEnvelope?.iv);
    expect(secondEnvelope?.ciphertext).not.toBe(firstEnvelope?.ciphertext);

    const updated = await loadCredentialsFromVault(adapters.keyStore, adapters.cipherStorage);
    expect(updated).toEqual({
      status: 'ok',
      credentials: {
        username: 'mario.rossi@studenti.unipd.it',
        domain: '@studenti.unipd.it',
        password: 'UpdatedPassword#99',
      },
    });
  });

  it('preserves leading/trailing password spaces and clears both key and envelope', async () => {
    const adapters = createMemoryVaultAdapters();
    await saveCredentialsToVault(
      {
        username: 'luca.verdi',
        domain: '@studenti.unipd.it',
        password: ' pass with spaces ',
      },
      adapters.keyStore,
      adapters.cipherStorage,
    );

    const loaded = await loadCredentialsFromVault(adapters.keyStore, adapters.cipherStorage);
    expect(loaded).toEqual({
      status: 'ok',
      credentials: {
        username: 'luca.verdi@studenti.unipd.it',
        domain: '@studenti.unipd.it',
        password: ' pass with spaces ',
      },
    });

    await clearCredentialsFromVault(adapters.keyStore, adapters.cipherStorage);
    expect(adapters.getRawKey()).toBeNull();
    expect(adapters.getRawEnvelope()).toBeNull();
    expect(await loadCredentialsFromVault(adapters.keyStore, adapters.cipherStorage)).toEqual({
      status: 'empty',
    });
  });

  it('returns corrupted status cleanly when key is missing or ciphertext is tampered', async () => {
    const adapters = createMemoryVaultAdapters();
    await saveCredentialsToVault(
      {
        username: 'mario.rossi@studenti.unipd.it',
        domain: '@studenti.unipd.it',
        password: 'Secret123!',
      },
      adapters.keyStore,
      adapters.cipherStorage,
    );

    // Tamper ciphertext
    const orig = adapters.getRawEnvelope()!;
    adapters.setRawEnvelope({ ...orig, ciphertext: 'AAAA'.repeat(10) });
    expect(await loadCredentialsFromVault(adapters.keyStore, adapters.cipherStorage)).toEqual({
      status: 'corrupted',
    });

    // Missing key with valid envelope shape
    adapters.setRawEnvelope(orig);
    await adapters.keyStore.deleteKey();
    expect(await loadCredentialsFromVault(adapters.keyStore, adapters.cipherStorage)).toEqual({
      status: 'corrupted',
    });
  });

  it('returns corrupted status cleanly when keyStore/cipherStorage rejects or envelope is malformed', async () => {
    const throwingKeyStore: VaultKeyStore = {
      async getKey() {
        throw new Error('IndexedDB blocked');
      },
      async setKey() {},
      async deleteKey() {},
    };
    const badShapeStorage: VaultCipherStorage = {
      async getEnvelope() {
        return { version: 2, iv: 'abc', ciphertext: 'def', updatedAt: 1 } as unknown as EncryptedCredentialEnvelope;
      },
      async setEnvelope() {},
      async deleteEnvelope() {},
    };
    expect(await loadCredentialsFromVault(throwingKeyStore, badShapeStorage)).toEqual({
      status: 'corrupted',
    });

    const throwingEnvelopeStorage: VaultCipherStorage = {
      async getEnvelope() {
        throw new Error('storage error');
      },
      async setEnvelope() {},
      async deleteEnvelope() {},
    };
    expect(await loadCredentialsFromVault(throwingKeyStore, throwingEnvelopeStorage)).toEqual({
      status: 'corrupted',
    });
  });

  it('rejects empty username or password', async () => {
    const adapters = createMemoryVaultAdapters();
    await expect(
      saveCredentialsToVault(
        { username: '   ', domain: '@studenti.unipd.it', password: 'pw' },
        adapters.keyStore,
        adapters.cipherStorage,
      ),
    ).rejects.toThrow(/username/i);
    await expect(
      saveCredentialsToVault(
        { username: 'user@studenti.unipd.it', domain: '@studenti.unipd.it', password: '' },
        adapters.keyStore,
        adapters.cipherStorage,
      ),
    ).rejects.toThrow(/password/i);
  });
});
