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

    render(<AdminUsers onSelectUser={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('Fixture Volunteer')).toBeInTheDocument();
    });
    const volunteerRow = screen.getByText('Fixture Volunteer').closest('li')!;
    expect(volunteerRow).toHaveTextContent('1 assigned · 1 in review · 0 passed');
  });

  it('reports the selected user upward instead of rendering the detail view itself', async () => {
    // The detail view is its own route (#/users/{id}) now. This component
    // owning that selection privately is what produced the two-nav-stacks
    // bug where Back from a word landed on the user list. The badges it used
    // to render here are covered by AdminUserDetail.test.tsx.
    stubFetchByPath();
    const onSelectUser = vi.fn();
    const user = userEvent.setup();

    render(<AdminUsers onSelectUser={onSelectUser} />);
    await waitFor(() => screen.getByText('Fixture Volunteer'));
    await user.click(screen.getByText('Fixture Volunteer'));

    expect(onSelectUser).toHaveBeenCalledTimes(1);
    expect(onSelectUser.mock.calls[0][0]).toBeTruthy();
    // Still the list - no detail view rendered from in here.
    expect(screen.queryByLabelText('User assignment detail')).not.toBeInTheDocument();
  });

  it('shows an empty-state message when there are no users', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ users: [] }) }));

    render(<AdminUsers onSelectUser={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('No user accounts yet.')).toBeInTheDocument();
    });
  });

  it('shows an error message when the request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: 'curator role required' }) }),
    );

    render(<AdminUsers onSelectUser={() => {}} />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('curator role required');
    });
  });

  describe('role management', () => {
    // Only possible on the Standard plan, where a roles-source function reads
    // users.role - this used to require an Azure Portal invite.
    it('promotes a volunteer via PATCH and says when it takes effect', async () => {
      const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
        if (init?.method === 'PATCH') {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              userId: '7d2910ba-0aab-43c4-a251-a762ebb563dd',
              email: 'fixturegenadmin_volunteer@example.com',
              displayName: 'Fixture Volunteer',
              role: 'curator',
            }),
          });
        }
        return Promise.resolve({ ok: true, json: async () => usersFixture });
      });
      vi.stubGlobal('fetch', fetchMock);
      const user = userEvent.setup();

      render(<AdminUsers onSelectUser={() => {}} />);
      await waitFor(() => screen.getByRole('button', { name: /Make Fixture Volunteer a curator/ }));
      await user.click(screen.getByRole('button', { name: /Make Fixture Volunteer a curator/ }));

      await waitFor(() => {
        expect(screen.getByRole('status')).toHaveTextContent(/is now a curator/);
      });
      // The caching caveat is surfaced, not hidden: SWA caches roles into the
      // session token, so a role change is not instant for the user.
      expect(screen.getByRole('status')).toHaveTextContent(/next sign-in/);

      const patch = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'PATCH');
      expect(patch?.[0]).toBe('/api/users/7d2910ba-0aab-43c4-a251-a762ebb563dd');
      expect((patch?.[1] as RequestInit).body).toBe(JSON.stringify({ role: 'curator' }));
    });

    it('offers demotion for an existing curator', async () => {
      stubFetchByPath();
      render(<AdminUsers onSelectUser={() => {}} />);

      await waitFor(() => screen.getByRole('button', { name: /Make Fixture Curator a volunteer/ }));
    });

    it('surfaces the last-curator guard as an error', async () => {
      const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
        if (init?.method === 'PATCH') {
          return Promise.resolve({
            ok: false,
            status: 409,
            json: async () => ({ error: 'cannot demote the last curator - promote another curator first' }),
          });
        }
        return Promise.resolve({ ok: true, json: async () => usersFixture });
      });
      vi.stubGlobal('fetch', fetchMock);
      const user = userEvent.setup();

      render(<AdminUsers onSelectUser={() => {}} />);
      await waitFor(() => screen.getByRole('button', { name: /Make Fixture Curator a volunteer/ }));
      await user.click(screen.getByRole('button', { name: /Make Fixture Curator a volunteer/ }));

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent(/cannot demote the last curator/);
      });
    });
  });
});
