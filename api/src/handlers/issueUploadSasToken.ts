// handlers/issueUploadSasToken.ts
//
// Backs POST /utterances/sas-token - issues one container-scoped,
// write-only, short-lived SAS token covering an entire recording
// submission (the two-take whole-word/whole-utterance blobs plus one
// clip per detected syllable segment - see REMOTE_ACCESS_DISCUSSION.md's
// "Audio pipeline" section), rather than round-tripping once per blob.
// The client builds each blob's upload URL by appending this same SAS
// query string to a path under blobPrefix.
//
// Real, correct-per-the-@azure/storage-blob-SDK-docs code - but there is
// no real Azure Storage Account yet to verify an issued token actually
// grants real upload access (see api/README.md's own "known limits, not
// glossed over" pattern for the SWA auth handshake - same category of
// gap here).

import { ContainerSASPermissions, generateBlobSASQueryParameters, SASProtocol, StorageSharedKeyCredential } from '@azure/storage-blob';
import { getStorageConfig } from '../storageConfig.js';

export interface UploadSasTokenResult {
  containerUrl: string;
  sasQuery: string;
  blobPrefix: string;
  expiresAt: string;
}

const TOKEN_LIFETIME_MS = 15 * 60 * 1000;

export function issueUploadSasToken(wordId: string): UploadSasTokenResult {
  const { accountName, accountKey, containerName } = getStorageConfig();
  const credential = new StorageSharedKeyCredential(accountName, accountKey);

  const startsOn = new Date();
  const expiresOn = new Date(startsOn.getTime() + TOKEN_LIFETIME_MS);
  const submissionId = crypto.randomUUID();

  const sasQuery = generateBlobSASQueryParameters(
    {
      containerName,
      permissions: ContainerSASPermissions.parse('cw'), // create + write, no read/delete/list
      protocol: SASProtocol.Https,
      startsOn,
      expiresOn,
    },
    credential,
  ).toString();

  return {
    containerUrl: `https://${accountName}.blob.core.windows.net/${containerName}`,
    sasQuery,
    blobPrefix: `utterances/${wordId}/${submissionId}/`,
    expiresAt: expiresOn.toISOString(),
  };
}
