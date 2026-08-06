import { describe, expect, it } from 'vitest';
import { buildPin, compareSpellingToPin, isCitableEntryId, pinContentFingerprint, type UpstreamPin } from './upstreamPin';
import type { KaikkiSense } from './types';

/** Modelled on the real `kọ́` etymology 2, which has two senses under one
 * etymology - the case the whole set-comparison rule exists for. */
function koBuild(over: Partial<KaikkiSense> = {}): KaikkiSense {
  return {
    entryId: 'en-ko-yo-verb-OFVmd8R8',
    pos: 'verb',
    etymologyNumber: '2',
    etymologyText: 'From Proto-Yoruboid.',
    headword: 'kọ́',
    canonicalForm: { value: 'kọ́', inferenceMethod: 'test', confidence: 1, originalValue: 'kọ́' },
    standardForms: ['kọ́'],
    glosses: ['to build, construct', 'to learn, teach, instruct, acquire'],
    altOfTargets: [],
    componentCandidates: [],
    derivedForms: [],
    ...over,
  };
}

describe('buildPin', () => {
  it('copies the content a human judged, so nothing needs a live Kaikki lookup later', () => {
    expect(buildPin(koBuild())).toEqual({
      etymologyNumber: '2',
      pos: 'verb',
      canonicalForm: 'kọ́',
      glosses: ['to build, construct', 'to learn, teach, instruct, acquire'],
      etymologyText: 'From Proto-Yoruboid.',
    });
  });

  it('carries no entryId - upstream_citations.entry_id is the one source of truth for which etymology', () => {
    expect(buildPin(koBuild())).not.toHaveProperty('entryId');
  });

  it('keeps upstream gloss ORDER, because the first gloss seeds the student definition', () => {
    expect(buildPin(koBuild()).glosses[0]).toBe('to build, construct');
  });

  it('snapshots the glosses rather than aliasing the sense, so a later ingest cannot mutate a taken pin', () => {
    const sense = koBuild();
    const pin = buildPin(sense);
    sense.glosses.push('to hang, suspend');
    expect(pin.glosses).toHaveLength(2);
  });

  it('tolerates a sense with no etymology number or prose', () => {
    expect(buildPin(koBuild({ etymologyNumber: null, etymologyText: undefined }))).toMatchObject({
      etymologyNumber: null,
      etymologyText: null,
    });
  });
});

describe('pinContentFingerprint', () => {
  const base = buildPin(koBuild());

  it('is stable across a JSON round trip - the pin is stored as jsonb, which does not preserve key order', () => {
    const roundTripped: UpstreamPin = JSON.parse(JSON.stringify(base));
    expect(pinContentFingerprint(roundTripped)).toBe(pinContentFingerprint(base));
  });

  it('ignores senses being REORDERED inside one etymology - the id moves but the meaning does not', () => {
    const reordered = buildPin(koBuild({ glosses: ['to learn, teach, instruct, acquire', 'to build, construct'] }));
    expect(pinContentFingerprint(reordered)).toBe(pinContentFingerprint(base));
  });

  it('reports a gloss being REWORDED', () => {
    const edited = buildPin(koBuild({ glosses: ['to build, erect', 'to learn, teach, instruct, acquire'] }));
    expect(pinContentFingerprint(edited)).not.toBe(pinContentFingerprint(base));
  });

  it('reports a gloss being ADDED, even though every original gloss survives', () => {
    const grown = buildPin(koBuild({ glosses: [...base.glosses, 'to sing'] }));
    expect(pinContentFingerprint(grown)).not.toBe(pinContentFingerprint(base));
  });

  it('reports a gloss being REMOVED', () => {
    const shrunk = buildPin(koBuild({ glosses: ['to build, construct'] }));
    expect(pinContentFingerprint(shrunk)).not.toBe(pinContentFingerprint(base));
  });

  it('reports renumbering, which is the drift that motivated citations at all', () => {
    const renumbered = buildPin(koBuild({ etymologyNumber: '3' }));
    expect(pinContentFingerprint(renumbered)).not.toBe(pinContentFingerprint(base));
  });

  it('reports a changed pos or canonical form', () => {
    expect(pinContentFingerprint(buildPin(koBuild({ pos: 'noun' })))).not.toBe(pinContentFingerprint(base));
    expect(
      pinContentFingerprint(
        buildPin(koBuild({ canonicalForm: { value: 'kọ', inferenceMethod: 't', confidence: 1, originalValue: 'kọ' } })),
      ),
    ).not.toBe(pinContentFingerprint(base));
  });

  it('ignores etymology PROSE being copy-edited - noise a curator cannot action', () => {
    const reworded = buildPin(koBuild({ etymologyText: 'Inherited from Proto-Yoruboid; see also related forms.' }));
    expect(pinContentFingerprint(reworded)).toBe(pinContentFingerprint(base));
  });

  it('treats a decomposed tone mark as the same form (NFC), since a keyboard may emit either', () => {
    const decomposed = buildPin(koBuild({ canonicalForm: { value: 'kọ́'.normalize('NFD'), inferenceMethod: 't', confidence: 1, originalValue: 'x' } }));
    expect(pinContentFingerprint(decomposed)).toBe(pinContentFingerprint(base));
  });

  it('does not treat gloss capitalisation or spacing as drift', () => {
    const cosmetic = buildPin(koBuild({ glosses: ['To Build,  construct', 'to learn, teach, instruct, acquire  '] }));
    expect(pinContentFingerprint(cosmetic)).toBe(pinContentFingerprint(base));
  });

  it('distinguishes an absent etymology number from the string "null"-ish emptiness', () => {
    const absent = buildPin(koBuild({ etymologyNumber: null }));
    const empty = buildPin(koBuild({ etymologyNumber: '' }));
    expect(pinContentFingerprint(absent)).not.toBe(pinContentFingerprint(empty));
  });

  it('contains no NUL byte - Postgres text forbids 0x00, and this is stored in a text column', () => {
    for (const pin of [base, buildPin(koBuild({ etymologyNumber: null, glosses: [] }))]) {
      expect(pinContentFingerprint(pin)).not.toContain(String.fromCharCode(0));
    }
  });
});

describe('compareSpellingToPin', () => {
  const pin = buildPin(koBuild({ canonicalForm: { value: 'adìyẹ', inferenceMethod: 't', confidence: 1, originalValue: 'adìyẹ' } }));

  it('reports a match, which is the case the old screen offered a false choice for', () => {
    expect(compareSpellingToPin('adìyẹ', pin)).toBe('matches');
  });

  it('reports a real difference', () => {
    expect(compareSpellingToPin('adiye', pin)).toBe('differs');
  });

  it('does not treat Unicode composition as a spelling disagreement', () => {
    expect(compareSpellingToPin('adìyẹ'.normalize('NFD'), pin)).toBe('matches');
  });

  it('does not treat capitalisation alone as a spelling disagreement', () => {
    expect(compareSpellingToPin('Adìyẹ', pin)).toBe('matches');
  });

  it('reports not_cited for an exempt word, whose pin holds no upstream content', () => {
    expect(compareSpellingToPin('rédíò', null)).toBe('not_cited');
    // Exempt rows store {} as the pin - it must not read as "matches ''".
    expect(compareSpellingToPin('rédíò', {} as never)).toBe('not_cited');
  });
});

describe('isCitableEntryId', () => {
  it('accepts a wiktextract-assigned id', () => {
    expect(isCitableEntryId('en-ko-yo-verb-OFVmd8R8')).toBe(true);
  });

  it('refuses kaikki-yoruba\'s processing-order fallback, which looks stable but is not', () => {
    expect(isCitableEntryId('generated-ko-verb-417')).toBe(false);
  });

  it('refuses a missing id rather than treating it as citable', () => {
    expect(isCitableEntryId(null)).toBe(false);
    expect(isCitableEntryId(undefined)).toBe(false);
    expect(isCitableEntryId('')).toBe(false);
  });
});
