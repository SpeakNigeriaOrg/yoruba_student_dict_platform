import { describe, expect, it } from 'vitest';
import { isMultiWord, phraseTokens } from './phraseTokens';

describe('isMultiWord', () => {
  it('is true for a spelling written as separate words', () => {
    // Real corpus entries. 480 of 6272 etymologies look like this.
    expect(isMultiWord('ọmọ odù')).toBe(true);
    expect(isMultiWord('Adó Èkìtì')).toBe(true);
    expect(isMultiWord('ẹ jọ̀ọ́')).toBe(true);
  });

  it('is true for a reduplication, which is two words even though they are the same word', () => {
    // `méjì méjì` ("two by two"). Worth its own case because the phrase form used to de-duplicate
    // components and so could not represent this at all.
    expect(isMultiWord('méjì méjì')).toBe(true);
  });

  it('is false for one word, however many diacritics it carries', () => {
    expect(isMultiWord('adìyẹ')).toBe(false);
    expect(isMultiWord('ọ̀wàwà')).toBe(false);
  });

  it('is false for a hyphenated word - a hyphen is not a word boundary here', () => {
    // Deliberate: 143 corpus entries are hyphenated with no whitespace, almost all bound affixes
    // (`ì-`, `-kí-`, `oní-`) that are morphemes rather than words. `ilé-ìwé` is one orthographic word.
    expect(isMultiWord('ilé-ìwé')).toBe(false);
    expect(isMultiWord('gan-an')).toBe(false);
    expect(isMultiWord('oní-')).toBe(false);
  });

  it('ignores surrounding whitespace, so an accidental trailing space is not a phrase', () => {
    // The stated worry. Measured: zero corpus entries actually have leading/trailing whitespace, so
    // this is a formality - but it is the formality that makes the rule safe to apply to typed input.
    expect(isMultiWord('  adìyẹ  ')).toBe(false);
    expect(isMultiWord('adìyẹ\n')).toBe(false);
    expect(isMultiWord('   ')).toBe(false);
    expect(isMultiWord('')).toBe(false);
  });
});

describe('phraseTokens', () => {
  it('returns the words in order, which is the order the phrase is built in', () => {
    expect(phraseTokens('ọmọ odù')).toEqual(['ọmọ', 'odù']);
    expect(phraseTokens('a b c d')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps a repeated word twice rather than collapsing it', () => {
    expect(phraseTokens('méjì méjì')).toEqual(['méjì', 'méjì']);
  });

  it('absorbs doubled and non-space whitespace without emitting empty tokens', () => {
    expect(phraseTokens('ọmọ   odù')).toEqual(['ọmọ', 'odù']);
    expect(phraseTokens('ọmọ\todù')).toEqual(['ọmọ', 'odù']);
  });

  it('NFC-normalises each token, because tokens are matched to spellings by string equality', () => {
    // An NFD `ọ` (o + U+0323) and an NFC `ọ` (U+1ECD) are the same letter and different strings. That
    // mismatch silently broke syllable-audio lookup in the published game, so it is folded at the
    // boundary rather than left to chance.
    const nfd = 'ọmọ odù';
    expect(phraseTokens(nfd)).toEqual(['ọmọ', 'odù']);
    for (const token of phraseTokens(nfd)) expect(token.normalize('NFC')).toBe(token);
  });

  it('returns nothing for blank input', () => {
    expect(phraseTokens('')).toEqual([]);
    expect(phraseTokens('   ')).toEqual([]);
  });
});
