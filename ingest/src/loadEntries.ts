// loadEntries.ts
//
// Loads the canonical artifact published by the kaikki-yoruba repo -
// either a local file (for local dev/tests, or a CI checkout of that
// artifact) or the latest GitHub Release (production use).

import { readFile } from 'node:fs/promises';
import type { CanonicalEntries } from './types.js';

export async function loadEntriesFromFile(filePath: string): Promise<CanonicalEntries> {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw) as CanonicalEntries;
}

export interface ArtifactMetadata {
  generatedAt: string;
  sourceDate: string | null;
  sourceFile: string;
  recordCount: number;
  parseErrorCount: number;
  contentHash: string;
}

export async function loadMetadataFromFile(filePath: string): Promise<ArtifactMetadata> {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw) as ArtifactMetadata;
}

export const KAIKKI_YORUBA_LATEST_RELEASE_API_URL =
  'https://api.github.com/repos/SpeakNigeriaOrg/kaikki-yoruba/releases/latest';

interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface GitHubRelease {
  tag_name: string;
  assets: GitHubReleaseAsset[];
}

export class ArtifactAssetNotFoundError extends Error {
  constructor(assetName: string) {
    super(`kaikki-yoruba's latest release has no asset named '${assetName}'`);
    this.name = 'ArtifactAssetNotFoundError';
  }
}

/** Resolves entries.json/metadata.json download URLs from kaikki-yoruba's
 * latest GitHub Release, rather than a hardcoded path - each run publishes
 * a fresh release, so "latest" is always the right one to consume. */
export async function resolveLatestArtifactUrls(): Promise<{ tagName: string; entriesUrl: string; metadataUrl: string }> {
  const response = await fetch(KAIKKI_YORUBA_LATEST_RELEASE_API_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch kaikki-yoruba's latest release metadata: ${response.status} ${response.statusText}`);
  }
  const release = (await response.json()) as GitHubRelease;

  const entriesAsset = release.assets.find((a) => a.name === 'entries.json');
  if (!entriesAsset) throw new ArtifactAssetNotFoundError('entries.json');
  const metadataAsset = release.assets.find((a) => a.name === 'metadata.json');
  if (!metadataAsset) throw new ArtifactAssetNotFoundError('metadata.json');

  return { tagName: release.tag_name, entriesUrl: entriesAsset.browser_download_url, metadataUrl: metadataAsset.browser_download_url };
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

export async function loadLatestEntriesAndMetadata(): Promise<{
  tagName: string;
  entries: CanonicalEntries;
  metadata: ArtifactMetadata;
}> {
  const { tagName, entriesUrl, metadataUrl } = await resolveLatestArtifactUrls();
  const [entries, metadata] = await Promise.all([
    fetchJson<CanonicalEntries>(entriesUrl),
    fetchJson<ArtifactMetadata>(metadataUrl),
  ]);
  return { tagName, entries, metadata };
}
