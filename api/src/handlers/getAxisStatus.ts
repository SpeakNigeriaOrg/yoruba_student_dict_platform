// handlers/getAxisStatus.ts
//
// Backs GET /words/{wordId}/axis-status - a lightweight companion to the
// three heavier get*Review endpoints (which each already return this same
// axisDecided shape, but bundled with a full diagnosis/candidate load).
// Exists so the axis-tab bar (App.tsx) can color all four tabs by status
// as soon as a word is selected, without waiting on whichever single
// axis screen happens to be showing.

import { loadAxisDecided, type AxisDecided } from '../reviewShared.js';
import type { Queryable } from '../db.js';
import { WordNotFoundError } from './errors.js';

export async function getAxisStatus(client: Queryable, wordId: string, userId: string): Promise<AxisDecided> {
  const wordResult = await client.query('select 1 from golden_record where word_id = $1', [wordId]);
  if (wordResult.rowCount === 0) throw new WordNotFoundError(wordId);
  return loadAxisDecided(client, wordId, userId);
}
