// reviewShared.ts
//
// Loading logic shared by all three GET .../review-axis endpoints
// (getEtymologyReview.ts, getSpellingReview.ts, getDefinitionReview.ts) -
// factored out once a second and third consumer needed the exact same
// full-vocab load and per-word axis-decided lookup.

import type { DiagnoseOverride, DiagnosticsOverrides, Vocab } from '@yoruba-student-dict-platform/shared';
import type { Queryable } from './db.js';

export async function loadVocab(client: Queryable): Promise<Vocab> {
  const words = await client.query<{
    word_id: string;
    display_text: string;
    syllables: string[];
    definition: string | null;
    entry_type: 'phrase' | null;
  }>('select word_id, display_text, syllables, definition, entry_type from golden_record');
  const componentRows = await client.query<{ word_id: string; component_word_id: string }>(
    'select word_id, component_word_id from golden_record_components order by word_id, component_position',
  );
  const componentsByWord = new Map<string, string[]>();
  for (const row of componentRows.rows) {
    const existing = componentsByWord.get(row.word_id);
    if (existing) existing.push(row.component_word_id);
    else componentsByWord.set(row.word_id, [row.component_word_id]);
  }

  const vocab: Vocab = {};
  for (const row of words.rows) {
    vocab[row.word_id] = {
      displayText: row.display_text,
      syllables: row.syllables,
      ...(row.definition !== null ? { definition: row.definition } : {}),
      ...(row.entry_type === 'phrase' ? { type: 'phrase' as const } : {}),
      ...(componentsByWord.has(row.word_id) ? { components: componentsByWord.get(row.word_id) } : {}),
    };
  }
  return vocab;
}

export interface AxisDecided {
  spelling: boolean;
  definition: boolean;
  etymology: boolean;
  // Unlike the other three (a curator's formal word_decisions row), audio
  // has no decision step yet - this just reflects whether at least one
  // recording has been registered for the word, same "status at a
  // glance" purpose for the review-axis tabs.
  audio: boolean;
}

/** Whether each of the platform's three decision-driven review axes
 * already has a word_decisions row for this word, plus whether audio has
 * at least one registered recording - shown as read-only context on
 * every review screen so a curator on one axis isn't left guessing about
 * the other three. */
export async function loadAxisDecided(client: Queryable, wordId: string): Promise<AxisDecided> {
  const [decisionRows, utteranceRows] = await Promise.all([
    client.query<{ axis: 'spelling' | 'definition' | 'etymology' }>('select axis from word_decisions where word_id = $1', [
      wordId,
    ]),
    client.query('select 1 from utterances where word_id = $1 limit 1', [wordId]),
  ]);
  const decided = new Set(decisionRows.rows.map((r) => r.axis));
  return {
    spelling: decided.has('spelling'),
    definition: decided.has('definition'),
    etymology: decided.has('etymology'),
    audio: (utteranceRows.rowCount ?? 0) > 0,
  };
}

export async function loadDefinition(client: Queryable, wordId: string): Promise<string | null> {
  const result = await client.query<{ definition: string | null }>(
    'select definition from golden_record where word_id = $1',
    [wordId],
  );
  return result.rows[0]?.definition ?? null;
}

/** This word's own existing decision on one axis, in the same field
 * vocabulary diagnoseEntry/checkDefinition expect as a DiagnoseOverride -
 * word_decisions.decision is deliberately kept in that exact vocabulary
 * (see db/migrations/0001_initial_schema.sql's comment on that column), so
 * an already-decided word's review screen reflects its own decision
 * rather than re-proposing as if nothing had been decided yet. */
export async function loadAxisOverride(
  client: Queryable,
  wordId: string,
  axis: 'spelling' | 'definition' | 'etymology',
): Promise<DiagnoseOverride | null> {
  const result = await client.query<{ decision: DiagnoseOverride; note: string | null }>(
    'select decision, note from word_decisions where word_id = $1 and axis = $2',
    [wordId, axis],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { ...row.decision, ...(row.note ? { note: row.note } : {}) };
}

/** Every word's spelling-axis decision at once, keyed by word_id - unlike
 * loadAxisOverride (one word at a time), this is for callers that need to
 * run diagnoseEntry across the WHOLE vocab (e.g. checkDuplicates.ts's
 * duplicate scan, which needs each existing word's own resolved
 * canonicalForm/matchedAltOfTargets to compare a new candidate against). */
export async function loadAllSpellingOverrides(client: Queryable): Promise<DiagnosticsOverrides> {
  const rows = await client.query<{ word_id: string; decision: DiagnoseOverride; note: string | null }>(
    "select word_id, decision, note from word_decisions where axis = 'spelling'",
  );
  const overrides: DiagnosticsOverrides = {};
  for (const row of rows.rows) {
    overrides[row.word_id] = { ...row.decision, ...(row.note ? { note: row.note } : {}) };
  }
  return overrides;
}
