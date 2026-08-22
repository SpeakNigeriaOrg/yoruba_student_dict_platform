// handlers/wordIdReferences.ts
//
// Every place a word_id is stored, named once, because two operations need the same
// answer and both fail SILENTLY when it is incomplete.
//
//   RENAME must move every one of them. A column this list forgets keeps pointing at
//   the old id, and then the delete of the old golden_record row - the last step of a
//   rename - CASCADES it away. The word keeps its recordings and loses its images, with
//   a 200 back and nothing in the response to say so.
//
//   DELETE must count every one of them, because the count is the whole basis on which
//   a curator decides whether they mean it. A forgotten column is work destroyed that
//   the confirmation prompt never mentioned.
//
// So the list is not the enforcement - assertWordIdReferencesKnown below is. It reads
// the catalog at runtime and refuses to proceed if the database has a foreign key into
// golden_record that this file has not been told about. A future migration adding a
// word_id column therefore breaks rename and delete LOUDLY, on the next call, instead
// of quietly under-counting; the fix is to add the row here.
//
// word_ids also live inside jsonb (a decision's `components` array), which no foreign
// key covers and the catalog cannot find. Those are handled separately in
// renameWord.ts - see JSON_COMPONENT_COLUMNS there.

import type { Queryable } from '../db.js';

export interface WordIdColumn {
  table: string;
  column: string;
  /** What a curator would call these rows, for the deletion preview. Written as a
   * plural noun phrase so it reads after a count: "3 audio recordings". */
  label: string;
  /** True for golden_record_components.component_word_id only: OTHER entries naming this
   * word as one of their parts. Its foreign key has no ON DELETE CASCADE (deliberately -
   * see 0001), so a delete would fail on the constraint anyway; deletion refuses first,
   * naming the entries, instead of surfacing a raw constraint violation. */
  blocksDeletion?: boolean;
}

/** Ordered roughly by how much a curator would mind losing it. */
export const WORD_ID_COLUMNS: WordIdColumn[] = [
  { table: 'utterances', column: 'word_id', label: 'audio recordings' },
  { table: 'word_images', column: 'word_id', label: 'images' },
  { table: 'word_examples', column: 'word_id', label: 'example sentences' },
  { table: 'contributions', column: 'word_id', label: 'contributions (proposals, votes, evidence)' },
  { table: 'word_decisions', column: 'word_id', label: 'review decisions' },
  { table: 'upstream_citations', column: 'word_id', label: 'upstream etymology citation' },
  { table: 'golden_record_components', column: 'word_id', label: "component links (this word's own parts)" },
  { table: 'assignments', column: 'word_id', label: 'review assignments' },
  { table: 'canonical_utterance_selections', column: 'word_id', label: 'canonical recording picks' },
  { table: 'canonical_image_selections', column: 'word_id', label: 'canonical image picks' },
  // No foreign key - 0011 archived the pre-merge spelling/definition rows as a plain table so
  // the collapse would have a rollback path. That makes it invisible to the catalog check
  // below AND immune to the cascade, so a rename that skipped it would leave the audit trail
  // pointing at an id that no longer exists, and a delete that skipped it would leave rows
  // behind for a word that no longer exists.
  { table: 'word_decisions_premerge', column: 'word_id', label: 'archived pre-merge decisions' },
  {
    table: 'golden_record_components',
    column: 'component_word_id',
    label: 'entries built from this word',
    blocksDeletion: true,
  },
];

export class UnknownWordIdReferenceError extends Error {
  constructor(public readonly columns: string[]) {
    super(
      `the database references golden_record(word_id) from ${columns.join(', ')}, which handlers/` +
        `wordIdReferences.ts does not list - renaming or deleting a word would silently miss those ` +
        `rows. Add them to WORD_ID_COLUMNS.`,
    );
    this.name = 'UnknownWordIdReferenceError';
  }
}

/** Refuses to let a rename or delete run against a schema this file has fallen behind.
 *
 * One catalog query per call, which is nothing on operations a curator performs by hand a
 * handful of times a year, and it is the only thing standing between "someone added a table
 * in a migration" and "a rename quietly deleted its rows". */
export async function assertWordIdReferencesKnown(db: Queryable): Promise<void> {
  const { rows } = await db.query<{ table_name: string; column_name: string }>(
    `select tc.table_name, kcu.column_name
       from information_schema.table_constraints tc
       join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name
       join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name
      where tc.constraint_type = 'FOREIGN KEY'
        and ccu.table_name = 'golden_record'
        and ccu.column_name = 'word_id'`,
  );
  const known = new Set(WORD_ID_COLUMNS.map((c) => `${c.table}.${c.column}`));
  const unknown = rows.map((r) => `${r.table_name}.${r.column_name}`).filter((name) => !known.has(name));
  if (unknown.length > 0) throw new UnknownWordIdReferenceError([...new Set(unknown)].sort());
}
