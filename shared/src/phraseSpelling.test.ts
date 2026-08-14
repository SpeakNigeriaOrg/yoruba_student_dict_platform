import { describe, expect, it } from 'vitest';
import { checkPhraseSpelling, describePhraseSpelling } from './phraseSpelling';

describe('checkPhraseSpelling', () => {
  it('matches when the phrase is exactly its components joined', () => {
    // The ordinary case, and the one the old derive-it rule handled correctly.
    const check = checkPhraseSpelling('abo adìyẹ', ['abo', 'adìyẹ']);
    expect(check.matches).toBe(true);
    expect(check.joined).toBe('abo adìyẹ');
    expect(describePhraseSpelling(check)).toBeNull();
  });

  it('matches a reduplication, where one word occupies two positions', () => {
    expect(checkPhraseSpelling('méjì méjì', ['méjì', 'méjì']).matches).toBe(true);
  });

  it('reports a tone difference, which is the case that could not be stored at all', () => {
    // The real one. Upstream's `o ṣe` entry carries canonical `o ṣé` (explicit_canonical_tag,
    // confidence 1.0) and IPA /ō ʃé/, while its parts are `o` (pron, etym 2) and `ṣe` (verb,
    // etym 2). Joining the parts spells it at the wrong tone.
    const check = checkPhraseSpelling('o ṣé', ['o', 'ṣe']);
    expect(check.matches).toBe(false);
    expect(check.joined).toBe('o ṣe');
    expect(describePhraseSpelling(check)).toBe('ṣe is written ṣé here');
  });

  it('reports a contraction, where two words are written as one', () => {
    // {{contraction|yo|mu|ọtí}} - a real corpus etymology.
    const check = checkPhraseSpelling('muti', ['mu', 'ọtí']);
    expect(check.matches).toBe(false);
    expect(describePhraseSpelling(check)).toBe('mu is written muti here; ọtí is not written out');
  });

  it('reports an extra word the components do not account for', () => {
    const check = checkPhraseSpelling('o ṣé púpọ̀', ['o', 'ṣé']);
    expect(check.matches).toBe(false);
    expect(describePhraseSpelling(check)).toBe('púpọ̀ is not one of the components');
  });

  it('treats an NFD spelling as the same spelling, and a capital as the same word', () => {
    // Both are encoding/orthographic noise this codebase normalises at every boundary -
    // an NFD `ọ` silently broke syllable-audio lookup in the published game once already.
    expect(checkPhraseSpelling('ẹ jọ̀ọ́'.normalize('NFD'), ['ẹ', 'jọ̀ọ́']).matches).toBe(true);
    expect(checkPhraseSpelling('Adó Èkìtì', ['adó', 'Èkìtì']).matches).toBe(true);
  });

  it('splits a multi-word component into its own words, so positions line up', () => {
    // Nesting is allowed (a proverb containing an idiom), so a component can itself be a
    // phrase. Comparing it as one token would report every following word as different.
    const check = checkPhraseSpelling('ọmọ odù kékeré', ['ọmọ odù', 'kékeré']);
    expect(check.matches).toBe(true);
    expect(check.words).toHaveLength(3);
  });

  it('treats a hyphen like a space, so an ordinary compound is not reported', () => {
    // `ilé-ìwé` ("school") is `ilé` + `ìwé` written as one orthographic word. Reporting that as
    // a spelling its parts cannot produce would fire the warning on every compound in the
    // dictionary, and a warning that fires constantly is one people stop reading.
    expect(checkPhraseSpelling('ilé-ìwé', ['ilé', 'ìwé']).matches).toBe(true);
    // A component that is itself hyphenated lines up the same way.
    expect(checkPhraseSpelling('ilé-ìwé gíga', ['ilé-ìwé', 'gíga']).matches).toBe(true);
  });

  it('still reports a contraction, which a hyphen is not', () => {
    // The check has to keep working through the hyphen exemption. `muti` is genuinely written
    // differently from its parts - a vowel is elided, not a separator dropped.
    const check = checkPhraseSpelling('muti', ['mu', 'ọtí']);
    expect(check.matches).toBe(false);
    expect(describePhraseSpelling(check)).toBe('mu is written muti here; ọtí is not written out');
  });

  it('does not match a phrase with no components at all', () => {
    // A phrase always has at least one component (createPhrase refuses otherwise), so an
    // empty list is a caller bug rather than a matching phrase.
    expect(checkPhraseSpelling('o ṣé', []).matches).toBe(false);
  });
});
