import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { issueUploadSasToken } from './issueUploadSasToken.js';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.AZURE_STORAGE_ACCOUNT_NAME = 'testaccount';
  process.env.AZURE_STORAGE_ACCOUNT_KEY = Buffer.from('a fake 32+ byte test-only shared key value!!').toString('base64');
  process.env.AZURE_STORAGE_CONTAINER_NAME = 'test-utterances';
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('issueUploadSasToken', () => {
  // This tests the SAS query generation logic in isolation - it can't
  // verify a token actually grants real upload access, since no real
  // Azure Storage Account exists yet to test against (see api/README.md).

  it('builds a container URL and blob prefix scoped to the given wordId', () => {
    const result = issueUploadSasToken('owo_hand');

    expect(result.containerUrl).toBe('https://testaccount.blob.core.windows.net/test-utterances');
    expect(result.blobPrefix).toMatch(/^utterances\/owo_hand\/[0-9a-f-]{36}\/$/);
  });

  it('generates a SAS query string with create+write permissions and an expiry', () => {
    const result = issueUploadSasToken('owo_hand');

    const params = new URLSearchParams(result.sasQuery);
    expect(params.get('sp')).toBe('cw'); // create + write only - no read/delete/list
    expect(params.has('se')).toBe(true); // expiry present
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('expires roughly 15 minutes from now', () => {
    const before = Date.now();
    const result = issueUploadSasToken('owo_hand');
    const expiresInMs = new Date(result.expiresAt).getTime() - before;

    expect(expiresInMs).toBeGreaterThan(14 * 60 * 1000);
    expect(expiresInMs).toBeLessThan(16 * 60 * 1000);
  });

  it('generates a distinct blobPrefix on every call (no submission ID collisions)', () => {
    const first = issueUploadSasToken('owo_hand');
    const second = issueUploadSasToken('owo_hand');

    expect(first.blobPrefix).not.toBe(second.blobPrefix);
  });

  it('throws when storage account env vars are not configured', () => {
    delete process.env.AZURE_STORAGE_ACCOUNT_NAME;
    delete process.env.AZURE_STORAGE_ACCOUNT_KEY;

    expect(() => issueUploadSasToken('owo_hand')).toThrow(/AZURE_STORAGE_ACCOUNT_NAME/);
  });
});
