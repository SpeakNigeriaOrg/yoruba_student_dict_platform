// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { AdminUsers } from './AdminUsers.js';
import usersFixture from '../fixtures/users.json';
import userAssignmentsFixture from '../fixtures/userAssignments.json';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function stubFetchByPath() {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (url.startsWith('/api/assignments/')) {
        return Promise.resolve({ ok: true, json: async () => userAssignmentsFixture });
      }
      return Promise.resolve({ ok: true, json: async () => usersFixture });
    }),
  );
}

describe('AdminUsers', () => {
  it('renders real user data (from getUsers, fixture generated via the real handler against real Postgres)', async () => {
    stubFetchByPath();

    render(<AdminUsers onSelectWord={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('Fixture Volunteer')).toBeInTheDocument();
    });
    const volunteerRow = screen.getByText('Fixture Volunteer').closest('li')!;
    expect(volunteerRow).toHaveTextContent('1 assigned · 1 in review · 0 passed');
  });

  it('shows a user detail view with per-axis reviewStatus badges when a row is clicked', async () => {
    stubFetchByPath();
    const user = userEvent.setup();

    render(<AdminUsers onSelectWord={() => {}} />);
    await waitFor(() => screen.getByText('Fixture Volunteer'));
    await user.click(screen.getByText('Fixture Volunteer'));

    await waitFor(() => {
      expect(screen.getByText('epo')).toBeInTheDocument();
    });
    expect(screen.getByText('spelling: in review')).toBeInTheDocument();
    expect(screen.getByText('definition: not started')).toBeInTheDocument();
    expect(screen.getByText('etymology: not started')).toBeInTheDocument();
  });

  it('shows an empty-state message when there are no users', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ users: [] }) }));

    render(<AdminUsers onSelectWord={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('No user accounts yet.')).toBeInTheDocument();
    });
  });

  it('shows an error message when the request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: 'curator role required' }) }),
    );

    render(<AdminUsers onSelectWord={() => {}} />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('curator role required');
    });
  });
});
