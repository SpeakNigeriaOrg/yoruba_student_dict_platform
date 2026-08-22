// handlers/renameWord.ts
//
// Changes a word's word_id, keeping everything attached to it.
//
// ---------------------------------------------------------------------------
// Why this is not "just an UPDATE"
// ---------------------------------------------------------------------------
// word_id is the primary key of golden_record and the natural key eleven other
// columns reference, none of them declared ON UPDATE CASCADE. So `update golden_record
// set word_id = ...` fails on the first foreign key it meets, and adding the cascades in
// a migration would still not be enough: word_ids also live inside jsonb (a decision's
// `components` array) and inside the consensus fingerprints derived from those arrays,
// where no constraint can reach them.
//
// The move is therefore explicit, in one transaction:
//
//   1. INSERT the row again under the new id. A copy, not an edit, so the children have
//      somewhere valid to point before the old row goes.
//   2. UPDATE every referencing column (wordIdReferences.ts) from old to new.
//   3. Rewrite word_ids stored in jsonb, and the fingerprints derived from them.
//   4. Verify nothing still points at the old id - see the note on step 5.
//   5. DELETE the old row. Every child has already moved, so its ON DELETE CASCADE
//      reaches nothing. That is the ENTIRE safety story for this step, and it is why
//      step 4 exists: if the inventory in wordIdReferences.ts were incomplete, this
//      delete is where the missed rows would quietly disappear, with a 200 in response.
//
// ---------------------------------------------------------------------------
// What it deliberately leaves alone
// ---------------------------------------------------------------------------
// A 'new_entry' contribution's proposed_value.proposedWordId. That field records what
// somebody PROPOSED, at a moment when the old id is what they proposed; rewriting it
// would put a word in their mouth. It refers to nothing (new_entry rows carry a null
// word_id by constraint), so leaving it stale costs nothing.
//
// Published R2 objects keyed by the old id, for the same reason deleteWord.ts leaves
// them: nothing here can reach the bucket, and publishToR2.mjs already reports and
// prunes objects no manifest references.

import type pg from 'pg';
import { renameComponentInFingerprint } from '@yoruba-student-dict-platform/shared';
import { withTransaction } from '../db.js';
import { WordIdAlreadyExistsError, WordNotFoundError } from './errors.js';
import { previewWordDeletion } from './deleteWord.js';
import { assertWordIdReferencesKnown, WORD_ID_COLUMNS } from './wordIdReferences.js';
import { assertWordIdShape } from './wordIdShape.js';

/** jsonb columns holding a top-level `components` array of word_ids.
 *
 * All three share one shape by design - word_decisions.decision and
 * contributions.proposed_value use the same per-axis field vocabulary (0001), and
 * resolved_value is the EtymologyOutcome those resolve to, whose `components` is also a
 * flat list of word_ids. */
const JSON_COMPONENT_COLUMNS = [
  { table: 'word_decisions', column: 'decision' },
  { table: 'contributions', column: 'proposed_value' },
  { table: 'contributions', column: 'resolved_value' },
];

/** Tables carrying a consensus fingerprint derived from a component list. */
const FINGERPRINT_TABLES = [
  { table: 'contributions', key: 'contribution_id' },
  { table: 'word_decisions', key: 'word_id' },
];

export class SameWordIdError extends Error {
  constructor(public readonly wordId: string) {
    super(`'${wordId}' is already this word's id - nothing to rename`);
    this.name = 'SameWordIdError';
  }
}

/** Thrown when step 4 finds a row still pointing at the old id.
 *
 * Only reachable if WORD_ID_COLUMNS has fallen behind a column that the catalog check
 * cannot see either - a table with a word_id but no foreign key, like 0011's archive. It
 * aborts the transaction, so the rename is refused rather than half-applied. */
export class IncompleteRenameError extends Error {
  constructor(
    public readonly wordId: string,
    public readonly remaining: string,
  ) {
    super(
      `refusing to finish renaming '${wordId}': ${remaining} still reference it, so completing the ` +
        `rename would delete them. handlers/wordIdReferences.ts is missing a column.`,
    );
    this.name = 'IncompleteRenameError';
  }
}

export interface RenamedRows {
  label: string;
  count: number;
}

export interface WordRenameResult {
  from: string;
  to: string;
  /** Non-zero counts only, by the same labels the deletion preview uses. */
  moved: RenamedRows[];
  /** Rows whose stored jsonb named the old id among some entry's components. */
  componentReferencesRewritten: number;
  /** Consensus fingerprints re-expressed in the new id. */
  fingerprintsRewritten: number;
}

export async function renameWord(
  pool: pg.Pool,
  fromWordId: string,
  toWordId: string,
  renamedBy: string,
): Promise<WordRenameResult> {
  // Before anything touches the database: the new id becomes a filename, a URL and a
  // storage key exactly as the old one did. See wordIdShape.ts.
  assertWordIdShape(toWordId);
  if (fromWordId === toWordId) throw new SameWordIdError(fromWordId);

  return withTransaction(pool, async (client) => {
    await assertWordIdReferencesKnown(client);

    // FOR UPDATE, so a concurrent write against this word waits rather than landing on the
    // old id between step 2 and step 5 - which step 4 would then catch, turning a race into
    // a refused rename instead of lost rows.
    const source = await client.query('select 1 from golden_record where word_id = $1 for update', [fromWordId]);
    if ((source.rowCount ?? 0) === 0) throw new WordNotFoundError(fromWordId);

    const target = await client.query('select 1 from golden_record where word_id = $1', [toWordId]);
    if ((target.rowCount ?? 0) > 0) throw new WordIdAlreadyExistsError(toWordId);

    // 1. The copy. Written through jsonb rather than as a column list so a column added by
    //    a later migration comes along automatically - a rename that silently dropped a new
    //    column's value would be the same class of quiet loss the whole file guards against.
    await client.query(
      `insert into golden_record
       select (jsonb_populate_record(
                 null::golden_record,
                 to_jsonb(g) || jsonb_build_object('word_id', $2::text, 'updated_by', $3::uuid, 'updated_at', now())
               )).*
         from golden_record g
        where g.word_id = $1`,
      [fromWordId, toWordId, renamedBy],
    );

    // 2. Every referencing column. Names come from the inventory, never from a request.
    const moved: RenamedRows[] = [];
    for (const col of WORD_ID_COLUMNS) {
      const result = await client.query(`update ${col.table} set ${col.column} = $2 where ${col.column} = $1`, [
        fromWordId,
        toWordId,
      ]);
      const count = result.rowCount ?? 0;
      if (count > 0) moved.push({ label: col.label, count });
    }

    // 3a. word_ids inside jsonb component arrays. Not scoped to this word's own rows: the
    //     references that matter most are in OTHER entries' decisions, which name this word
    //     as one of their parts.
    let componentReferencesRewritten = 0;
    for (const { table, column } of JSON_COMPONENT_COLUMNS) {
      const result = await client.query(
        `update ${table}
            set ${column} = jsonb_set(${column}, '{components}',
                  (select jsonb_agg(case when e = $1::jsonb then $2::jsonb else e end)
                     from jsonb_array_elements(${column} -> 'components') e))
          where jsonb_typeof(${column} -> 'components') = 'array'
            and ${column} -> 'components' @> $1::jsonb`,
        [JSON.stringify(fromWordId), JSON.stringify(toWordId)],
      );
      componentReferencesRewritten += result.rowCount ?? 0;
    }

    // 3b. The fingerprints derived from those arrays. Read and rewritten in JS because the
    //     substitution has to use the same field layout fingerprintOutcome wrote - see
    //     shared/src/consensus.ts's renameComponentInFingerprint. `position(...)` rather than
    //     LIKE because a word_id's underscore is a LIKE wildcard.
    let fingerprintsRewritten = 0;
    for (const { table, key } of FINGERPRINT_TABLES) {
      const { rows } = await client.query<{ k: string; value_fingerprint: string }>(
        `select ${key} as k, value_fingerprint from ${table}
          where value_fingerprint is not null and position($1 in value_fingerprint) > 0`,
        [fromWordId],
      );
      for (const row of rows) {
        const rewritten = renameComponentInFingerprint(row.value_fingerprint, fromWordId, toWordId);
        if (rewritten === row.value_fingerprint) continue;
        await client.query(`update ${table} set value_fingerprint = $2 where ${key} = $1`, [row.k, rewritten]);
        fingerprintsRewritten += 1;
      }
    }

    // 4. Nothing may still point at the old id. previewWordDeletion counts exactly the
    //    columns step 2 moved, which is the point: if it finds anything, the delete below
    //    would destroy it.
    const remaining = await previewWordDeletion(client, fromWordId);
    if (remaining.attachedTotal > 0 || remaining.usedAsComponentOf.length > 0) {
      const described = [
        ...remaining.attached.map((a) => `${a.count} ${a.label}`),
        ...(remaining.usedAsComponentOf.length > 0
          ? [`${remaining.usedAsComponentOf.length} component links from ${remaining.usedAsComponentOf.join(', ')}`]
          : []),
      ].join(', ');
      throw new IncompleteRenameError(fromWordId, described);
    }

    // 5. The old row, now childless.
    await client.query('delete from golden_record where word_id = $1', [fromWordId]);

    return { from: fromWordId, to: toWordId, moved, componentReferencesRewritten, fingerprintsRewritten };
  });
}
