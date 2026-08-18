// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { AllWordsList } from './AllWordsList.js';
import allWordsFixture from '../fixtures/allWords.json';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('AllWordsList', () => {
  it('renders every real word with its per-axis decided status (fixture generated via the real listAllWords handler against real Postgres)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ words: allWordsFixture }) }));

    render(<AllWordsList onSelect={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('fixturegenallwords_wordaspelling')).toBeInTheDocument();
    });
    expect(screen.getByText('fixturegenallwords_wordbspelling')).toBeInTheDocument();

    const list = screen.getByLabelText('All words');
    expect(list).toHaveTextContent('entry: decided');
    expect(list).toHaveTextContent('entry: not yet decided');
    expect(list).toHaveTextContent('audio: not yet recorded');
  });

  it('calls onSelect with the clicked word_id', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ words: allWordsFixture }) }));
    const onSelect = vi.fn();
    const user = userEvent.setup();

    render(<AllWordsList onSelect={onSelect} />);
    await waitFor(() => screen.getByText('fixturegenallwords_wordaspelling'));

    await user.click(screen.getByText('fixturegenallwords_wordaspelling'));

    expect(onSelect).toHaveBeenCalledWith('fixturegenallwords_worda');
  });

  it('filters by text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ words: allWordsFixture }) }));
    const user = userEvent.setup();

    render(<AllWordsList onSelect={vi.fn()} />);
    await waitFor(() => screen.getByText('fixturegenallwords_wordaspelling'));

    await user.type(screen.getByLabelText('Filter words'), 'wordaspelling');

    expect(screen.getByText('fixturegenallwords_wordaspelling')).toBeInTheDocument();
    expect(screen.queryByText('fixturegenallwords_wordbspelling')).not.toBeInTheDocument();
  });

  describe('finds a phrase the reader cannot spell exactly, which is why they are searching', () => {
    // The bug: this box ran its own `displayText.toLowerCase().includes(query.toLowerCase())`,
    // codepoint-exact after case folding. `fi sílẹ̀` reported no results while `fi_sile_leave_it`
    // sat in the list, and the next thing a curator does after no results is add the duplicate.
    // It asks the shared engine now - the same one the component picker and the etymology widget
    // search through /api/vocab-search.
    const PHRASE = [
      {
        wordId: 'fi_sile_leave_it',
        displayText: 'fi sílẹ̀',
        syllables: ['fi', 'sí', 'lẹ̀'],
        definition: 'to leave something alone',
        entryType: 'phrase',
        axisDecided: { entry: false, etymology: false, audio: false },
      },
      ...allWordsFixture,
    ];

    async function browsing() {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ words: PHRASE }) }));
      const user = userEvent.setup();
      render(<AllWordsList onSelect={vi.fn()} />);
      await waitFor(() => screen.getByText('fi sílẹ̀'));
      return user;
    }

    it('matches the same spelling typed with a different Unicode composition', async () => {
      // `ẹ̀` has no single codepoint, so it is a base plus a combining grave - and the underdot
      // can be precomposed (U+1EB9) or a combining mark of its own. The two render identically and
      // both are correct input. This query is the decomposed one, in caps; the record holds the
      // other. The old filter compared them as raw codepoints and said no.
      const user = await browsing();
      await user.type(screen.getByLabelText('Filter words'), 'FI SÍLẸ̀');
      expect(screen.getByText('fi sílẹ̀')).toBeInTheDocument();
    });

    it('matches without the tone marks a phone keyboard cannot produce', async () => {
      const user = await browsing();
      await user.type(screen.getByLabelText('Filter words'), 'fi sile');
      expect(screen.getByText('fi sílẹ̀')).toBeInTheDocument();
    });

    it('matches a word from the middle of the phrase, not only its start', async () => {
      const user = await browsing();
      await user.type(screen.getByLabelText('Filter words'), 'sile');
      expect(screen.getByText('fi sílẹ̀')).toBeInTheDocument();
    });

    it('matches on the meaning, which the old filter never looked at', async () => {
      const user = await browsing();
      await user.type(screen.getByLabelText('Filter words'), 'leave');
      expect(screen.getByText('fi sílẹ̀')).toBeInTheDocument();
    });

    it('still says nothing when the dictionary really does not hold it', async () => {
      const user = await browsing();
      await user.type(screen.getByLabelText('Filter words'), 'kò sí nǹkan');
      expect(screen.getByText('No words match the current filters.')).toBeInTheDocument();
    });
  });

  it('hides entry-decided words when that filter is checked', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ words: allWordsFixture }) }));
    const user = userEvent.setup();

    render(<AllWordsList onSelect={vi.fn()} />);
    await waitFor(() => screen.getByText('fixturegenallwords_wordaspelling'));

    await user.click(screen.getByRole('checkbox', { name: 'Hide entry-decided' }));

    expect(screen.queryByText('fixturegenallwords_wordaspelling')).not.toBeInTheDocument();
    expect(screen.getByText('fixturegenallwords_wordbspelling')).toBeInTheDocument();
  });

  it('shows an error message when the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: 'curator role required' }) }));

    render(<AllWordsList onSelect={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('curator role required');
    });
  });
});
