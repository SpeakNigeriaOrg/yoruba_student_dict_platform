// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { AssignmentsList } from './AssignmentsList.js';
import assignmentsFixture from '../fixtures/assignments.json';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('AssignmentsList', () => {
  it('renders real assignment data (from getMyAssignments, fixture generated via the real handler against real Postgres)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => assignmentsFixture }),
    );

    render(<AssignmentsList onSelect={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('fixturegencompoundspelling')).toBeInTheDocument();
    });
    expect(screen.getByText(/a made-up test word/)).toBeInTheDocument();

    // Same per-axis status badges as the browse-all-words list (including
    // audio, which this screen never showed at all before).
    const row = screen.getByText('fixturegencompoundspelling').closest('li')!;
    expect(row).toHaveTextContent('spelling: not yet decided');
    expect(row).toHaveTextContent('definition: not yet decided');
    expect(row).toHaveTextContent('etymology: not yet decided');
    expect(row).toHaveTextContent('audio: not yet recorded');
  });

  it('calls onSelect with the wordId when a row is clicked', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => assignmentsFixture }),
    );
    const onSelect = vi.fn();
    const user = userEvent.setup();

    render(<AssignmentsList onSelect={onSelect} />);
    await waitFor(() => screen.getByText('fixturegencompoundspelling'));
    await user.click(screen.getByText('fixturegencompoundspelling'));

    expect(onSelect).toHaveBeenCalledWith('fixturegencompound_madeupword');
  });

  it('shows an empty-state message when there are no assignments', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));

    render(<AssignmentsList onSelect={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('No words assigned to you right now.')).toBeInTheDocument();
    });
  });

  it('shows an error message when the request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: 'not authenticated' }) }),
    );

    render(<AssignmentsList onSelect={() => {}} />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('not authenticated');
    });
  });
});
