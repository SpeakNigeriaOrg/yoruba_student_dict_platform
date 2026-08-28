import { describe, expect, it } from 'vitest';
import {
  fullyCoveredWords,
  gameSyllableFileName,
  hasWaveContainer,
  planLevels,
  selectSyllableAudio,
  syllableGameIdentity,
  type GameWord,
} from './gamePublishing.js';

const toneMap = { 'á': 'a', 'à': 'a', 'ẹ': 'eh', 'ṣ': 'sh' };

describe('game audio identity and selection', () => {
  it('recognizes WAV containers instead of trusting an extension', () => {
    expect(hasWaveContainer(new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 65, 86, 69]))).toBe(true);
    expect(hasWaveContainer(new TextEncoder().encode('webm payload'))).toBe(false);
  });

  it('uses exact NFC tone-marked syllables as identity', () => {
    expect(syllableGameIdentity('s1', 'e\u0323\u0301')).toBe(syllableGameIdentity('s1', 'ẹ́'));
    expect(syllableGameIdentity('s1', 'ẹ̀')).not.toBe(syllableGameIdentity('s1', 'ẹ́'));
  });

  it('ignores nulls and chooses explicit selection before deterministic fallback', () => {
    const candidates = [
      { observationId: 'b', speakerId: 's1', syllableText: 'bù', audio: null, recordedAt: '2026-03-01' },
      { observationId: 'c', speakerId: 's1', syllableText: 'bù', audio: 'new', recordedAt: '2026-02-01' },
      { observationId: 'a', speakerId: 's1', syllableText: 'bù', audio: 'chosen', recordedAt: '2026-01-01', explicitlySelected: true },
    ];
    expect(selectSyllableAudio(candidates)).toEqual([{
      observationId: 'a', speakerId: 's1', syllableText: 'bù', audio: 'chosen', selectionMethod: 'explicit',
    }]);
  });

  it('uses newest recording then stable id when no explicit selection exists', () => {
    const candidates = [
      { observationId: 'z', speakerId: 's1', syllableText: 'a', audio: 'old', recordedAt: '2026-01-01' },
      { observationId: 'b', speakerId: 's1', syllableText: 'a', audio: 'tie-b', recordedAt: '2026-02-01' },
      { observationId: 'a', speakerId: 's1', syllableText: 'a', audio: 'tie-a', recordedAt: '2026-02-01' },
    ];
    expect(selectSyllableAudio(candidates)[0].audio).toBe('tie-a');
  });

  it('centralizes the legacy-compatible game filename', () => {
    expect(gameSyllableFileName('ṣá', toneMap)).toBe('sha_high.wav');
    expect(gameSyllableFileName('ẹ', toneMap)).toBe('eh.wav');
  });
});

describe('game coverage and level planning', () => {
  const words: GameWord[] = [
    { wordId: 'w1', displayText: 'w1', syllables: ['a', 'bù'] },
    { wordId: 'w2', displayText: 'w2', syllables: ['a'] },
    { wordId: 'w3', displayText: 'w3', syllables: ['bù'] },
    { wordId: 'w4', displayText: 'w4', syllables: ['a', 'bù'] },
  ];

  it('reuses exact syllable coverage across source words', () => {
    expect(fullyCoveredWords(words, new Set(['w1', 'w2']), new Set(['a', 'bù']), new Set(['w1', 'w2'])).map((w) => w.wordId))
      .toEqual(['w1', 'w2']);
  });

  it('produces byte-stable level plans', () => {
    const covered = new Map([['speaker1', words]]);
    const themes = [{ levelId: 'Theme', words: ['w4', 'w3', 'w2', 'w1'] }];
    expect(planLevels(covered, themes)).toEqual(planLevels(covered, themes));
    expect(planLevels(covered, themes).find((level) => level.category === 'themed')?.words).toEqual(['w2', 'w3', 'w1', 'w4']);
  });
});
