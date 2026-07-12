// storageConfig.ts
//
// Azure Blob Storage connection details, read from env vars the same way
// db.ts reads DATABASE_URL - separate account-name/key/container vars
// rather than parsing a connection string, to keep this one small piece
// simple. No real Azure Storage Account exists yet to verify these
// against (see api/README.md) - this is real, correct-per-the-SDK-docs
// code, not a stub, but genuinely unverified end-to-end until one is
// provisioned.

export interface StorageConfig {
  accountName: string;
  accountKey: string;
  containerName: string;
}

export function getStorageConfig(): StorageConfig {
  const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
  const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY;
  if (!accountName || !accountKey) {
    throw new Error('AZURE_STORAGE_ACCOUNT_NAME and AZURE_STORAGE_ACCOUNT_KEY must be set');
  }
  return {
    accountName,
    accountKey,
    containerName: process.env.AZURE_STORAGE_CONTAINER_NAME || 'utterances',
  };
}
