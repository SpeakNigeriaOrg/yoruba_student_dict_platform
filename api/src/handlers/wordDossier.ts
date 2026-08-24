// handlers/wordDossier.ts
//
// Everything the system holds about one word, on one page.
//
// ---------------------------------------------------------------------------
// This is the raw tables, arranged by the thing they are all about
// ---------------------------------------------------------------------------
// A curator's deeper question is usually not "show me the contributions table", it is
// "what is going on with THIS word" - and answering it currently means four screens, none
// of which show the history. So this is a join, not a table browser: one word, every row
// that mentions it, in an order a person can read.
//
// Three populations here have never been readable from anywhere in the app, and each was
// deliberately preserved by a migration that then had no consumer:
//
//   SUPERSEDED and EXCLUDED contributions. 0013 made a contribution evidence rather than a
//   proposal and kept every version - "the row is retained in full" - specifically so a
//   change of mind stays legible. Every query in the app filters status = 'active'.
//
//   The PIN. 0014 stores what upstream said at the moment a human validated the citation.
//   It surfaces today only as a drift diff, so the copy itself - the thing the entry axis
//   reasons from - cannot be inspected.
//
//   word_decisions_premerge. 0011 archived every pre-merge spelling/definition decision as
//   "both the audit trail for what the collapse did and the rollback path". Nothing has
//   ever read it.

import type { Queryable } from '../db.js';
import { citationState, type CitationState } from '@yoruba-student-dict-platform/shared';
import { WordNotFoundError } from './errors.js';

export interface DossierDecision {
  axis: string;
  decision: unknown;
  note: string | null;
  decidedByEmail: string | null;
  decidedAt: string;
  valueFingerprint: string | null;
  /** True for rows out of 0011's archive rather than the live table. */
  archived: boolean;
}

export interface DossierContribution {
  contributionId: string;
  axis: string;
  status: string;
  proposedValue: unknown;
  resolvedValue: unknown;
  valueFingerprint: string | null;
  note: string | null;
  submittedByEmail: string;
  submittedAt: string;
  excludedReason: string | null;
  excludedAt: string | null;
}

export interface DossierRecording {
  utteranceId: string;
  speakerId: string;
  speakerName: string;
  releaseState: string;
  takeNumber: number;
  recordedDisplayText: string;
  recordedSyllables: string[];
  matchesGolden: boolean;
  durationS: number | null;
  status: string;
  recordedAt: string;
  segmentCount: number;
  /** Lowest VAD confidence across this take's clips - the signal the segmenter produces
   * and nothing has ever read. Null when the take carries no segments. */
  lowestSegmentConfidence: number | null;
}

export interface DossierExample {
  exampleId: string;
  exampleType: string;
  exampleText: string;
  translation: string;
  authorEmail: string;
  releaseState: string;
  submittedAt: string;
  recordedWordText: string;
  /** Recorded under a spelling the word no longer has. */
  wordTextChanged: boolean;
  excludedReason: string | null;
}

export interface DossierImage {
  imageId: string;
  artStyle: string;
  variantNumber: number;
  contentType: string;
  byteLength: number;
  uploadedAt: string;
}

export interface WordDossier {
  wordId: string;
  displayText: string;
  syllables: string[];
  definition: string | null;
  entryType: 'phrase' | null;
  pos: string | null;
  englishGloss: string | null;
  etymidLabel: string | null;
  updatedAt: string;
  updatedByEmail: string | null;

  citation: CitationState;
  citedEntryId: string | null;
  exemptReason: string | null;
  /** The copy taken when a human validated the citation - pos, glosses, etymology text,
   * canonical form, as upstream then had them. */
  pin: unknown;
  pinnedAt: string | null;
  pinnedByEmail: string | null;

  components: Array<{ wordId: string; displayText: string; position: number }>;
  usedAsComponentOf: Array<{ wordId: string; displayText: string }>;
  decisions: DossierDecision[];
  contributions: DossierContribution[];
  recordings: DossierRecording[];
  examples: DossierExample[];
  images: DossierImage[];
  assignees: Array<{ email: string; displayName: string | null; assignedAt: string }>;
}

export async function loadWordDossier(client: Queryable, wordId: string): Promise<WordDossier> {
  const word = await client.query<{
    display_text: string;
    syllables: string[];
    definition: string | null;
    entry_type: 'phrase' | null;
    pos: string | null;
    english_gloss: string | null;
    etymid_label: string | null;
    updated_at: string;
    updated_by_email: string | null;
  }>(
    `select g.display_text, g.syllables, g.definition, g.entry_type, g.pos, g.english_gloss,
            g.etymid_label, g.updated_at, u.email as updated_by_email
       from golden_record g
       left join users u on u.user_id = g.updated_by
      where g.word_id = $1`,
    [wordId],
  );
  if ((word.rowCount ?? 0) === 0) throw new WordNotFoundError(wordId);
  const w = word.rows[0];

  const [citation, components, usedIn, decisions, premerge, contributions, recordings, examples, images, assignees] =
    await Promise.all([
      client.query<{
        entry_id: string | null;
        exempt_reason: string | null;
        pin: unknown;
        pinned_at: string;
        pinned_by_email: string | null;
      }>(
        `select c.entry_id, c.exempt_reason, c.pin, c.pinned_at, u.email as pinned_by_email
           from upstream_citations c left join users u on u.user_id = c.pinned_by
          where c.word_id = $1`,
        [wordId],
      ),
      client.query<{ component_word_id: string; display_text: string; component_position: number }>(
        `select c.component_word_id, g.display_text, c.component_position
           from golden_record_components c join golden_record g on g.word_id = c.component_word_id
          where c.word_id = $1 order by c.component_position`,
        [wordId],
      ),
      client.query<{ word_id: string; display_text: string }>(
        `select c.word_id, g.display_text
           from golden_record_components c join golden_record g on g.word_id = c.word_id
          where c.component_word_id = $1 order by c.word_id`,
        [wordId],
      ),
      client.query<{
        axis: string;
        decision: unknown;
        note: string | null;
        email: string | null;
        decided_at: string;
        value_fingerprint: string | null;
      }>(
        `select d.axis, d.decision, d.note, u.email, d.decided_at, d.value_fingerprint
           from word_decisions d left join users u on u.user_id = d.decided_by
          where d.word_id = $1 order by d.decided_at`,
        [wordId],
      ),
      client.query<{ axis: string; decision: unknown; note: string | null; email: string | null; decided_at: string }>(
        `select p.axis, p.decision, p.note, u.email, p.decided_at
           from word_decisions_premerge p left join users u on u.user_id = p.decided_by
          where p.word_id = $1 order by p.decided_at`,
        [wordId],
      ),
      // Every status, not just 'active'. See the file header: the belief history 0013 went
      // to lengths to keep has never been readable.
      client.query<{
        contribution_id: string;
        axis: string;
        status: string;
        proposed_value: unknown;
        resolved_value: unknown;
        value_fingerprint: string | null;
        note: string | null;
        email: string;
        submitted_at: string;
        excluded_reason: string | null;
        excluded_at: string | null;
      }>(
        `select c.contribution_id, c.axis, c.status, c.proposed_value, c.resolved_value, c.value_fingerprint,
                c.note, u.email, c.submitted_at, c.excluded_reason, c.excluded_at
           from contributions c join users u on u.user_id = c.submitted_by
          where c.word_id = $1 order by c.submitted_at`,
        [wordId],
      ),
      client.query<{
        utterance_id: string;
        speaker_id: string;
        speaker_name: string;
        release_state: string;
        take_number: number;
        recorded_display_text: string;
        recorded_syllables: string[];
        matches_golden: boolean;
        duration_s: string | null;
        status: string;
        recorded_at: string;
        segment_count: number;
        lowest_confidence: string | null;
      }>(
        `select u.utterance_id, u.speaker_id, s.display_name as speaker_name,
                coalesce(r.release_state, 'unknown') as release_state,
                u.take_number, u.recorded_display_text, u.recorded_syllables,
                (u.recorded_display_text = g.display_text and u.recorded_syllables = g.syllables) as matches_golden,
                u.duration_s, u.status, u.recorded_at,
                (select count(*)::int from syllable_observations so where so.utterance_id = u.utterance_id) as segment_count,
                (select min(so.vad_confidence) from syllable_observations so where so.utterance_id = u.utterance_id) as lowest_confidence
           from utterances u
           join speakers s on s.speaker_id = u.speaker_id
           join golden_record g on g.word_id = u.word_id
           left join speaker_release_rights r on r.speaker_id = u.speaker_id
          where u.word_id = $1
          order by s.display_name, u.take_number`,
        [wordId],
      ),
      client.query<{
        example_id: string;
        example_type: string;
        example_text: string;
        translation: string;
        email: string;
        release_state: string;
        submitted_at: string;
        recorded_word_text: string;
        word_text_changed: boolean;
        excluded_reason: string | null;
      }>(
        `select e.example_id, e.example_type, e.example_text, e.translation, u.email,
                coalesce(r.release_state, 'unknown') as release_state,
                e.submitted_at, e.recorded_word_text,
                (e.recorded_word_text <> g.display_text) as word_text_changed, e.excluded_reason
           from word_examples e
           join users u on u.user_id = e.submitted_by
           join golden_record g on g.word_id = e.word_id
           left join contributor_release_rights r on r.user_id = e.submitted_by
          where e.word_id = $1 order by e.submitted_at`,
        [wordId],
      ),
      // Metadata only. The bytes are large and nothing needs them to answer "does this word
      // have art"; a dedicated route serves one image when a screen actually shows it.
      client.query<{
        image_id: string;
        art_style: string;
        variant_number: number;
        content_type: string;
        byte_length: number;
        uploaded_at: string;
      }>(
        `select image_id, art_style, variant_number, content_type,
                length(image_data) as byte_length, uploaded_at
           from word_images where word_id = $1 order by art_style, variant_number`,
        [wordId],
      ),
      client.query<{ email: string; display_name: string | null; assigned_at: string }>(
        `select u.email, u.display_name, a.assigned_at
           from assignments a join users u on u.user_id = a.user_id
          where a.word_id = $1 order by a.assigned_at`,
        [wordId],
      ),
    ]);

  const cite = citation.rows[0];
  return {
    wordId,
    displayText: w.display_text,
    syllables: w.syllables,
    definition: w.definition,
    entryType: w.entry_type,
    pos: w.pos,
    englishGloss: w.english_gloss,
    etymidLabel: w.etymid_label,
    updatedAt: w.updated_at,
    updatedByEmail: w.updated_by_email,
    citation: citationState(cite?.entry_id ?? null, cite?.exempt_reason ?? null),
    citedEntryId: cite?.entry_id ?? null,
    exemptReason: cite?.exempt_reason ?? null,
    pin: cite?.pin ?? null,
    pinnedAt: cite?.pinned_at ?? null,
    pinnedByEmail: cite?.pinned_by_email ?? null,
    components: components.rows.map((r) => ({
      wordId: r.component_word_id,
      displayText: r.display_text,
      position: r.component_position,
    })),
    usedAsComponentOf: usedIn.rows.map((r) => ({ wordId: r.word_id, displayText: r.display_text })),
    decisions: [
      ...decisions.rows.map((r) => ({
        axis: r.axis,
        decision: r.decision,
        note: r.note,
        decidedByEmail: r.email,
        decidedAt: r.decided_at,
        valueFingerprint: r.value_fingerprint,
        archived: false,
      })),
      ...premerge.rows.map((r) => ({
        axis: r.axis,
        decision: r.decision,
        note: r.note,
        decidedByEmail: r.email,
        decidedAt: r.decided_at,
        valueFingerprint: null,
        archived: true,
      })),
    ],
    contributions: contributions.rows.map((r) => ({
      contributionId: r.contribution_id,
      axis: r.axis,
      status: r.status,
      proposedValue: r.proposed_value,
      resolvedValue: r.resolved_value,
      valueFingerprint: r.value_fingerprint,
      note: r.note,
      submittedByEmail: r.email,
      submittedAt: r.submitted_at,
      excludedReason: r.excluded_reason,
      excludedAt: r.excluded_at,
    })),
    recordings: recordings.rows.map((r) => ({
      utteranceId: r.utterance_id,
      speakerId: r.speaker_id,
      speakerName: r.speaker_name,
      releaseState: r.release_state,
      takeNumber: r.take_number,
      recordedDisplayText: r.recorded_display_text,
      recordedSyllables: r.recorded_syllables,
      matchesGolden: r.matches_golden,
      durationS: r.duration_s === null ? null : Number(r.duration_s),
      status: r.status,
      recordedAt: r.recorded_at,
      segmentCount: r.segment_count,
      lowestSegmentConfidence: r.lowest_confidence === null ? null : Number(r.lowest_confidence),
    })),
    examples: examples.rows.map((r) => ({
      exampleId: r.example_id,
      exampleType: r.example_type,
      exampleText: r.example_text,
      translation: r.translation,
      authorEmail: r.email,
      releaseState: r.release_state,
      submittedAt: r.submitted_at,
      recordedWordText: r.recorded_word_text,
      wordTextChanged: r.word_text_changed,
      excludedReason: r.excluded_reason,
    })),
    images: images.rows.map((r) => ({
      imageId: r.image_id,
      artStyle: r.art_style,
      variantNumber: r.variant_number,
      contentType: r.content_type,
      byteLength: Number(r.byte_length),
      uploadedAt: r.uploaded_at,
    })),
    assignees: assignees.rows.map((r) => ({
      email: r.email,
      displayName: r.display_name,
      assignedAt: r.assigned_at,
    })),
  };
}
