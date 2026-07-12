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
    expect(list).toHaveTextContent('definition: decided');
    expect(list).toHaveTextContent('definition: not yet decided');
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

  it('hides definition-decided words when that filter is checked', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ words: allWordsFixture }) }));
    const user = userEvent.setup();

    render(<AllWordsList onSelect={vi.fn()} />);
    await waitFor(() => screen.getByText('fixturegenallwords_wordaspelling'));

    await user.click(screen.getByRole('checkbox', { name: 'Hide definition-decided' }));

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
