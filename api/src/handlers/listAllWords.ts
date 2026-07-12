// handlers/listAllWords.ts
//
// Backs GET /words - browse-all-words listing, curator-only (browsing
// everything, not just "my assignments," is a curator capability). Old
// tool precedent: resolver.js always showed all ~90 words per tab, with a
// single "hide confirmed" filter - this is the new platform's equivalent
// data source, filtering handled client-side since the corpus is small.

import type { Queryable } from '../db.js';
import { loadAxisDecidedBatch, loadVocab, type AxisDecided } from '../reviewShared.js';

export interface AllWordsListItem {
  wordId: string;
  displayText: string;
  syllables: string[];
  definition: string | null;
  entryType: 'phrase' | null;
  axisDecided: AxisDecided;
}

export async function listAllWords(client: Queryable, userId: string): Promise<AllWordsListItem[]> {
  const vocab = await loadVocab(client);
  const wordIds = Object.keys(vocab);
  const axisDecidedByWord = await loadAxisDecidedBatch(client, wordIds, userId);

  return wordIds
    .map((wordId) => {
      const entry = vocab[wordId];
      return {
        wordId,
        displayText: entry.displayText,
        syllables: entry.syllables,
        definition: entry.definition ?? null,
        entryType: entry.type ?? null,
        axisDecided: axisDecidedByWord.get(wordId)!,
      };
    })
    .sort((a, b) => a.wordId.localeCompare(b.wordId));
}
