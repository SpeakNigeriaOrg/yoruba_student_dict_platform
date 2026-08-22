// handlers/deleteWord.ts
//
// Curator-gated removal of an entry, and the preview that has to come first.
//
// ---------------------------------------------------------------------------
// Why a delete exists at all
// ---------------------------------------------------------------------------
// Until now nothing could remove a word, so a mistyped or mis-chosen entry was
// permanent. That is worse than untidy: 0017 makes a citation exclusive - one
// etymology, one word - so a word added against the wrong Kaikki sense holds that
// etymology hostage, and the RIGHT word can never be added at all. The delete is what
// gives the citation back.
//
// ---------------------------------------------------------------------------
// Two things it refuses to do
// ---------------------------------------------------------------------------
// 1. Delete a word other entries are built from. golden_record_components'
//    component_word_id has no ON DELETE CASCADE (0001, deliberately), so Postgres would
//    refuse anyway - this refuses first and names the entries, because "violates foreign
//    key constraint golden_record_components_component_word_id_fkey" is not an answer a
//    curator can act on.
//
// 2. Destroy attached work without being told twice. Audio bytes live in Postgres
//    (0005), not in a bucket with versioning, so a volunteer's recordings are gone in
//    the sense that nothing can bring them back. previewWordDeletion is therefore not a
//    convenience: it is the only chance anyone gets to see what the cascade will take,
//    and deleteWord refuses outright unless the caller has passed confirm after seeing
//    it.
//
// A word with nothing attached - the mistake caught five minutes after making it, which
// is the common case - needs no confirm and no ceremony.
//
// ---------------------------------------------------------------------------
// What it leaves behind
// ---------------------------------------------------------------------------
// Published R2 objects (words/{speaker}/{word_id}.wav, images/{style}/{word_id}.png).
// Nothing here can reach the bucket, and scripts/publishToR2.mjs already reports exactly
// this class of leftover - an object referenced by no manifest - and deletes it with
// --prune. So the next publish names them; it is not silent.

import type pg from 'pg';
import { withTransaction, type Queryable } from '../db.js';
import { WordNotFoundError } from './errors.js';
import { assertWordIdReferencesKnown, WORD_ID_COLUMNS } from './wordIdReferences.js';

export interface AttachedRows {
  label: string;
  count: number;
}

export interface WordDeletionImpact {
  wordId: string;
  displayText: string;
  /** Only what actually exists - a zero row is noise in a confirmation prompt. */
  attached: AttachedRows[];
  /** Sum of `attached`. Zero means the word can be deleted without a confirm. */
  attachedTotal: number;
  /** word_ids of entries that list this word among their parts. Non-empty means the
   * delete is refused however it is confirmed - detach or delete those entries first. */
  usedAsComponentOf: string[];
}

async function countRows(db: Queryable, table: string, column: string, wordId: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>(`select count(*)::text as n from ${table} where ${column} = $1`, [wordId]);
  return Number(rows[0]?.n ?? 0);
}

/** What deleting this word would take with it.
 *
 * Read-only, and safe to call on every open of the danger zone. Table and column names come
 * from WORD_ID_COLUMNS, never from a request, which is what makes the interpolation above
 * safe. */
export async function previewWordDeletion(db: Queryable, wordId: string): Promise<WordDeletionImpact> {
  const word = await db.query<{ display_text: string }>('select display_text from golden_record where word_id = $1', [
    wordId,
  ]);
  if ((word.rowCount ?? 0) === 0) throw new WordNotFoundError(wordId);

  const attached: AttachedRows[] = [];
  for (const col of WORD_ID_COLUMNS) {
    if (col.blocksDeletion) continue; // reported separately, below - it is a blocker, not a casualty
    const count = await countRows(db, col.table, col.column, wordId);
    if (count > 0) attached.push({ label: col.label, count });
  }

  // Not a word_id column of its own, so WORD_ID_COLUMNS cannot carry it, but it is real
  // destroyed work: every VAD-extracted syllable clip cascades from its utterance. Reported
  // next to the recordings it belongs to rather than left out for being one join away.
  const { rows: syllableRows } = await db.query<{ n: string }>(
    `select count(*)::text as n
       from syllable_observations so
       join utterances u on u.utterance_id = so.utterance_id
      where u.word_id = $1`,
    [wordId],
  );
  const syllableCount = Number(syllableRows[0]?.n ?? 0);
  if (syllableCount > 0) attached.push({ label: 'syllable clips cut from those recordings', count: syllableCount });

  const { rows: owners } = await db.query<{ word_id: string }>(
    'select distinct word_id from golden_record_components where component_word_id = $1 order by word_id',
    [wordId],
  );

  return {
    wordId,
    displayText: word.rows[0].display_text,
    attached,
    attachedTotal: attached.reduce((sum, a) => sum + a.count, 0),
    usedAsComponentOf: owners.map((o) => o.word_id),
  };
}

export class WordIsAComponentError extends Error {
  constructor(
    public readonly wordId: string,
    public readonly usedAsComponentOf: string[],
  ) {
    super(
      `'${wordId}' cannot be deleted while ${usedAsComponentOf.length} other entr` +
        `${usedAsComponentOf.length === 1 ? 'y is' : 'ies are'} built from it (${usedAsComponentOf.join(', ')}) - ` +
        `change their components first.`,
    );
    this.name = 'WordIsAComponentError';
  }
}

export class WordHasAttachedWorkError extends Error {
  constructor(public readonly impact: WordDeletionImpact) {
    super(
      `'${impact.wordId}' still has ${impact.attached.map((a) => `${a.count} ${a.label}`).join(', ')} - ` +
        `deleting it destroys all of that permanently. Re-send with confirm to proceed.`,
    );
    this.name = 'WordHasAttachedWorkError';
  }
}

export interface DeleteWordOptions {
  /** Required only when something is attached. See WordHasAttachedWorkError. */
  confirm?: boolean;
}

/** Deletes the entry and everything that cascades from it, returning what went.
 *
 * The returned impact is measured INSIDE the transaction, immediately before the delete,
 * so it describes what this call actually destroyed rather than what a preview fetched
 * some seconds earlier predicted - a recording uploaded in between is counted, and if it
 * pushes an empty word into non-empty, the missing confirm stops the delete. */
export async function deleteWord(
  pool: pg.Pool,
  wordId: string,
  options: DeleteWordOptions = {},
): Promise<WordDeletionImpact> {
  return withTransaction(pool, async (client) => {
    await assertWordIdReferencesKnown(client);
    const impact = await previewWordDeletion(client, wordId);

    if (impact.usedAsComponentOf.length > 0) throw new WordIsAComponentError(wordId, impact.usedAsComponentOf);
    if (impact.attachedTotal > 0 && !options.confirm) throw new WordHasAttachedWorkError(impact);

    // Explicitly, before golden_record: no foreign key, so nothing would cascade to it and
    // the archive would outlive the word it archives. See wordIdReferences.ts.
    await client.query('delete from word_decisions_premerge where word_id = $1', [wordId]);
    await client.query('delete from golden_record where word_id = $1', [wordId]);
    return impact;
  });
}
