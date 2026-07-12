// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { AddWord } from './AddWord.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mockFetch(overrides: Record<string, unknown> = {}) {
  return vi.fn().mockImplementation((url: string) => {
    if (url.includes('/kaikki-search')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          results: overrides.kaikkiResults ?? [
            { form: 'testform', pos: 'noun', glosses: ['a test gloss'], matchedVia: 'yoruba_exact', altOfTargets: [], standardForms: ['testform'] },
          ],
        }),
      });
    }
    if (url.includes('/vocab-search')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          results: overrides.vocabResults ?? [
            { wordId: 'existing_component', displayText: 'existingspelling', syllables: ['exi', 'sting'], definition: null, baseSpelling: 'existingspelling', matchedVia: 'yoruba_exact' },
          ],
        }),
      });
    }
    if (url.includes('/duplicate-check')) {
      return Promise.resolve({ ok: true, json: async () => ({ matches: overrides.duplicates ?? [] }) });
    }
    if (url.includes('/words') || url.includes('/phrases')) {
      return Promise.resolve({ ok: true, json: async () => ({ wordId: 'created_word' }) });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  });
}

describe('AddWord - Word tab', () => {
  it('searches Kaikki, picks a result, and shows a syllables preview and word_id preview', async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<AddWord />);

    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => screen.getByText('testform'));
    await user.click(screen.getByRole('button', { name: 'Select' }));

    expect(screen.getByLabelText('Syllables (comma-separated)')).toHaveValue('te,stfo,rm');

    await user.type(screen.getByLabelText(/Word ID hint/), 'meaning');

    expect(screen.getByText('testform_meaning')).toBeInTheDocument();
  });

  it('submits createWord with the preview word_id and edited syllables', async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<AddWord />);
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => screen.getByText('testform'));
    await user.click(screen.getByRole('button', { name: 'Select' }));
    await user.type(screen.getByLabelText(/Word ID hint/), 'meaning');

    await user.click(screen.getByRole('button', { name: 'Add to vocabulary' }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Added testform_meaning to vocabulary.');
    });

    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/words');
    expect(call).toBeDefined();
    const body = JSON.parse(call![1].body);
    expect(body).toEqual({ wordId: 'testform_meaning', displayText: 'testform', syllables: ['te', 'stfo', 'rm'] });
  });

  it('shows a duplicate warning when the duplicate-check endpoint reports matches', async () => {
    const fetchMock = mockFetch({ duplicates: [{ wordId: 'dupe_word', displayText: 'testform', reason: 'identical spelling' }] });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<AddWord />);
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => screen.getByText('testform'));
    await user.click(screen.getByRole('button', { name: 'Select' }));

    await waitFor(() => {
      expect(screen.getByLabelText('Duplicate warning')).toHaveTextContent('identical spelling');
    });
  });
});

describe('AddWord - Phrase tab', () => {
  it('adds a searched component, derives display text/syllables, and submits createPhrase', async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<AddWord />);
    await user.click(screen.getByRole('button', { name: 'Phrase' }));

    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => screen.getByText('existing_component', { exact: false }));
    await user.click(screen.getByRole('button', { name: 'Add' }));

    const componentsList = screen.getByLabelText('Phrase components');
    expect(componentsList).toHaveTextContent('existing_component');

    await user.type(screen.getByLabelText('Word ID hint'), 'phrasehint');
    await user.click(screen.getByRole('button', { name: 'Add phrase to vocabulary' }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Added phrase');
    });

    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/phrases');
    expect(call).toBeDefined();
    const body = JSON.parse(call![1].body);
    expect(body).toEqual({
      wordId: 'existingspelling_phrasehint',
      displayText: 'existingspelling',
      syllables: ['exi', 'sting'],
      components: ['existing_component'],
    });
  });

  it('refuses to submit with no components', async () => {
    vi.stubGlobal('fetch', mockFetch());
    const user = userEvent.setup();

    render(<AddWord />);
    await user.click(screen.getByRole('button', { name: 'Phrase' }));
    await user.click(screen.getByRole('button', { name: 'Add phrase to vocabulary' }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('A phrase needs at least one component.');
    });
  });

  it('removing a component chip removes it from the list', async () => {
    vi.stubGlobal('fetch', mockFetch());
    const user = userEvent.setup();

    render(<AddWord />);
    await user.click(screen.getByRole('button', { name: 'Phrase' }));
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => screen.getByText('existing_component', { exact: false }));
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(screen.getByLabelText('Phrase components')).toHaveTextContent('existing_component');
    await user.click(screen.getByRole('button', { name: 'Remove' }));

    expect(screen.getByText('No components picked yet.')).toBeInTheDocument();
  });
});
