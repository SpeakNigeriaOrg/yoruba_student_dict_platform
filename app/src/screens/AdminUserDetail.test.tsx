// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { AdminUserDetail } from './AdminUserDetail.js';
import userAssignmentsFixture from '../fixtures/userAssignments.json';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('AdminUserDetail', () => {
  it('renders assigned words with both AxisStatusBadges and AxisReviewBadges', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => userAssignmentsFixture }));

    render(<AdminUserDetail userId="u1" onBack={() => {}} onSelectWord={() => {}} onUsersChanged={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('epo')).toBeInTheDocument();
    });
    expect(screen.getByText('spelling: not yet decided')).toBeInTheDocument();
    expect(screen.getByText('audio: not yet recorded')).toBeInTheDocument();
    expect(screen.getByText('spelling: in review')).toBeInTheDocument();
    expect(screen.getByText('etymology: not started')).toBeInTheDocument();
  });

  it("assigning via the paste-textarea calls assignWords with the parsed word_id list and shows created/alreadyAssigned counts", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ created: ['wordA', 'wordB'], alreadyAssigned: ['wordC'] }) });
      }
      return Promise.resolve({ ok: true, json: async () => userAssignmentsFixture });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<AdminUserDetail userId="u1" onBack={() => {}} onSelectWord={() => {}} onUsersChanged={() => {}} />);
    await waitFor(() => screen.getByText('epo'));

    const textarea = screen.getByLabelText(/Or paste word IDs/);
    await user.type(textarea, 'wordA, wordB,wordC');
    await user.click(screen.getByRole('button', { name: 'Add pasted IDs' }));
    await user.click(screen.getByRole('button', { name: /Assign 3 word\(s\)/ }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Assigned 2 word(s). (1 were already assigned.)');
    });

    const postCall = fetchMock.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === 'POST');
    expect(postCall?.[0]).toBe('/api/assignments');
    expect(JSON.parse((postCall?.[1] as RequestInit).body as string)).toEqual({
      userId: 'u1',
      wordIds: ['wordA', 'wordB', 'wordC'],
    });
  });

  it('clicking Unassign calls the delete endpoint and reloads the list', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ userId: 'u1', wordId: 'fixturegenadmin_word1', status: 'unassigned' }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => userAssignmentsFixture });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<AdminUserDetail userId="u1" onBack={() => {}} onSelectWord={() => {}} onUsersChanged={() => {}} />);
    await waitFor(() => screen.getByText('epo'));

    await user.click(screen.getByRole('button', { name: 'Unassign' }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Unassigned fixturegenadmin_word1.');
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/assignments/u1/fixturegenadmin_word1', { method: 'DELETE' });
  });
});
