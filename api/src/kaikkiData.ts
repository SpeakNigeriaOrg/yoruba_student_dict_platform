// kaikkiData.ts
//
// Postgres-backed KaikkiSense lookup - reads the tables ingest/ populates
// (db/migrations/0002_kaikki_lexicon.sql) and produces the same KaikkiSense
// shape shared/'s diagnoseEntry/componentsAxis already work with, so
// verification/resolution logic doesn't need reimplementing a third time
// (see the approved plan's "Close the adopt_kaikki verification gap"
// section for the full rationale). Queries by orthography-insensitive key
// rather than loading the whole lexicon into memory - the "real, queryable
// tables" this migration exists for, not another full in-memory load.

import type { ComponentCandidate, KaikkiLexicon, KaikkiSense } from '@yoruba-student-dict-platform/shared';
import type { Queryable } from './db.js';

interface KaikkiSenseRow {
  pos: string | null;
  etymology_number: string | null;
  etymology_text: string | null;
  headword: string;
  canonical_value: string;
  canonical_inference_method: string;
  canonical_confidence: string | number;
  canonical_original_value: string;
  standard_forms: string[];
  glosses: string[];
  alt_of_targets: string[];
  component_candidates: ComponentCandidate[];
  used_in_candidates: ComponentCandidate[];
}

function rowToKaikkiSense(row: KaikkiSenseRow): KaikkiSense {
  return {
    pos: row.pos ?? '',
    etymologyNumber: row.etymology_number,
    etymologyText: row.etymology_text,
    headword: row.headword,
    canonicalForm: {
      value: row.canonical_value,
      inferenceMethod: row.canonical_inference_method,
      // numeric columns come back as strings from pg by default - Number()
      // the same way every other numeric read in this codebase does.
      confidence: Number(row.canonical_confidence),
      originalValue: row.canonical_original_value,
    },
    standardForms: row.standard_forms,
    glosses: row.glosses,
    altOfTargets: row.alt_of_targets,
    componentCandidates: row.component_candidates,
    usedInCandidates: row.used_in_candidates,
    // Never persisted (see ingest/'s own design notes) - only ever an
    // input to reciprocal synthesis at ingestion time, not meant to be
    // reloaded, same as the Python original.
    derivedForms: [],
  };
}

export async function loadKaikkiSensesForKey(client: Queryable, orthographyInsensitiveKey: string): Promise<KaikkiSense[]> {
  const { rows } = await client.query<KaikkiSenseRow>(
    `select s.pos, s.etymology_number, s.etymology_text, s.headword, s.canonical_value,
            s.canonical_inference_method, s.canonical_confidence,
            s.canonical_original_value, s.standard_forms, s.glosses, s.alt_of_targets,
            coalesce(
              (select json_agg(json_build_object('form', c.form, 'provenance', c.provenance) order by c.position)
               from kaikki_component_candidates c where c.sense_id = s.sense_id),
              '[]'::json
            ) as component_candidates,
            coalesce(
              (select json_agg(json_build_object('form', u.form, 'provenance', u.provenance) order by u.position)
               from kaikki_used_in_candidates u where u.sense_id = s.sense_id),
              '[]'::json
            ) as used_in_candidates
     from kaikki_senses s
     join kaikki_sense_keys k on k.sense_id = s.sense_id
     where k.orthography_insensitive_key = $1`,
    [orthographyInsensitiveKey],
  );
  return rows.map(rowToKaikkiSense);
}

/** Loads the whole Kaikki corpus into memory, keyed by
 * orthography-insensitive key - unlike loadKaikkiSensesForKey, which
 * looks up one known key at query time. A free-text search (searchKaikki)
 * needs to scan across every key/spelling at once, and this project's
 * corpus (a few thousand senses) is small enough that a linear scan
 * suffices - see kaikkiSearch.ts's own header comment for the same
 * tradeoff already accepted there. */
export async function loadFullKaikkiLexicon(client: Queryable): Promise<KaikkiLexicon> {
  const { rows } = await client.query<KaikkiSenseRow & { orthography_insensitive_key: string }>(
    `select k.orthography_insensitive_key,
            s.pos, s.etymology_number, s.etymology_text, s.headword, s.canonical_value,
            s.canonical_inference_method, s.canonical_confidence,
            s.canonical_original_value, s.standard_forms, s.glosses, s.alt_of_targets,
            coalesce(
              (select json_agg(json_build_object('form', c.form, 'provenance', c.provenance) order by c.position)
               from kaikki_component_candidates c where c.sense_id = s.sense_id),
              '[]'::json
            ) as component_candidates,
            coalesce(
              (select json_agg(json_build_object('form', u.form, 'provenance', u.provenance) order by u.position)
               from kaikki_used_in_candidates u where u.sense_id = s.sense_id),
              '[]'::json
            ) as used_in_candidates
     from kaikki_senses s
     join kaikki_sense_keys k on k.sense_id = s.sense_id`,
  );
  const lexicon: KaikkiLexicon = {};
  for (const row of rows) {
    const sense = rowToKaikkiSense(row);
    const existing = lexicon[row.orthography_insensitive_key];
    if (existing) existing.push(sense);
    else lexicon[row.orthography_insensitive_key] = [sense];
  }
  return lexicon;
}
