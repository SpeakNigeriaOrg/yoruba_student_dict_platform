// handlers/coverageReport.ts
//
// The numbers the publish scripts compute and print to a terminal nobody watches.
//
// exportGameContent.mjs says so in its own header: "No curator-visible coverage view exists
// yet in the curation app (would surface the same per-speaker-per-word audio coverage, and
// now per-word image coverage, computed here, as a UI instead of an offline script's console
// output)." This is that view.
//
// ---------------------------------------------------------------------------
// Why per SPEAKER is the unit
// ---------------------------------------------------------------------------
// A game level plays one voice. Syllables covered by three different people cover nothing,
// and a word is playable for a speaker only when that same speaker recorded the word AND
// every one of its current syllables. Corpus-wide totals hide that completely: three
// speakers at 60% each can leave zero words playable.
//
// ---------------------------------------------------------------------------
// What is NOT here, and why
// ---------------------------------------------------------------------------
// Per-theme coverage. Themes come from sessions_source.json in a different repository, which
// the API has no access to, so publishToR2.mjs remains the only place that can compute it.
// Said out loud rather than quietly omitted.
//
// Orphaned bucket objects, for the same class of reason: they require R2 credentials and a
// live listing, which belongs at publish time.

import type { Queryable } from '../db.js';
import { recordingMatchesGoldenSql, toneOf } from '@yoruba-student-dict-platform/shared';

const MATCHES = recordingMatchesGoldenSql('u', 'g');

/** Mirrors publishToR2.mjs's own threshold: below this a themed or reinforcement level is
 * not generated at all, so a speaker under it contributes nothing playable. */
export const MIN_LEVEL_WORDS = 3;
/** publishToR2.mjs's MIN_TONE_PATTERN_WORDS. */
export const MIN_TONE_PATTERN_WORDS = 4;

export interface SpeakerCoverage {
  speakerId: string;
  displayName: string;
  releaseState: string;
  /** Words with a take-1 recording by this speaker that still matches. */
  wordsRecorded: number;
  /** Of those, how many also have every syllable recorded by the same speaker. */
  wordsFullyCovered: number;
  /** Of those, how many also have an image - the set actually playable in the game. */
  wordsPlayable: number;
  /** Recordings this speaker made that the word has since moved out from under. */
  staleRecordings: number;
  /** Whether this speaker clears publishToR2's own floor for generating any level. */
  meetsLevelMinimum: boolean;
}

export interface TonePatternCoverage {
  pattern: string;
  wordsInCorpus: number;
  /** Speakers who could carry a level on this pattern, i.e. have MIN_TONE_PATTERN_WORDS of
   * it fully playable. */
  speakersWithEnough: number;
}

export interface SyllableCoverage {
  syllable: string;
  /** Distinct words whose current split contains it. */
  wordsUsingIt: number;
  recordings: number;
  speakers: number;
  /** Speakers who recorded this exact syllable more than once.
   *
   * db/README.md names the 15 of these in production and what happens to them: the publish
   * step picks by first-row-wins with no tiebreak, so which take ships is arbitrary. It has
   * never been visible anywhere. */
  speakersWithDuplicates: number;
}

export interface CoverageReport {
  speakers: SpeakerCoverage[];
  tonePatterns: TonePatternCoverage[];
  syllables: SyllableCoverage[];
  /** Syllables some word needs and nobody has recorded even once. */
  unrecordedSyllables: string[];
  minLevelWords: number;
  minTonePatternWords: number;
}

interface PlayableRow {
  speaker_id: string;
  word_id: string;
  fully_covered: boolean;
  has_image: boolean;
}

export async function loadCoverageReport(client: Queryable): Promise<CoverageReport> {
  const [speakerRows, playableRows, staleRows, wordRows, syllableRows] = await Promise.all([
    client.query<{ speaker_id: string; display_name: string; release_state: string }>(
      `select s.speaker_id, s.display_name, coalesce(r.release_state, 'unknown') as release_state
         from speakers s left join speaker_release_rights r on r.speaker_id = s.speaker_id
        order by s.display_name`,
    ),
    // One row per (speaker, word) the speaker has a live take-1 recording of, saying whether
    // that same speaker has an exact reusable exemplar for every syllable and whether the word has any image. The
    // three conditions publishToR2 applies, evaluated together rather than corpus-wide.
    client.query<PlayableRow>(
      `select u.speaker_id, u.word_id,
              not exists (
                select 1 from unnest(g.syllables) as needed(syllable)
                 where not exists (
                   select 1 from syllable_observations so
                     join utterances u2 on u2.utterance_id = so.utterance_id
                    where u2.speaker_id = u.speaker_id
                      and so.audio_data is not null
                      and substring(so.audio_data from 1 for 4) = decode('52494646', 'hex')
                      and substring(so.audio_data from 9 for 4) = decode('57415645', 'hex')
                      and normalize(so.syllable_text, nfc) = normalize(needed.syllable, nfc))
              ) as fully_covered,
              exists (select 1 from word_images i where i.word_id = g.word_id) as has_image
         from utterances u
         join golden_record g on g.word_id = u.word_id
        where u.take_number = 1 and u.audio_data is not null
          and substring(u.audio_data from 1 for 4) = decode('52494646', 'hex')
          and substring(u.audio_data from 9 for 4) = decode('57415645', 'hex')
          and ${MATCHES}`,
    ),
    client.query<{ speaker_id: string; n: number }>(
      `select u.speaker_id, count(*)::int as n
         from utterances u join golden_record g on g.word_id = u.word_id
        where not (${MATCHES}) group by u.speaker_id`,
    ),
    client.query<{ word_id: string; syllables: string[] }>('select word_id, syllables from golden_record'),
    // Keyed on the NFC-normalised syllable text, the same join the publish scripts use, so a
    // difference of Unicode composition is not counted as a different syllable.
    client.query<{ syllable: string; recordings: number; speakers: number; dup_speakers: number }>(
      `with clips as (
         select normalize(so.syllable_text, nfc) as syllable, u.speaker_id
           from syllable_observations so
           join utterances u on u.utterance_id = so.utterance_id
          where so.audio_data is not null
       )
       select syllable,
              count(*)::int as recordings,
              count(distinct speaker_id)::int as speakers,
              (select count(*)::int from (
                 select 1 from clips c2 where c2.syllable = clips.syllable
                  group by c2.speaker_id having count(*) > 1) dups) as dup_speakers
         from clips group by syllable order by syllable`,
    ),
  ]);

  const playableBySpeaker = new Map<string, { recorded: number; full: number; playable: number }>();
  const playableWordsBySpeaker = new Map<string, Set<string>>();
  for (const row of playableRows.rows) {
    const tally = playableBySpeaker.get(row.speaker_id) ?? { recorded: 0, full: 0, playable: 0 };
    tally.recorded += 1;
    if (row.fully_covered) tally.full += 1;
    if (row.fully_covered && row.has_image) {
      tally.playable += 1;
      const words = playableWordsBySpeaker.get(row.speaker_id) ?? new Set<string>();
      words.add(row.word_id);
      playableWordsBySpeaker.set(row.speaker_id, words);
    }
    playableBySpeaker.set(row.speaker_id, tally);
  }
  const staleBySpeaker = new Map(staleRows.rows.map((r) => [r.speaker_id, Number(r.n)]));

  const speakers = speakerRows.rows.map((s) => {
    const tally = playableBySpeaker.get(s.speaker_id) ?? { recorded: 0, full: 0, playable: 0 };
    return {
      speakerId: s.speaker_id,
      displayName: s.display_name,
      releaseState: s.release_state,
      wordsRecorded: tally.recorded,
      wordsFullyCovered: tally.full,
      wordsPlayable: tally.playable,
      staleRecordings: staleBySpeaker.get(s.speaker_id) ?? 0,
      meetsLevelMinimum: tally.playable >= MIN_LEVEL_WORDS,
    };
  });

  // Tone patterns, derived the way publishToR2 derives them: the tone of each syllable, joined.
  const patternByWord = new Map<string, string>();
  const wordsPerPattern = new Map<string, number>();
  for (const row of wordRows.rows) {
    const pattern = row.syllables.map(toneOf).join('-');
    patternByWord.set(row.word_id, pattern);
    wordsPerPattern.set(pattern, (wordsPerPattern.get(pattern) ?? 0) + 1);
  }
  const tonePatterns: TonePatternCoverage[] = [...wordsPerPattern.entries()]
    .map(([pattern, wordsInCorpus]) => {
      let speakersWithEnough = 0;
      for (const words of playableWordsBySpeaker.values()) {
        let n = 0;
        for (const wordId of words) if (patternByWord.get(wordId) === pattern) n += 1;
        if (n >= MIN_TONE_PATTERN_WORDS) speakersWithEnough += 1;
      }
      return { pattern, wordsInCorpus, speakersWithEnough };
    })
    .sort((a, b) => b.wordsInCorpus - a.wordsInCorpus);

  const wordsUsingSyllable = new Map<string, number>();
  for (const row of wordRows.rows) {
    for (const syllable of new Set(row.syllables.map((sy) => sy.normalize('NFC')))) {
      wordsUsingSyllable.set(syllable, (wordsUsingSyllable.get(syllable) ?? 0) + 1);
    }
  }
  const recorded = new Map(syllableRows.rows.map((r) => [r.syllable, r]));
  const syllables: SyllableCoverage[] = [...wordsUsingSyllable.entries()]
    .map(([syllable, wordsUsingIt]) => {
      const r = recorded.get(syllable);
      return {
        syllable,
        wordsUsingIt,
        recordings: r ? Number(r.recordings) : 0,
        speakers: r ? Number(r.speakers) : 0,
        speakersWithDuplicates: r ? Number(r.dup_speakers) : 0,
      };
    })
    .sort((a, b) => a.recordings - b.recordings || b.wordsUsingIt - a.wordsUsingIt);

  return {
    speakers,
    tonePatterns,
    syllables,
    unrecordedSyllables: syllables.filter((s) => s.recordings === 0).map((s) => s.syllable),
    minLevelWords: MIN_LEVEL_WORDS,
    minTonePatternWords: MIN_TONE_PATTERN_WORDS,
  };
}
