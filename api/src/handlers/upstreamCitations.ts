// handlers/upstreamCitations.ts
//
// Writes the link from a student dictionary entry to the Wiktionary etymology it
// IS (db/migrations/0014_upstream_sense_citations.sql).
//
// ---------------------------------------------------------------------------
// Why the caller sends an id and not a pin
// ---------------------------------------------------------------------------
// The pin is built HERE, server-side, from this database's own corpus. A caller
// that supplied its own pin could send content that never existed upstream, or
// content copied from a corpus generation we no longer hold - and either way the
// pin is the thing drift detection trusts as "what upstream said when a human
// judged it". A forged or stale pin makes every later reconciliation meaningless
// while looking perfectly healthy.
//
// So the client's claim is narrow and checkable: "I cite etymology X". The server
// decides what X says.

import type { Queryable } from '../db.js';
import { buildPin, isCitableEntryId } from '@yoruba-student-dict-platform/shared';
import { loadSenseByEntryId } from '../kaikkiData.js';

/** Cites an etymology, XOR explains why it cannot - the same exclusive-or the
 * 0014 check constraint enforces, expressed in the type so a caller cannot even
 * construct the invalid shapes (both, or neither). */
export type UpstreamCitationInput = { entryId: string } | { exemptReason: string };

/** Validates a citation off the wire. Lives here, next to the type it produces,
 * so the exclusive-or is checked in one place for every HTTP edge that accepts
 * one (POST /api/words and a 'new_entry' contribution).
 *
 * Rejects both-supplied as well as neither: "I cite etymology X, and also there
 * is no etymology" is incoherent, and silently preferring one half would record
 * a citation the submitter did not mean. */
export function parseCitationInput(value: unknown): UpstreamCitationInput {
  if (!value || typeof value !== 'object') {
    throw new Error('citation is required: either { entryId } or { exemptReason }');
  }
  const c = value as Record<string, unknown>;
  const hasEntryId = typeof c.entryId === 'string' && c.entryId.length > 0;
  const hasExempt = typeof c.exemptReason === 'string' && c.exemptReason.trim().length > 0;

  if (hasEntryId && hasExempt) {
    throw new Error('citation must have entryId OR exemptReason, not both');
  }
  if (hasEntryId) return { entryId: c.entryId as string };
  if (hasExempt) return { exemptReason: (c.exemptReason as string).trim() };
  throw new Error(
    'citation must name the Wiktionary etymology this word is (entryId), or explain why it has none (exemptReason)',
  );
}

export class EntryIdNotInCorpusError extends Error {
  constructor(public readonly entryId: string) {
    super(`no Kaikki etymology with entry_id '${entryId}' - re-ingest the corpus, or cite a different etymology`);
    this.name = 'EntryIdNotInCorpusError';
  }
}

export class EntryIdNotCitableError extends Error {
  constructor(public readonly entryId: string) {
    super(
      `entry_id '${entryId}' is a generated fallback id, not a stable upstream id - it is derived from ingest ` +
        `processing order and can point at a different etymology after any re-ingest`,
    );
    this.name = 'EntryIdNotCitableError';
  }
}

export class ExemptReasonRequiredError extends Error {
  constructor() {
    super('a word with no cited etymology needs an explicit exempt_reason saying why');
    this.name = 'ExemptReasonRequiredError';
  }
}

/** Writes the citation for one word.
 *
 * Takes a Queryable rather than a Pool because it must run inside the SAME
 * transaction as the golden_record insert it belongs to - a word that exists
 * without its citation is precisely the state 0014 was written to make
 * unrepresentable.
 *
 * Idempotent per word (on conflict update): re-pinning is a normal curator
 * action after upstream drift, not an error.
 */
export async function writeCitationInTransaction(
  client: Queryable,
  wordId: string,
  citation: UpstreamCitationInput,
  pinnedBy: string | null,
): Promise<void> {
  if ('exemptReason' in citation) {
    const reason = citation.exemptReason.trim();
    if (!reason) throw new ExemptReasonRequiredError();
    await upsert(client, wordId, { entryId: null, exemptReason: reason, pin: {}, pinnedRunId: null }, pinnedBy);
    return;
  }

  if (!isCitableEntryId(citation.entryId)) {
    throw new EntryIdNotCitableError(citation.entryId);
  }

  const sense = await loadSenseByEntryId(client, citation.entryId);
  if (!sense) {
    throw new EntryIdNotInCorpusError(citation.entryId);
  }

  // Read inside the caller's transaction, so the pin cannot be a copy of a
  // corpus that changed between the lookup and the write.
  const { rows } = await client.query<{ run_id: string }>(
    'select run_id from kaikki_ingestion_runs order by ingested_at desc limit 1',
  );

  await upsert(
    client,
    wordId,
    {
      entryId: citation.entryId,
      exemptReason: null,
      pin: buildPin(sense),
      // Null when the runs log has been pruned - 0002 calls that table
      // "lightweight observability, not load-bearing for correctness", so a
      // missing run means "we no longer know which build", never a failed write.
      pinnedRunId: rows[0]?.run_id ?? null,
    },
    pinnedBy,
  );
}

async function upsert(
  client: Queryable,
  wordId: string,
  row: { entryId: string | null; exemptReason: string | null; pin: unknown; pinnedRunId: string | null },
  pinnedBy: string | null,
): Promise<void> {
  await client.query(
    `insert into upstream_citations (word_id, entry_id, exempt_reason, pin, pinned_run_id, pinned_by)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (word_id) do update set
       entry_id      = excluded.entry_id,
       exempt_reason = excluded.exempt_reason,
       pin           = excluded.pin,
       pinned_run_id = excluded.pinned_run_id,
       pinned_at     = now(),
       pinned_by     = excluded.pinned_by`,
    [wordId, row.entryId, row.exemptReason, JSON.stringify(row.pin), row.pinnedRunId, pinnedBy],
  );
}
