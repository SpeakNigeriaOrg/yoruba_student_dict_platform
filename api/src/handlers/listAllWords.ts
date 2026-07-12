// handlers/listAllWords.ts
//
// Backs GET /words - browse-all-words listing, curator-only (browsing
// everything, not just "my assignments," is a curator capability). Old
// tool precedent: resolver.js always showed all ~90 words per tab, with a
// single "hide confirmed" filter - this is the new platform's equivalent
// data source, filtering handled client-side since the corpus is small.

import type { Queryable } from '../db.js';
import { loadVocab, type AxisDecided } from '../reviewShared.js';

export interface AllWordsListItem {
  wordId: string;
  displayText: string;
  syllables: string[];
  definition: string | null;
  entryType: 'phrase' | null;
  axisDecided: AxisDecided;
}

export async function listAllWords(client: Queryable): Promise<AllWordsListItem[]> {
  const vocab = await loadVocab(client);
  const decisionRows = await client.query<{ word_id: string; axis: 'spelling' | 'definition' | 'etymology' }>(
    'select word_id, axis from word_decisions',
  );
  const decidedByWord = new Map<string, Set<string>>();
  for (const row of decisionRows.rows) {
    const existing = decidedByWord.get(row.word_id);
    if (existing) existing.add(row.axis);
    else decidedByWord.set(row.word_id, new Set([row.axis]));
  }

  return Object.entries(vocab)
    .map(([wordId, entry]) => {
      const decided = decidedByWord.get(wordId) ?? new Set<string>();
      return {
        wordId,
        displayText: entry.displayText,
        syllables: entry.syllables,
        definition: entry.definition ?? null,
        entryType: entry.type ?? null,
        axisDecided: { spelling: decided.has('spelling'), definition: decided.has('definition'), etymology: decided.has('etymology') },
      };
    })
    .sort((a, b) => a.wordId.localeCompare(b.wordId));
}
