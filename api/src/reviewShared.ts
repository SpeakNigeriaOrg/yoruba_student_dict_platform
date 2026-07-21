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
  // Unlike the other three (a curator's formal word_decisions row, a
  // global fact true for everyone), audio has no decision step and is
  // deliberately scoped to the REQUESTING user's own recordings only -
  // every participant is expected to record every word themselves, so
  // "someone already recorded this" would be actively misleading here:
  // it would show green/done for a word this user personally hasn't
  // touched yet, just because a different speaker got to it first.
  audio: boolean;
}

/** Whether each of the platform's three decision-driven review axes
 * already has a word_decisions row for this word (true for everyone,
 * once a curator decides), plus whether the REQUESTING user themselves
 * has at least one registered recording for it (see AxisDecided.audio) -
 * shown as read-only context on every review screen so a curator on one
 * axis isn't left guessing about the other three. */
export async function loadAxisDecided(client: Queryable, wordId: string, userId: string): Promise<AxisDecided> {
  const [decisionRows, utteranceRows] = await Promise.all([
    client.query<{ axis: 'spelling' | 'definition' | 'etymology' }>('select axis from word_decisions where word_id = $1', [
      wordId,
    ]),
    client.query(
      `select 1 from utterances u join speakers s on s.speaker_id = u.speaker_id
       where u.word_id = $1 and s.user_id = $2 limit 1`,
      [wordId, userId],
    ),
  ]);
  const decided = new Set(decisionRows.rows.map((r) => r.axis));
  return {
    spelling: decided.has('spelling'),
    definition: decided.has('definition'),
    etymology: decided.has('etymology'),
    audio: (utteranceRows.rowCount ?? 0) > 0,
  };
}

/** Batched version of loadAxisDecided - for callers listing many words at
 * once (listAllWords.ts, listMyAssignments.ts), which each need every
 * word's own status but shouldn't run one query pair per word. Same
 * semantics as loadAxisDecided (audio scoped to the requesting user's
 * own recordings), just computed for a whole word_id set in two queries
 * total instead of 2*N. */
export async function loadAxisDecidedBatch(
  client: Queryable,
  wordIds: string[],
  userId: string,
): Promise<Map<string, AxisDecided>> {
  const [decisionRows, utteranceRows] = await Promise.all([
    client.query<{ word_id: string; axis: 'spelling' | 'definition' | 'etymology' }>(
      'select word_id, axis from word_decisions where word_id = any($1)',
      [wordIds],
    ),
    client.query<{ word_id: string }>(
      `select distinct u.word_id from utterances u join speakers s on s.speaker_id = u.speaker_id
       where s.user_id = $1 and u.word_id = any($2)`,
      [userId, wordIds],
    ),
  ]);
  const decidedByWord = new Map<string, Set<string>>();
  for (const row of decisionRows.rows) {
    const existing = decidedByWord.get(row.word_id);
    if (existing) existing.add(row.axis);
    else decidedByWord.set(row.word_id, new Set([row.axis]));
  }
  const wordsWithAudio = new Set(utteranceRows.rows.map((r) => r.word_id));

  const result = new Map<string, AxisDecided>();
  for (const wordId of wordIds) {
    const decided = decidedByWord.get(wordId) ?? new Set<string>();
    result.set(wordId, {
      spelling: decided.has('spelling'),
      definition: decided.has('definition'),
      etymology: decided.has('etymology'),
      audio: wordsWithAudio.has(wordId),
    });
  }
  return result;
}

export type AxisReviewStatus = 'not_started' | 'in_review' | 'passed';

export interface ReviewStatus {
  spelling: AxisReviewStatus;
  definition: AxisReviewStatus;
  etymology: AxisReviewStatus;
}

/** Per-axis passed/in_review/not_started for a set of words, scoped to one
 * user's own pending contributions - same "2 queries total, not N+1" shape
 * as loadAxisDecidedBatch, for the admin assignment view (listUserAssignments.ts).
 * 'passed' mirrors word_decisions (global, same as AxisDecided); 'in_review'
 * is this user's own pending contribution on that axis - contributions has
 * no FK to assignments, so this is scoped by submitted_by, not by
 * assignment row (the best available signal given the current schema). */
export async function loadReviewStatusBatch(
  client: Queryable,
  wordIds: string[],
  userId: string,
): Promise<Map<string, ReviewStatus>> {
  const [decisionRows, pendingRows] = await Promise.all([
    client.query<{ word_id: string; axis: 'spelling' | 'definition' | 'etymology' }>(
      'select word_id, axis from word_decisions where word_id = any($1)',
      [wordIds],
    ),
    client.query<{ word_id: string; axis: 'spelling' | 'definition' | 'etymology' }>(
      `select word_id, axis from contributions
       where status = 'pending' and submitted_by = $1 and word_id = any($2)
         and axis in ('spelling', 'definition', 'etymology')`,
      [userId, wordIds],
    ),
  ]);
  const passedByWord = new Map<string, Set<string>>();
  for (const row of decisionRows.rows) {
    const existing = passedByWord.get(row.word_id);
    if (existing) existing.add(row.axis);
    else passedByWord.set(row.word_id, new Set([row.axis]));
  }
  const pendingByWord = new Map<string, Set<string>>();
  for (const row of pendingRows.rows) {
    const existing = pendingByWord.get(row.word_id);
    if (existing) existing.add(row.axis);
    else pendingByWord.set(row.word_id, new Set([row.axis]));
  }

  const axes = ['spelling', 'definition', 'etymology'] as const;
  const result = new Map<string, ReviewStatus>();
  for (const wordId of wordIds) {
    const passed = passedByWord.get(wordId) ?? new Set<string>();
    const pending = pendingByWord.get(wordId) ?? new Set<string>();
    const entry = {} as ReviewStatus;
    for (const axis of axes) {
      entry[axis] = passed.has(axis) ? 'passed' : pending.has(axis) ? 'in_review' : 'not_started';
    }
    result.set(wordId, entry);
  }
  return result;
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
