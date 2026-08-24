import { describe, expect, it } from 'vitest';
import {
  citationState,
  describeGameBlocker,
  describeWiktionaryBlocker,
  gameBlockers,
  recordingMatchesGolden,
  recordingMatchesGoldenSql,
  wiktionaryBlockers,
} from './publicationReadiness.js';

const ready = { matchingSpeakerCount: 2, divergedSpeakerCount: 0, fullyCoveredSpeakerCount: 2, imageCount: 1 };

describe('gameBlockers', () => {
  it('reports nothing for a word the export would take', () => {
    expect(gameBlockers(ready)).toEqual([]);
  });

  it('tells "never recorded" apart from "recorded, then respelled"', () => {
    // Different work, different person: one is a recording to schedule, the other is
    // somebody's finished take that a later spelling change invalidated.
    expect(gameBlockers({ ...ready, matchingSpeakerCount: 0, fullyCoveredSpeakerCount: 0 })).toContain(
      'no_matching_recording',
    );
    expect(
      gameBlockers({ ...ready, matchingSpeakerCount: 0, fullyCoveredSpeakerCount: 0, divergedSpeakerCount: 3 }),
    ).toContain('only_stale_recordings');
  });

  it('reports partial syllable coverage only once there is a recording to cover', () => {
    // Otherwise a word nobody has touched reports two blockers describing one absence.
    expect(gameBlockers({ ...ready, fullyCoveredSpeakerCount: 0 })).toEqual(['no_speaker_covers_syllables']);
    expect(gameBlockers({ matchingSpeakerCount: 0, divergedSpeakerCount: 0, fullyCoveredSpeakerCount: 0, imageCount: 0 })).toEqual([
      'no_matching_recording',
      'no_image',
    ]);
  });

  it('treats a missing image as a blocker, not a degrade', () => {
    expect(gameBlockers({ ...ready, imageCount: 0 })).toEqual(['no_image']);
  });

  it('describes every blocker it can produce', () => {
    for (const b of ['no_matching_recording', 'only_stale_recordings', 'no_speaker_covers_syllables', 'no_image'] as const) {
      expect(describeGameBlocker(b).length).toBeGreaterThan(0);
    }
  });
});

describe('wiktionaryBlockers', () => {
  const cited = { cited: true, exemptReason: null, pos: 'noun', glosses: ['hand'] };

  it('reports nothing for a cited entry with a part of speech and a gloss', () => {
    expect(wiktionaryBlockers(cited)).toEqual([]);
  });

  it('accepts an exempt word as citation-answered - the exemption IS the answer', () => {
    expect(wiktionaryBlockers({ ...cited, cited: false, exemptReason: 'no upstream entry' })).toEqual([]);
  });

  it('blocks a word with no citation row at all', () => {
    expect(wiktionaryBlockers({ ...cited, cited: false })).toEqual(['no_citation_row']);
  });

  it('blocks on the two publication fields independently', () => {
    expect(wiktionaryBlockers({ ...cited, pos: null })).toEqual(['no_part_of_speech']);
    expect(wiktionaryBlockers({ ...cited, glosses: [] })).toEqual(['no_english_gloss']);
  });

  it('keeps the wording the export script has always printed', () => {
    // The scripts print these sentences; the survey counts the codes. Both come from here,
    // so the two can never describe the same gap differently.
    expect(describeWiktionaryBlocker('no_part_of_speech')).toBe('no part of speech (set golden_record.pos)');
    expect(describeWiktionaryBlocker('no_english_gloss')).toBe('no English gloss (set golden_record.english_gloss)');
  });
});

describe('citationState', () => {
  it('separates an answered absence from an unasked question', () => {
    expect(citationState('en-owo-yo-noun', null)).toBe('cited');
    expect(citationState(null, 'loanword, no upstream entry')).toBe('exempt');
    expect(citationState(null, null)).toBe('uncited');
  });
});

describe('the publish comparison', () => {
  it('renders with the aliases the caller actually uses', () => {
    // The scripts call golden_record `w`, the API calls it `g`. One rule, two aliases.
    expect(recordingMatchesGoldenSql()).toBe(
      'u.recorded_display_text = g.display_text and u.recorded_syllables = g.syllables',
    );
    expect(recordingMatchesGoldenSql('u', 'w')).toBe(
      'u.recorded_display_text = w.display_text and u.recorded_syllables = w.syllables',
    );
  });

  it('agrees with itself in TypeScript', () => {
    const golden = { display_text: 'ọwọ́', syllables: ['ọ', 'wọ́'] };
    expect(recordingMatchesGolden('ọwọ́', ['ọ', 'wọ́'], golden)).toBe(true);
    expect(recordingMatchesGolden('ọwọ', ['ọ', 'wọ'], golden)).toBe(false);
    expect(recordingMatchesGolden('ọwọ́', ['ọwọ́'], golden)).toBe(false);
  });
});
