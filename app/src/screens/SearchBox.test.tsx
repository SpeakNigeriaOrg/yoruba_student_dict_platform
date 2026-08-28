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

  // Both props below default to absent, and when absent the markup is exactly what it always was -
  // which is what lets the three callers that do not use them stay untouched.
  it('marks the caller\'s current pick without owning the selection state', async () => {
    const search = vi.fn().mockResolvedValue([{ id: 'a', label: 'Result A' }, { id: 'b', label: 'Result B' }]);
    const user = userEvent.setup();

    render(
      <SearchBox<TestResult>
        search={search}
        renderResult={(r) => r.label}
        onSelect={vi.fn()}
        resultsAriaLabel="Test results"
        isSelected={(r) => r.label === 'Result B'}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByText('Result A');

    const [first, second] = screen.getAllByRole('listitem');
    expect(first).not.toHaveAttribute('aria-current');
    expect(second).toHaveAttribute('aria-current', 'true');
    expect(second.className).toContain('selected');
  });

  it('lets a caller replace the action for ONE result, keeping the default for the rest', async () => {
    const search = vi.fn().mockResolvedValue([{ id: 'a', label: 'Result A' }, { id: 'b', label: 'Result B' }]);
    const onSelect = vi.fn();
    const user = userEvent.setup();

    render(
      <SearchBox<TestResult>
        search={search}
        renderResult={(r) => r.label}
        onSelect={onSelect}
        selectLabel="Use this"
        resultsAriaLabel="Test results"
        renderAction={(r) => (r.label === 'Result A' ? <span>not available</span> : null)}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByText('Result A');

    expect(screen.getByText('not available')).toBeInTheDocument();
    // Exactly one default button survives - the row that returned null.
    expect(screen.getAllByRole('button', { name: 'Use this' })).toHaveLength(1);
  });

  it('renders no aria-current and no extra class when neither prop is given', async () => {
    const search = vi.fn().mockResolvedValue([{ id: 'a', label: 'Result A' }]);
    const user = userEvent.setup();

    render(<SearchBox<TestResult> search={search} renderResult={(r) => r.label} onSelect={vi.fn()} resultsAriaLabel="Test results" />);
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByText('Result A');

    const row = screen.getByRole('listitem');
    expect(row).not.toHaveAttribute('aria-current');
    expect(row.className).toBe('search-result-row');
  });

  it('shows pending feedback while an asynchronous selection is being applied', async () => {
    let finish!: () => void;
    const selecting = new Promise<void>((resolve) => { finish = resolve; });
    const user = userEvent.setup();
    render(
      <SearchBox<TestResult>
        search={vi.fn().mockResolvedValue([{ id: 'a', label: 'Result A' }])}
        renderResult={(r) => r.label}
        onSelect={() => selecting}
        resultsAriaLabel="Test results"
        selectingLabel="Adding…"
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByText('Result A');
    await user.click(screen.getByRole('button', { name: 'Use this' }));

    expect(screen.getByRole('button', { name: 'Adding…' })).toBeDisabled();
    finish();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Use this' })).toBeEnabled());
  });

  it('does not let a slower old search overwrite newer results', async () => {
    let finishOld!: (rows: TestResult[]) => void;
    const old = new Promise<TestResult[]>((resolve) => { finishOld = resolve; });
    const search = vi.fn((query: string) => query === 'old' ? old : Promise.resolve([{ id: 'new', label: 'New result' }]));
    const user = userEvent.setup();
    render(<SearchBox<TestResult> search={search} renderResult={(r) => r.label} onSelect={vi.fn()} resultsAriaLabel="Test results" />);

    await user.type(screen.getByRole('textbox'), 'old');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await user.clear(screen.getByRole('textbox'));
    await user.type(screen.getByRole('textbox'), 'new');
    // Enter starts the newer request even while the first search button is disabled.
    await user.keyboard('{Enter}');
    await screen.findByText('New result');
    finishOld([{ id: 'old', label: 'Old result' }]);
    await Promise.resolve();

    expect(screen.queryByText('Old result')).not.toBeInTheDocument();
    expect(screen.getByText('New result')).toBeInTheDocument();
  });
});
