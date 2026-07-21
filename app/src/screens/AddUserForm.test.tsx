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
  it('submits username/displayName/role and reports success, calling onCreated', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ userId: 'u1', username: 'newperson', displayName: 'New Person', role: 'volunteer' }) });
    vi.stubGlobal('fetch', fetchMock);
    const onCreated = vi.fn();
    const user = userEvent.setup();

    render(<AddUserForm onCreated={onCreated} />);
    await user.type(screen.getByLabelText(/GitHub \(or Microsoft\) username/), 'newperson');
    await user.type(screen.getByLabelText(/Display name/), 'New Person');
    await user.click(screen.getByRole('button', { name: 'Add user' }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Added newperson as volunteer.');
    });
    expect(onCreated).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/users',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ username: 'newperson', displayName: 'New Person', role: 'volunteer' }),
      }),
    );
  });

  it("shows the curator-role caveat note only when 'Curator' is selected", async () => {
    vi.stubGlobal('fetch', vi.fn());
    const user = userEvent.setup();
    render(<AddUserForm onCreated={() => {}} />);

    expect(screen.queryByText(/Azure Static Web Apps portal/)).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Role'), 'curator');
    expect(screen.getByText(/Azure Static Web Apps portal/)).toBeInTheDocument();
  });

  it('shows an error message when the request fails, e.g. a duplicate username', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: "username 'dupe' already exists" }) }),
    );
    const user = userEvent.setup();

    render(<AddUserForm onCreated={() => {}} />);
    await user.type(screen.getByLabelText(/GitHub \(or Microsoft\) username/), 'dupe');
    await user.click(screen.getByRole('button', { name: 'Add user' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent("username 'dupe' already exists");
    });
  });
});
