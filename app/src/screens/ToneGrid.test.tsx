// @vitest-environment jsdom
//
// The nasal control. ToneGrid's tone buttons are covered through its two callers
// (EntryReview.test.tsx, ExampleContribution.test.tsx); what needs testing directly is the one
// control whose whole job is to change how many columns there are.

import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { ToneGrid } from './ToneGrid.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** A grid holding its own state, so a flip followed by a tone tap behaves as it does in the app:
 * the second action operates on the array the first produced, and the column count has changed
 * underneath it. A vi.fn() alone cannot show that. */
function renderControlled(initial: string[]) {
  const seen: string[][] = [];

  function Harness() {
    const [syllables, setSyllables] = useState(initial);
    return (
      <ToneGrid
        syllables={syllables}
        onChange={(next) => {
          seen.push(next);
          setSyllables(next);
        }}
      />
    );
  }

  render(<Harness />);
  return { latest: () => seen[seen.length - 1] };
}

describe('freeing an absorbed nasal', () => {
  it('offers the control only on the column where the ambiguity is live', () => {
    render(<ToneGrid syllables={['a', 'lan', 'gba']} onChange={() => {}} />);

    // `lan` ends in an absorbed nasal; `a` and `gba` do not.
    expect(screen.getByRole('button', { name: 'Make the nasal of syllable 2 its own syllable' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Make the nasal of syllable 1 its own syllable' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Make the nasal of syllable 3 its own syllable' }),
    ).not.toBeInTheDocument();
  });

  it('names the letter it is about, so the button is not a mystery', () => {
    render(<ToneGrid syllables={['a', 'lan', 'gba']} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Make the nasal of syllable 2 its own syllable' })).toHaveTextContent(
      'split off n',
    );
  });

  it('reports a four-syllable split with the nasal marked mid', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ToneGrid syllables={['a', 'lan', 'gba']} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: 'Make the nasal of syllable 2 its own syllable' }));

    // The macron is what makes the new boundary re-derivable from the spelling.
    expect(onChange).toHaveBeenCalledWith(['a', 'la', 'n̄', 'gba']);
  });

  it('offers nothing where the letters already decide the question', () => {
    // Plain `o` cannot be nasalised, so syllabify has already split this one; there is no choice
    // to offer, and nasalSplit returns null without this file knowing the rule.
    render(<ToneGrid syllables={['ko', 'n̄']} onChange={() => {}} />);
    expect(screen.queryByRole('button', { name: /its own syllable/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /syllable before it/ })).not.toBeInTheDocument();
  });

  it('offers nothing on a word with no nasal at all', () => {
    render(<ToneGrid syllables={['e', 'ji', 'ka']} onChange={() => {}} />);
    expect(screen.queryByRole('button', { name: /its own syllable/ })).not.toBeInTheDocument();
  });
});

describe('joining a freed nasal back', () => {
  it('offers the control on a lone nasal column, and reports the merged split', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ToneGrid syllables={['a', 'lá', 'ǹ', 'gbá']} onChange={onChange} />);

    const join = screen.getByRole('button', { name: 'Join the nasal of syllable 3 to the syllable before it' });
    expect(join).toHaveTextContent('join to lá');
    await user.click(join);

    // The nasal's own tone mark goes: a coda carries no tone, the vowel does.
    expect(onChange).toHaveBeenCalledWith(['a', 'lán', 'gbá']);
  });

  it('does not offer joining where no coda is licensed', () => {
    // `m` is only a coda before b/p, and `ta` is neither.
    render(<ToneGrid syllables={['a', 'm', 'ta']} onChange={() => {}} />);
    expect(screen.queryByRole('button', { name: /syllable before it/ })).not.toBeInTheDocument();
  });

  it('does offer joining an m when a labial follows', () => {
    render(<ToneGrid syllables={['jà', 'm̀', 'bá']} onChange={() => {}} />);
    expect(
      screen.getByRole('button', { name: 'Join the nasal of syllable 2 to the syllable before it' }),
    ).toBeInTheDocument();
  });

  it('never offers joining on the first column, where there is nothing to join to', () => {
    render(<ToneGrid syllables={['n̄', 'kọ́']} onChange={() => {}} />);
    expect(screen.queryByRole('button', { name: /syllable before it/ })).not.toBeInTheDocument();
  });
});

describe('the point of the phase: reaching a spelling that was previously unreachable', () => {
  it('gets from a bare alangba to aláǹgbá, which no sequence of tone taps could do', async () => {
    const user = userEvent.setup();
    const { latest } = renderControlled(['a', 'lan', 'gba']);

    // Free the nasal, which also gives it its own tone column.
    await user.click(screen.getByRole('button', { name: 'Make the nasal of syllable 2 its own syllable' }));
    expect(latest()).toEqual(['a', 'la', 'n̄', 'gba']);

    // Now tone it like any other syllable. Four columns, so the nasal is syllable 3.
    await user.click(screen.getByRole('button', { name: 'Syllable 2 high tone' }));
    await user.click(screen.getByRole('button', { name: 'Syllable 3 low tone' }));
    await user.click(screen.getByRole('button', { name: 'Syllable 4 high tone' }));

    expect(latest()).toEqual(['a', 'lá', 'ǹ', 'gbá']);
    expect(latest().join('')).toBe('aláǹgbá');
  });

  it('and back again, so the correction is not a one-way door', async () => {
    const user = userEvent.setup();
    const { latest } = renderControlled(['a', 'lá', 'ǹ', 'gbá']);

    await user.click(screen.getByRole('button', { name: 'Join the nasal of syllable 3 to the syllable before it' }));

    expect(latest()).toEqual(['a', 'lán', 'gbá']);
    expect(latest().join('')).toBe('alángbá');
  });
});
