// gamePublishing.ts
//
// Pure, deterministic decisions shared by every game-media destination. Database reads, file
// writes and R2 calls stay in adapters; identity, fallback selection, coverage and level assembly
// live here so the local exporter and remote publisher cannot silently disagree.

import { toneOf } from './tone.js';

export const MIN_THEME_WORDS = 3;
export const REINFORCEMENT_LEVEL_SIZE = 10;
export const MIN_TONE_PATTERN_WORDS = 4;
export const ENDLESS_BUNDLE_SIZE = 8;
export const ENDLESS_BUNDLE_COUNT = 3;

export interface GameWord {
  wordId: string;
  displayText: string;
  syllables: string[];
}

export interface GameTheme {
  levelId: string;
  words: string[];
}

export type GameLevelCategory = 'themed' | 'syllable_reinforcement' | 'tone_pattern' | 'endless_practice';

export interface PlannedGameLevel {
  levelId: string;
  category: GameLevelCategory;
  validSpeakers: string[];
  words: string[];
}

export interface SyllableAudioCandidate<T> {
  observationId: string;
  speakerId: string;
  syllableText: string;
  audio: T | null;
  recordedAt: string;
  /** Reserved for the explicit selection table. A valid manual choice always wins. */
  explicitlySelected?: boolean;
}

export interface SelectedSyllableAudio<T> {
  observationId: string;
  speakerId: string;
  syllableText: string;
  audio: T;
  selectionMethod: 'explicit' | 'deterministic_fallback';
}

/** Prevents another container (notably browser WebM/Opus) from being served under a .wav name. */
export function hasWaveContainer(bytes: Uint8Array): boolean {
  return bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45;
}

/** Exact game identity: speaker + NFC tone-marked syllable. The source word is deliberately not
 * part of it because the current game reuses one isolated exemplar across words. */
export function syllableGameIdentity(speakerId: string, syllableText: string): string {
  return `${speakerId}\u0000${syllableText.normalize('NFC')}`;
}

/** Transitional deterministic choice until canonical artifact selections land.
 *
 * Null payloads are ineligible. A valid explicit choice wins; otherwise the newest observation
 * wins, with observation UUID as a stable final tiebreak. This is a publication fallback, not a
 * claim that the newest pronunciation is linguistically superior. */
export function selectSyllableAudio<T>(candidates: readonly SyllableAudioCandidate<T>[]): SelectedSyllableAudio<T>[] {
  const groups = new Map<string, SyllableAudioCandidate<T>[]>();
  for (const candidate of candidates) {
    if (candidate.audio === null) continue;
    const normalized = candidate.syllableText.normalize('NFC');
    const key = syllableGameIdentity(candidate.speakerId, normalized);
    const group = groups.get(key) ?? [];
    group.push({ ...candidate, syllableText: normalized });
    groups.set(key, group);
  }
  const selected: SelectedSyllableAudio<T>[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => {
      const explicit = Number(Boolean(b.explicitlySelected)) - Number(Boolean(a.explicitlySelected));
      if (explicit !== 0) return explicit;
      const date = b.recordedAt.localeCompare(a.recordedAt);
      return date !== 0 ? date : a.observationId.localeCompare(b.observationId);
    });
    const winner = group[0];
    selected.push({
      observationId: winner.observationId,
      speakerId: winner.speakerId,
      syllableText: winner.syllableText,
      audio: winner.audio as T,
      selectionMethod: winner.explicitlySelected ? 'explicit' : 'deterministic_fallback',
    });
  }
  return selected.sort(
    (a, b) => a.speakerId.localeCompare(b.speakerId) || a.syllableText.localeCompare(b.syllableText),
  );
}

function stripCombiningMarks(value: string): string {
  return [...value].filter((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x300 || code > 0x36f;
  }).join('');
}

/** Legacy-compatible destination filename, centralized until the game can consume direct artifact
 * identities. Logical selection never uses this lossy name. */
export function gameSyllableFileName(syllable: string, toneMap: Record<string, string>): string {
  const normalized = syllable.normalize('NFC').toLowerCase();
  const tone = toneOf(normalized);
  if (tone === null) throw new Error(`syllable ${JSON.stringify(syllable)} has no publishable Yoruba tone`);
  const suffix = tone === 'mid' ? '' : `_${tone}`;
  let safe = normalized;
  for (const key of Object.keys(toneMap).sort((a, b) => b.length - a.length)) {
    safe = safe.split(key).join(toneMap[key]);
  }
  return `${stripCombiningMarks(safe.normalize('NFD')).normalize('NFC')}${suffix}.wav`;
}

export function tonePattern(syllables: readonly string[]): string {
  return syllables.map((syllable) => {
    const tone = toneOf(syllable);
    if (tone === null) throw new Error(`syllable ${JSON.stringify(syllable)} has no publishable Yoruba tone`);
    return tone;
  }).join('-');
}

/** Cross-word coverage: once a speaker has an exact tone-marked syllable exemplar, the current game
 * may reuse it for every word requiring that same syllable. */
export function fullyCoveredWords(
  words: readonly GameWord[],
  wordIdsWithAudio: ReadonlySet<string>,
  syllablesWithAudio: ReadonlySet<string>,
  wordIdsWithImages: ReadonlySet<string>,
): GameWord[] {
  return words.filter((word) =>
    wordIdsWithAudio.has(word.wordId) &&
    wordIdsWithImages.has(word.wordId) &&
    word.syllables.every((syllable) => syllablesWithAudio.has(syllable.normalize('NFC'))),
  );
}

function greedyMinimalSyllableSet(words: readonly GameWord[], targetSize: number): GameWord[] {
  const remaining = new Map(words.map((word) => [word.wordId, word]));
  const chosen: GameWord[] = [];
  const pool = new Set<string>();
  while (chosen.length < targetSize && remaining.size > 0) {
    const ranked = [...remaining.values()].sort((a, b) => {
      const aNew = a.syllables.filter((syllable) => !pool.has(syllable)).length;
      const bNew = b.syllables.filter((syllable) => !pool.has(syllable)).length;
      return aNew - bNew || a.wordId.localeCompare(b.wordId);
    });
    const best = ranked[0];
    chosen.push(best);
    remaining.delete(best.wordId);
    best.syllables.forEach((syllable) => pool.add(syllable));
  }
  return chosen;
}

function hashSeed(value: string): number {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function deterministicShuffle<T>(values: readonly T[], seedText: string): T[] {
  let state = hashSeed(seedText);
  const random = () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const output = [...values];
  for (let index = output.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [output[index], output[other]] = [output[other], output[index]];
  }
  return output;
}

export function planLevels(
  coveredWordsBySpeaker: ReadonlyMap<string, readonly GameWord[]>,
  themes: readonly GameTheme[],
): PlannedGameLevel[] {
  const levels: PlannedGameLevel[] = [];
  for (const speaker of [...coveredWordsBySpeaker.keys()].sort()) {
    const covered = [...(coveredWordsBySpeaker.get(speaker) ?? [])].sort((a, b) => a.wordId.localeCompare(b.wordId));
    const byId = new Map(covered.map((word) => [word.wordId, word]));
    for (const theme of themes) {
      const words = theme.words.filter((wordId) => byId.has(wordId))
        .sort((a, b) => (byId.get(a)?.syllables.length ?? 0) - (byId.get(b)?.syllables.length ?? 0) || a.localeCompare(b));
      if (words.length >= MIN_THEME_WORDS) {
        levels.push({ levelId: `${theme.levelId} — ${speaker}`, category: 'themed', validSpeakers: [speaker], words });
      }
    }
    let remaining = covered;
    let bundle = 1;
    while (remaining.length >= MIN_THEME_WORDS) {
      const chosen = greedyMinimalSyllableSet(remaining, Math.min(REINFORCEMENT_LEVEL_SIZE, remaining.length));
      const ids = new Set(chosen.map((word) => word.wordId));
      remaining = remaining.filter((word) => !ids.has(word.wordId));
      levels.push({
        levelId: `Syllable Practice ${bundle} — ${speaker}`,
        category: 'syllable_reinforcement', validSpeakers: [speaker],
        words: chosen.sort((a, b) => a.syllables.length - b.syllables.length || a.wordId.localeCompare(b.wordId)).map((word) => word.wordId),
      });
      bundle++;
    }
    const byPattern = new Map<string, GameWord[]>();
    for (const word of covered) {
      const pattern = tonePattern(word.syllables);
      const group = byPattern.get(pattern) ?? [];
      group.push(word);
      byPattern.set(pattern, group);
    }
    for (const pattern of [...byPattern.keys()].sort()) {
      const words = byPattern.get(pattern) ?? [];
      if (words.length >= MIN_TONE_PATTERN_WORDS) {
        levels.push({
          levelId: `Tone Pattern (${pattern}) — ${speaker}`,
          category: 'tone_pattern', validSpeakers: [speaker],
          words: words.sort((a, b) => a.syllables.length - b.syllables.length || a.wordId.localeCompare(b.wordId)).map((word) => word.wordId),
        });
      }
    }
    if (covered.length >= MIN_THEME_WORDS) {
      for (let index = 0; index < ENDLESS_BUNDLE_COUNT; index++) {
        levels.push({
          levelId: `Endless Practice ${index + 1} — ${speaker}`,
          category: 'endless_practice', validSpeakers: [speaker],
          words: deterministicShuffle(covered, `${speaker}:${index}`).slice(0, Math.min(ENDLESS_BUNDLE_SIZE, covered.length)).map((word) => word.wordId),
        });
      }
    }
  }
  return levels;
}
