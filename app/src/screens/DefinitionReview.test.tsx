// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { DefinitionReview } from './DefinitionReview.js';
import definitionFixture from '../fixtures/definitionReview.json';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('DefinitionReview', () => {
  it('renders a real proposed-definition diagnosis (fixture generated via the real getDefinitionReview handler against real Postgres)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => definitionFixture }));

    render(<DefinitionReview wordId="fixturegenspldef_definitionword_leopard" />);

    await waitFor(() => {
      expect(screen.getByText('fixturegenspldef_amotekun')).toBeInTheDocument();
    });

    const diagnosis = screen.getByLabelText('Definition diagnosis');
    expect(diagnosis).toHaveTextContent('proposed');
    expect(diagnosis).toHaveTextContent('leopard');

    const axisStatus = screen.getByLabelText('Review axis status');
    expect(axisStatus).toHaveTextContent('Definition (not yet decided)');

    // No current definition yet - confirm button should be disabled.
    expect(screen.getByRole('button', { name: 'Confirm current definition' })).toBeDisabled();
  });

  it('submits custom with the proposed definition text when accepted', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/definition')) return Promise.resolve({ ok: true, json: async () => definitionFixture });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<DefinitionReview wordId="fixturegenspldef_definitionword_leopard" />);
    await waitFor(() => screen.getByText('fixturegenspldef_amotekun'));

    await user.click(screen.getByRole('button', { name: 'Accept proposed definition' }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Accepted proposed definition: leopard');
    });

    const decisionCall = fetchMock.mock.calls.find((c) => c[0] === '/api/decisions/definition');
    expect(decisionCall).toBeDefined();
    const body = JSON.parse(decisionCall![1].body);
    expect(body).toEqual({
      wordId: 'fixturegenspldef_definitionword_leopard',
      definitionAction: 'custom',
      definitionText: 'leopard',
    });
  });

  it('shows an error message when the request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: 'word not found' }) }),
    );

    render(<DefinitionReview wordId="nonexistent" />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('word not found');
    });
  });
});
