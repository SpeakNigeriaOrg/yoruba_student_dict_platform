// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { AddUserForm } from './AddUserForm.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('AddUserForm', () => {
  it('submits email/displayName/role and reports success, calling onCreated', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        userId: 'u1',
        email: 'newperson@example.com',
        displayName: 'New Person',
        role: 'volunteer',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const onCreated = vi.fn();
    const user = userEvent.setup();

    render(<AddUserForm onCreated={onCreated} />);
    await user.type(screen.getByLabelText(/Google email address/), 'newperson@example.com');
    await user.type(screen.getByLabelText(/Display name/), 'New Person');
    await user.click(screen.getByRole('button', { name: 'Add user' }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Added newperson@example.com as volunteer.');
    });
    expect(onCreated).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/users',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ email: 'newperson@example.com', displayName: 'New Person', role: 'volunteer' }),
      }),
    );
  });

  it('no longer shows an Azure Portal caveat for the curator role', async () => {
    // The role picked here is now authoritative: the roles-source function
    // reads users.role, so there is no separate portal invite to warn about.
    vi.stubGlobal('fetch', vi.fn());
    const user = userEvent.setup();
    render(<AddUserForm onCreated={() => {}} />);

    await user.selectOptions(screen.getByLabelText('Role'), 'curator');
    expect(screen.queryByText(/Azure Static Web Apps portal/)).not.toBeInTheDocument();
  });

  describe('email validation', () => {
    it('keeps submit disabled until the address is email-shaped', async () => {
      // A GitHub handle pasted in here would create a row that silently never
      // matches any login, so it is rejected before it becomes one.
      vi.stubGlobal('fetch', vi.fn());
      const user = userEvent.setup();
      render(<AddUserForm onCreated={() => {}} />);

      expect(screen.getByRole('button', { name: 'Add user' })).toBeDisabled();
      await user.type(screen.getByLabelText(/Google email address/), 'octocat');
      expect(screen.getByRole('button', { name: 'Add user' })).toBeDisabled();
      expect(screen.getByText(/full Google address/)).toBeInTheDocument();

      await user.clear(screen.getByLabelText(/Google email address/));
      await user.type(screen.getByLabelText(/Google email address/), 'octocat@example.com');
      expect(screen.getByRole('button', { name: 'Add user' })).toBeEnabled();
    });

    it('does not post a malformed address', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const user = userEvent.setup();
      render(<AddUserForm onCreated={() => {}} />);

      await user.type(screen.getByLabelText(/Google email address/), 'not-an-email');
      await user.click(screen.getByRole('button', { name: 'Add user' }));

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it('shows an error message when the request fails, e.g. a duplicate email', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({ error: "a user with email 'dupe@example.com' already exists" }),
      }),
    );
    const user = userEvent.setup();

    render(<AddUserForm onCreated={() => {}} />);
    await user.type(screen.getByLabelText(/Google email address/), 'dupe@example.com');
    await user.click(screen.getByRole('button', { name: 'Add user' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent("a user with email 'dupe@example.com' already exists");
    });
  });
});
