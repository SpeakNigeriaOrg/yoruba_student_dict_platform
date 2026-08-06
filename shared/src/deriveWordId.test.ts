import { describe, expect, it } from 'vitest';
import { deriveWordId, discriminateWordId, hashDiscriminateWordId, meaningSlug } from './deriveWordId';

describe('deriveWordId reproduces production\'s own convention', () => {
  // These are real production word_ids. The point is that this is not a new scheme: the
  // vocabulary already strips the underdot and lets the MEANING disambiguate.
  const real: Array<[string, string, string]> = [
    ['èwà', 'beans', 'ewa_beans'],
    ['ẹwà', 'beauty', 'ewa_beauty'],
    ['ọba', 'king', 'oba_king'],
    ['ọṣẹ', 'soap', 'ose_soap'],
    ['adìyẹ', 'chicken', 'adiye_chicken'],
    ['aláǹgbá', 'lizard', 'alangba_lizard'],
  ];

  for (const [displayText, gloss, expected] of real) {
    it(`${displayText} + "${gloss}" -> ${expected}`, () => {
      expect(deriveWordId(displayText, gloss)).toBe(expected);
    });
  }

  it('distinguishes two words whose stripped spellings are identical', () => {
    // èwà and ẹwà are different words. The underdot is gone by design; the meaning is what
    // keeps them apart, exactly as production already does.
    expect(deriveWordId('èwà', 'beans')).not.toBe(deriveWordId('ẹwà', 'beauty'));
  });
});

describe('determinism - what the consensus tally depends on', () => {
  it('is a pure function of the etymology, so two volunteers derive the same id', () => {
    const a = deriveWordId('abo adìyẹ', 'hen');
    const b = deriveWordId('abo adìyẹ', 'hen');
    expect(a).toBe(b);
  });

  it('ignores tone and underdot differences in the SPELLING, as the convention does', () => {
    expect(deriveWordId('adìyẹ', 'chicken')).toBe(deriveWordId('adiye', 'chicken'));
  });

  it('ignores case and punctuation in the gloss', () => {
    expect(deriveWordId('kọ́', 'To Build, construct')).toBe(deriveWordId('kọ́', 'to build'));
  });

  it('gives the three kọ́ etymologies three different ids', () => {
    const ids = [
      deriveWordId('kọ́', 'to build, construct'),
      deriveWordId('kọ́', 'a negation particle, used with emphatic pronouns'),
      deriveWordId('kọ́', 'to hang, suspend'),
    ];
    expect(new Set(ids).size).toBe(3);
    expect(ids).toEqual(['ko_to_build', 'ko_a_negation_particle', 'ko_to_hang']);
  });

  it('turns a multi-word Wiktionary form into a usable id', () => {
    expect(deriveWordId('abo adìyẹ', 'hen')).toBe('abo_adiye_hen');
    expect(deriveWordId('ilẹ̀ Faran̄sé', 'France')).toBe('ile_faranse_france');
  });
});

describe('meaningSlug', () => {
  it('takes the first clause of a long Kaikki gloss', () => {
    expect(meaningSlug('a type of long-necked bird with a crest; black crowned crane; giraffe')).toBe(
      'a_type_of_long_necked_bird_with_a_crest',
    );
  });

  it('stops at an opening parenthesis', () => {
    expect(meaningSlug('foot (measurement)')).toBe('foot');
  });

  it('is empty for a missing or unusable gloss', () => {
    expect(meaningSlug(undefined)).toBe('');
    expect(meaningSlug('   ')).toBe('');
    expect(meaningSlug('!!!')).toBe('');
  });
});

describe('deriveWordId with no usable gloss', () => {
  it('falls back to the base alone rather than inventing a meaningless suffix', () => {
    // 15 of 6272 corpus entries are glossless. A curator seeing a bare `a` in the request
    // queue knows to fix it; a fabricated suffix would just look deliberate.
    expect(deriveWordId('adìyẹ', undefined)).toBe('adiye');
    expect(deriveWordId('adìyẹ', '')).toBe('adiye');
  });
});

describe('discriminateWordId', () => {
  it('appends a stable token from the cited entry id', () => {
    expect(discriminateWordId('ko_to_build', 'en-kọ-yo-verb-LIho60Gm')).toBe('ko_to_build_liho60gm');
  });

  it('is deterministic per etymology, so a second volunteer derives the same discriminated id', () => {
    const id = 'en-ko-yo-verb-LIho60Gm';
    expect(discriminateWordId('ko_to_build', id)).toBe(discriminateWordId('ko_to_build', id));
  });

  it('produces different ids for different etymologies', () => {
    expect(discriminateWordId('o_you', 'en-o-yo-pron-KH9Ufvsu')).not.toBe(
      discriminateWordId('o_you', 'en-ọ-yo-pron-jyPyUtaA'),
    );
  });

  it('yields a word_id-safe string even from an odd entry id', () => {
    expect(discriminateWordId('x', 'en-x-yo-noun-a~b_c')).toBe('x_abc');
  });

  it('is NOT enough for a case pair, which is why a third rung exists', () => {
    // The measured tail: 63 corpus entries share a derived id AND an entry-id token with another
    // entry, because their ids differ only in a character this lowercases away.
    expect(discriminateWordId('a_him', 'en-a-yo-pron-ABC')).toBe(discriminateWordId('a_him', 'en-A-yo-pron-ABC'));
  });
});

describe('hashDiscriminateWordId', () => {
  it('separates a case pair the entry-id token cannot', () => {
    expect(hashDiscriminateWordId('a_him', 'en-a-yo-pron-ABC')).not.toBe(
      hashDiscriminateWordId('a_him', 'en-A-yo-pron-ABC'),
    );
  });

  it('is deterministic, so two volunteers requesting one etymology still agree', () => {
    const id = 'en-kọ-yo-verb-LIho60Gm';
    expect(hashDiscriminateWordId('ko_to_build', id)).toBe(hashDiscriminateWordId('ko_to_build', id));
  });

  it('produces a word_id-safe suffix of fixed width', () => {
    expect(hashDiscriminateWordId('x', 'en-x-yo-noun-a~b_c')).toMatch(/^x_[0-9a-f]{8}$/);
  });
});
