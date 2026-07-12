// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { SearchBox } from './SearchBox.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

interface TestResult {
  id: string;
  label: string;
}

describe('SearchBox', () => {
  it('runs the search on button click and renders results with a select button each', async () => {
    const search = vi.fn().mockResolvedValue([{ id: 'a', label: 'Result A' }, { id: 'b', label: 'Result B' }]);
    const onSelect = vi.fn();
    const user = userEvent.setup();

    render(
      <SearchBox<TestResult>
        search={search}
        renderResult={(r) => r.label}
        onSelect={onSelect}
        resultsAriaLabel="Test results"
      />,
    );

    await user.type(screen.getByRole('textbox'), 'query text');
    await user.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() => {
      expect(screen.getByLabelText('Test results')).toBeInTheDocument();
    });
    expect(search).toHaveBeenCalledWith('query text');
    expect(screen.getByText('Result A')).toBeInTheDocument();
    expect(screen.getByText('Result B')).toBeInTheDocument();
  });

  it('runs the search on Enter key press', async () => {
    const search = vi.fn().mockResolvedValue([]);
    const user = userEvent.setup();

    render(<SearchBox<TestResult> search={search} renderResult={(r) => r.label} onSelect={vi.fn()} resultsAriaLabel="Test results" />);

    await user.type(screen.getByRole('textbox'), 'enter query{Enter}');

    await waitFor(() => {
      expect(search).toHaveBeenCalledWith('enter query');
    });
    expect(screen.getByText('No results.')).toBeInTheDocument();
  });

  it('calls onSelect with the clicked result', async () => {
    const search = vi.fn().mockResolvedValue([{ id: 'a', label: 'Result A' }]);
    const onSelect = vi.fn();
    const user = userEvent.setup();

    render(<SearchBox<TestResult> search={search} renderResult={(r) => r.label} onSelect={onSelect} resultsAriaLabel="Test results" />);

    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => screen.getByText('Result A'));
    await user.click(screen.getByRole('button', { name: 'Use this' }));

    expect(onSelect).toHaveBeenCalledWith({ id: 'a', label: 'Result A' });
  });

  it('pre-fills the query and auto-runs the search once on mount when initialQuery is given', async () => {
    const search = vi.fn().mockResolvedValue([{ id: 'a', label: 'Result A' }]);

    render(
      <SearchBox<TestResult>
        search={search}
        renderResult={(r) => r.label}
        onSelect={vi.fn()}
        resultsAriaLabel="Test results"
        initialQuery="seeded query"
      />,
    );

    expect(screen.getByRole('textbox')).toHaveValue('seeded query');
    await waitFor(() => {
      expect(search).toHaveBeenCalledWith('seeded query');
    });
    expect(screen.getByText('Result A')).toBeInTheDocument();
  });

  it('shows an error message when the search fails', async () => {
    const search = vi.fn().mockRejectedValue(new Error('search failed'));
    const user = userEvent.setup();

    render(<SearchBox<TestResult> search={search} renderResult={(r) => r.label} onSelect={vi.fn()} resultsAriaLabel="Test results" />);

    await user.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('search failed');
    });
  });
});
