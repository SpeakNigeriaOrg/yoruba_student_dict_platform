// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { ContributionQueue } from './ContributionQueue.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const sampleContribution = {
  contributionId: 'contrib-1',
  wordId: 'test_word',
  wordDisplayText: 'testspelling',
  axis: 'definition',
  proposedValue: { definitionAction: 'custom', definitionText: 'a proposed definition' },
  note: 'a submitter note',
  submittedBy: 'a_volunteer',
  submittedAt: '2026-01-01T00:00:00.000Z',
  status: 'pending',
};

describe('ContributionQueue', () => {
  it('renders a pending contribution with its context', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ contributions: [sampleContribution] }) }));

    render(<ContributionQueue />);

    await waitFor(() => {
      expect(screen.getByLabelText('Pending contributions')).toBeInTheDocument();
    });

    const list = screen.getByLabelText('Pending contributions');
    expect(list).toHaveTextContent('testspelling');
    expect(list).toHaveTextContent('a_volunteer');
    expect(list).toHaveTextContent('a submitter note');
    expect(list).toHaveTextContent('a proposed definition');
  });

  it('shows a message when there are no pending contributions', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ contributions: [] }) }));

    render(<ContributionQueue />);

    await waitFor(() => {
      expect(screen.getByText('No pending contributions.')).toBeInTheDocument();
    });
  });

  it('approves a contribution and reloads the list', async () => {
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/approve')) return Promise.resolve({ ok: true, json: async () => ({ contributionId: 'contrib-1', status: 'approved' }) });
      callCount += 1;
      return Promise.resolve({
        ok: true,
        json: async () => ({ contributions: callCount === 1 ? [sampleContribution] : [] }),
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<ContributionQueue />);
    await waitFor(() => screen.getByRole('button', { name: 'Approve' }));

    await user.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Approved contribution contrib-1.');
    });
    const approveCall = fetchMock.mock.calls.find((c) => c[0].includes('/approve'));
    expect(approveCall![0]).toBe('/api/contributions/contrib-1/approve');
    expect(approveCall![1].method).toBe('POST');
  });

  it('rejects a contribution and reloads the list', async () => {
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/reject')) return Promise.resolve({ ok: true, json: async () => ({ contributionId: 'contrib-1', status: 'rejected' }) });
      callCount += 1;
      return Promise.resolve({
        ok: true,
        json: async () => ({ contributions: callCount === 1 ? [sampleContribution] : [] }),
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<ContributionQueue />);
    await waitFor(() => screen.getByRole('button', { name: 'Reject' }));

    await user.click(screen.getByRole('button', { name: 'Reject' }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Rejected contribution contrib-1.');
    });
    const rejectCall = fetchMock.mock.calls.find((c) => c[0].includes('/reject'));
    expect(rejectCall![0]).toBe('/api/contributions/contrib-1/reject');
    expect(rejectCall![1].method).toBe('POST');
  });

  it('shows an error message when the request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: 'curator role required' }) }),
    );

    render(<ContributionQueue />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('curator role required');
    });
  });
});
