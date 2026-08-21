// functions/words.parse.test.ts
//
// The seam between the screen and the handler, which had no test of its own.
//
// parseCreateWordInput is a whitelist, so anything it does not explicitly name is dropped before
// the handler ever sees it - silently, and with a 201 back to the browser. `components` was sent by
// the Add Word screen, accepted by createWord, and lost in between for exactly that reason. The
// screen's tests assert what the browser POSTs and the handler's tests call createWord directly;
// only this file covers the gap.
//
// No database: this is pure input parsing.

import { describe, expect, it } from 'vitest';
import { parseCreateWordInput } from './words.js';

const VALID = {
  wordId: 'oju_face',
  displayText: 'ojú',
  syllables: ['o', 'jú'],
  citation: { exemptReason: 'test' },
};

describe('parseCreateWordInput: the optional decomposition', () => {
  it('carries components through to the handler', () => {
    const input = parseCreateWordInput({ ...VALID, components: ['ile_house', 'oju_face'] });
    expect(input.components).toEqual(['ile_house', 'oju_face']);
  });

  it('leaves components absent when the client sent none', () => {
    // Absent, not [] - the handler treats them the same, but only one is what the client said.
    const input = parseCreateWordInput(VALID);
    expect('components' in input).toBe(false);
  });

  it('keeps an explicitly empty list distinguishable from an absent one', () => {
    const input = parseCreateWordInput({ ...VALID, components: [] });
    expect(input.components).toEqual([]);
  });

  it('rejects a components value that is not an array of strings', () => {
    expect(() => parseCreateWordInput({ ...VALID, components: 'ile_house' })).toThrow(/components/);
    expect(() => parseCreateWordInput({ ...VALID, components: [1, 2] })).toThrow(/components/);
  });

  it('still parses the fields it always did', () => {
    const input = parseCreateWordInput({ ...VALID, definition: 'eye, face' });
    expect(input.wordId).toBe('oju_face');
    expect(input.displayText).toBe('ojú');
    expect(input.syllables).toEqual(['o', 'jú']);
    expect(input.definition).toBe('eye, face');
  });
});
