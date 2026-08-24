// handlers/dictionarySurvey.ts
//
// The whole dictionary, one row per entry, at the CURATOR's level.
//
// ---------------------------------------------------------------------------
// Why this is not listAllWords with more columns
// ---------------------------------------------------------------------------
// listAllWords answers "what have I personally done?" - it calls loadAxisDecidedBatch,
// whose flags are per-user by construction, and whose own doc comment says a curator
// surface must not use them. On the browse screen that produced a real lie: a word three
// volunteers had fully recorded read as "not yet recorded" to a curator who had not
// recorded it themselves, and "Hide entry-decided" hid words on the strength of the
// reader's own unratified contribution.
//
// This asks the other question, and nothing here is scoped to the caller. A curator
// surveying the corpus is asking about the corpus.
//
// ---------------------------------------------------------------------------
// The spine is golden_record
// ---------------------------------------------------------------------------
// Not listConsensus, which starts from contributions and returns [] when there are none -
// so the population it can never report is exactly the one an overview most needs to
// count: words nobody has touched.
//
// ---------------------------------------------------------------------------
// Readiness is not re-derived here
// ---------------------------------------------------------------------------
// What blocks a word from the game, and what blocks it from Wiktionary, are decided by
// shared/src/publicationReadiness.ts - the same functions the publish and export scripts
// call. If this file grew its own copy, the app would eventually tell a curator the
// dictionary was ready while the export dropped half of it, which has happened here
// before and is the reason those rules were extracted.

import type { Queryable } from '../db.js';
import {
  citationState,
  gameBlockers,
  wiktionaryBlockers,
  type CitationState,
  type GameBlocker,
  type WiktionaryBlocker,
} from '@yoruba-student-dict-platform/shared';
import { loadGlobalAxisStatusBatch, type GlobalAxisState } from '../reviewShared.js';

export interface SurveyWord {
  wordId: string;
  displayText: string;
  syllables: string[];
  definition: string | null;
  entryType: 'phrase' | null;
  /** 0018's publication overrides. Written at creation and, until now, readable only by an
   * offline script - so a curator could neither see nor check them. */
  pos: string | null;
  englishGloss: string | null;
  etymidLabel: string | null;

  /** Global, not per-user: has anyone decided this, or merely offered an opinion. */
  entry: GlobalAxisState;
  etymology: GlobalAxisState;
  /** Speakers whose take-1 recording publish would accept. */
  speakerCount: number;
  /** Speakers who recorded it, then the word moved under them. */
  divergedSpeakerCount: number;
  /** Speakers who have recorded every one of its current syllables. */
  fullyCoveredSpeakerCount: number;
  imageCount: number;
  exampleCount: number;
  /** Examples recorded under a spelling the word no longer has. */
  staleExampleCount: number;
  componentCount: number;
  usedAsComponentOfCount: number;
  assigneeCount: number;

  citation: CitationState;
  exemptReason: string | null;
  citedEntryId: string | null;

  gameBlockers: GameBlocker[];
  wiktionaryBlockers: WiktionaryBlocker[];
}

/** Counts for the overview, every one of which the survey can be filtered to.
 *
 * A number a curator cannot click is a number they have to go and reproduce by hand. */
export interface DictionaryOverview {
  totalWords: number;
  entry: Record<GlobalAxisState, number>;
  etymology: Record<GlobalAxisState, number>;
  citation: Record<CitationState, number>;
  /** Words by how many speakers publish would accept, bucketed: 0, 1, 2, 3 or more. */
  audioCoverage: { none: number; one: number; two: number; threeOrMore: number };
  /** Words with at least one recording that no longer matches. */
  wordsWithStaleAudio: number;
  wordsWithNoImage: number;
  wordsWithExamples: number;
  gameReady: number;
  gameBlockers: Record<GameBlocker, number>;
  wiktionaryReady: number;
  wiktionaryBlockers: Record<WiktionaryBlocker, number>;
}

/** Speakers who have recorded EVERY syllable of the word as it currently stands.
 *
 * This is the game's real gate and it is per speaker, not per word: a level plays one
 * voice, so syllables covered by three different people cover nothing. The publish scripts
 * join on the NFC-normalised syllable text, and so does this - a composition difference is
 * not a missing recording.
 *
 * `syllable_observations` hangs off take 2, while the word clip is take 1, which is why
 * this cannot be folded into the take-1 query above it. */
const FULLY_COVERED_SPEAKERS_SQL = `
  select g.word_id, count(*)::int as n
    from golden_record g
    join lateral (
      select s.speaker_id
        from speakers s
       where not exists (
         select 1 from unnest(g.syllables) as needed(syllable)
          where not exists (
            select 1
              from syllable_observations so
              join utterances u2 on u2.utterance_id = so.utterance_id
             where u2.word_id = g.word_id
               and u2.speaker_id = s.speaker_id
               and so.audio_data is not null
               and normalize(so.syllable_text, nfc) = normalize(needed.syllable, nfc)
          )
       )
         and exists (select 1 from utterances u3 where u3.word_id = g.word_id and u3.speaker_id = s.speaker_id)
    ) covered on true
   where g.word_id = any($1)
   group by g.word_id`;

interface CountRow {
  word_id: string;
  n: number;
}

function countMap(rows: CountRow[]): Map<string, number> {
  return new Map(rows.map((r) => [r.word_id, Number(r.n)]));
}

export async function loadDictionarySurvey(client: Queryable): Promise<SurveyWord[]> {
  const words = await client.query<{
    word_id: string;
    display_text: string;
    syllables: string[];
    definition: string | null;
    entry_type: 'phrase' | null;
    pos: string | null;
    english_gloss: string | null;
    etymid_label: string | null;
    entry_id: string | null;
    exempt_reason: string | null;
    pin_pos: string | null;
    pin_glosses: string[] | null;
  }>(
    `select g.word_id, g.display_text, g.syllables, g.definition, g.entry_type,
            g.pos, g.english_gloss, g.etymid_label,
            c.entry_id, c.exempt_reason,
            c.pin ->> 'pos' as pin_pos,
            case when jsonb_typeof(c.pin -> 'glosses') = 'array'
                 then array(select jsonb_array_elements_text(c.pin -> 'glosses'))
                 else null end as pin_glosses
       from golden_record g
       left join upstream_citations c on c.word_id = g.word_id
      order by g.word_id`,
  );
  const wordIds = words.rows.map((r) => r.word_id);
  if (wordIds.length === 0) return [];

  const [axisStatus, coverage, images, examples, staleExamples, components, usedAsComponent, assignees] =
    await Promise.all([
      loadGlobalAxisStatusBatch(client, wordIds),
      client.query<CountRow>(FULLY_COVERED_SPEAKERS_SQL, [wordIds]),
      client.query<CountRow>(
        'select word_id, count(*)::int as n from word_images where word_id = any($1) group by word_id',
        [wordIds],
      ),
      client.query<CountRow>(
        'select word_id, count(*)::int as n from word_examples where word_id = any($1) and excluded_at is null group by word_id',
        [wordIds],
      ),
      // The example axis's own version of a diverged recording. listExamples has computed
      // this per example since 0015 and no screen has ever shown it.
      client.query<CountRow>(
        `select e.word_id, count(*)::int as n
           from word_examples e join golden_record g on g.word_id = e.word_id
          where e.word_id = any($1) and e.excluded_at is null and e.recorded_word_text <> g.display_text
          group by e.word_id`,
        [wordIds],
      ),
      client.query<CountRow>(
        'select word_id, count(*)::int as n from golden_record_components where word_id = any($1) group by word_id',
        [wordIds],
      ),
      client.query<CountRow>(
        `select component_word_id as word_id, count(distinct word_id)::int as n
           from golden_record_components where component_word_id = any($1) group by component_word_id`,
        [wordIds],
      ),
      client.query<CountRow>(
        'select word_id, count(*)::int as n from assignments where word_id = any($1) group by word_id',
        [wordIds],
      ),
    ]);

  const coveredByWord = countMap(coverage.rows);
  const imagesByWord = countMap(images.rows);
  const examplesByWord = countMap(examples.rows);
  const staleExamplesByWord = countMap(staleExamples.rows);
  const componentsByWord = countMap(components.rows);
  const usedByWord = countMap(usedAsComponent.rows);
  const assigneesByWord = countMap(assignees.rows);

  return words.rows.map((row) => {
    const status = axisStatus.get(row.word_id)!;
    const cited = Boolean(row.entry_id);
    // Same resolution order the export script uses: the override wins, then the pin. A
    // cited word needs no override - the pin already holds what upstream said when a human
    // validated it - so null here means "read the pin", not "missing".
    const pos = row.pos ?? row.pin_pos ?? null;
    const glosses = row.english_gloss ? [row.english_gloss] : (row.pin_glosses ?? []);
    const imageCount = imagesByWord.get(row.word_id) ?? 0;
    const fullyCoveredSpeakerCount = coveredByWord.get(row.word_id) ?? 0;

    return {
      wordId: row.word_id,
      displayText: row.display_text,
      syllables: row.syllables,
      definition: row.definition,
      entryType: row.entry_type,
      pos: row.pos,
      englishGloss: row.english_gloss,
      etymidLabel: row.etymid_label,
      entry: status.entry,
      etymology: status.etymology,
      speakerCount: status.speakerCount,
      divergedSpeakerCount: status.divergedSpeakerCount,
      fullyCoveredSpeakerCount,
      imageCount,
      exampleCount: examplesByWord.get(row.word_id) ?? 0,
      staleExampleCount: staleExamplesByWord.get(row.word_id) ?? 0,
      componentCount: componentsByWord.get(row.word_id) ?? 0,
      usedAsComponentOfCount: usedByWord.get(row.word_id) ?? 0,
      assigneeCount: assigneesByWord.get(row.word_id) ?? 0,
      citation: citationState(row.entry_id, row.exempt_reason),
      exemptReason: row.exempt_reason,
      citedEntryId: row.entry_id,
      gameBlockers: gameBlockers({
        matchingSpeakerCount: status.speakerCount,
        divergedSpeakerCount: status.divergedSpeakerCount,
        fullyCoveredSpeakerCount,
        imageCount,
      }),
      wiktionaryBlockers: wiktionaryBlockers({ cited, exemptReason: row.exempt_reason, pos, glosses }),
    };
  });
}

/** Derived from the same rows the survey returns, deliberately - an overview computed by a
 * second set of queries is an overview that can disagree with the list it summarises. */
export function summariseDictionary(words: SurveyWord[]): DictionaryOverview {
  const zeroAxis = (): Record<GlobalAxisState, number> => ({ golden: 0, provisional: 0, none: 0 });
  const overview: DictionaryOverview = {
    totalWords: words.length,
    entry: zeroAxis(),
    etymology: zeroAxis(),
    citation: { cited: 0, exempt: 0, uncited: 0 },
    audioCoverage: { none: 0, one: 0, two: 0, threeOrMore: 0 },
    wordsWithStaleAudio: 0,
    wordsWithNoImage: 0,
    wordsWithExamples: 0,
    gameReady: 0,
    gameBlockers: {
      no_matching_recording: 0,
      only_stale_recordings: 0,
      no_speaker_covers_syllables: 0,
      no_image: 0,
    },
    wiktionaryReady: 0,
    wiktionaryBlockers: { no_citation_row: 0, no_part_of_speech: 0, no_english_gloss: 0 },
  };

  for (const w of words) {
    overview.entry[w.entry] += 1;
    overview.etymology[w.etymology] += 1;
    overview.citation[w.citation] += 1;
    if (w.speakerCount === 0) overview.audioCoverage.none += 1;
    else if (w.speakerCount === 1) overview.audioCoverage.one += 1;
    else if (w.speakerCount === 2) overview.audioCoverage.two += 1;
    else overview.audioCoverage.threeOrMore += 1;
    if (w.divergedSpeakerCount > 0) overview.wordsWithStaleAudio += 1;
    if (w.imageCount === 0) overview.wordsWithNoImage += 1;
    if (w.exampleCount > 0) overview.wordsWithExamples += 1;
    if (w.gameBlockers.length === 0) overview.gameReady += 1;
    for (const b of w.gameBlockers) overview.gameBlockers[b] += 1;
    if (w.wiktionaryBlockers.length === 0) overview.wiktionaryReady += 1;
    for (const b of w.wiktionaryBlockers) overview.wiktionaryBlockers[b] += 1;
  }
  return overview;
}
