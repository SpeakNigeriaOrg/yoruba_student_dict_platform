// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { AdminUserDetail } from './AdminUserDetail.js';
import userAssignmentsFixture from '../fixtures/userAssignments.json';
import type { UserDossier } from '../api.js';

/** The account this screen is about.
 *
 * Every test here used to answer EVERY request with the assignments fixture, which was fine
 * while the screen asked for one thing. It now also loads the user, so a single canned body
 * would hand the dossier an assignments payload - which is how a screen that never showed
 * the email came to have a passing test suite. */
const USER: UserDossier = {
  userId: 'u1',
  email: 'ada@example.com',
  displayName: 'Ada Lovelace',
  role: 'volunteer',
  createdAt: '2026-01-15T10:00:00.000Z',
  rights: {
    releaseState: 'agreed',
    instrument: 'in_app_acceptance',
    agreedVersion: 'contributor-terms-v1',
    statedOn: '2026-02-01',
    noGrantReason: null,
    revokedAt: null,
    revokedReason: null,
    currentTermsVersion: 'contributor-terms-v1',
    coversCurrentTerms: true,
  },
  speakers: [],
  contributions: [{ axis: 'entry', active: 3, superseded: 1, excluded: 0, applied: 0 }],
  exampleCount: 2,
  utteranceCount: 0,
  imageCount: 0,
  wordsTouched: 1,
  decisionsMade: 0,
  assignedWordCount: 2,
  recentContributions: [],
};

/** Routes by URL: the user and their assignments are two endpoints. */
function respond(url: string, over: Partial<UserDossier> = {}) {
  if (url.startsWith('/api/users/')) return { ok: true, json: async () => ({ ...USER, ...over }) };
  return { ok: true, json: async () => userAssignmentsFixture };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('AdminUserDetail', () => {
  it('renders assigned words with both AxisStatusBadges and AxisReviewBadges', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(respond(url))));

    render(<AdminUserDetail userId="u1" onBack={() => {}} onSelectWord={() => {}} onOpenContribution={() => {}} onUsersChanged={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('epo')).toBeInTheDocument();
    });
    expect(screen.getByText('entry: not yet decided')).toBeInTheDocument();
    expect(screen.getByText('audio: not yet recorded')).toBeInTheDocument();
    expect(screen.getByText('entry: in review')).toBeInTheDocument();
    expect(screen.getByText('etymology: not started')).toBeInTheDocument();
  });

  it("assigning via the paste-textarea calls assignWords with the parsed word_id list and shows created/alreadyAssigned counts", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ created: ['wordA', 'wordB'], alreadyAssigned: ['wordC'] }) });
      }
      return Promise.resolve(respond(_url));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<AdminUserDetail userId="u1" onBack={() => {}} onSelectWord={() => {}} onOpenContribution={() => {}} onUsersChanged={() => {}} />);
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

  it('posts a scope instead of a word list when assigning all incomplete words, after a confirm step', async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ created: ['wordA'], alreadyAssigned: [] }) });
      }
      return Promise.resolve(respond(_url));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<AdminUserDetail userId="u1" onBack={() => {}} onSelectWord={() => {}} onOpenContribution={() => {}} onUsersChanged={() => {}} />);
    await waitFor(() => screen.getByText('epo'));

    await user.click(screen.getByRole('button', { name: 'Assign all incomplete words' }));
    // Arming alone must not post - the confirm click is what submits.
    expect(fetchMock.mock.calls.some((call) => (call[1] as RequestInit | undefined)?.method === 'POST')).toBe(false);

    await user.click(screen.getByRole('button', { name: /Yes, assign all incomplete words/ }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Assigned 1 word(s).');
    });
    const postCall = fetchMock.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === 'POST');
    expect(JSON.parse((postCall?.[1] as RequestInit).body as string)).toEqual({ userId: 'u1', scope: 'incomplete' });
  });

  it('posts scope "all" for the assign-all-words shortcut', async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ created: ['wordA'], alreadyAssigned: ['wordB'] }) });
      }
      return Promise.resolve(respond(_url));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<AdminUserDetail userId="u1" onBack={() => {}} onSelectWord={() => {}} onOpenContribution={() => {}} onUsersChanged={() => {}} />);
    await waitFor(() => screen.getByText('epo'));

    await user.click(screen.getByRole('button', { name: 'Assign all words' }));
    await user.click(screen.getByRole('button', { name: /Yes, assign all words/ }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Assigned 1 word(s). (1 were already assigned.)');
    });
    const postCall = fetchMock.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === 'POST');
    expect(JSON.parse((postCall?.[1] as RequestInit).body as string)).toEqual({ userId: 'u1', scope: 'all' });
  });

  it('browsing recently added words assigns the picked ones as explicit wordIds, not a scope', async () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ created: ['recentA', 'recentB'], alreadyAssigned: [] }) });
      }
      if (String(url).startsWith('/api/recent-words')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            words: [
              { wordId: 'recentA', displayText: 'recentA', definition: null, entryType: null, createdAt: oneHourAgo, alreadyAssigned: false },
              { wordId: 'recentB', displayText: 'recentB', definition: null, entryType: null, createdAt: oneHourAgo, alreadyAssigned: false },
            ],
          }),
        });
      }
      return Promise.resolve(respond(url));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<AdminUserDetail userId="u1" onBack={() => {}} onSelectWord={() => {}} onOpenContribution={() => {}} onUsersChanged={() => {}} />);
    await waitFor(() => screen.getByText('epo'));

    await user.click(screen.getByRole('button', { name: 'Browse recently added words' }));
    await waitFor(() => screen.getByRole('button', { name: /Add 2 selected/ }));
    await user.click(screen.getByRole('button', { name: /Add 2 selected/ }));

    // The picks land in the same pending list the search box and paste box
    // feed, so there is still one Assign button submitting one request.
    await user.click(screen.getByRole('button', { name: /Assign 2 word\(s\)/ }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Assigned 2 word(s).');
    });
    const postCall = fetchMock.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === 'POST');
    expect(postCall?.[0]).toBe('/api/assignments');
    expect(JSON.parse((postCall?.[1] as RequestInit).body as string)).toEqual({
      userId: 'u1',
      wordIds: ['recentA', 'recentB'],
    });
  });

  it('clicking Unassign calls the delete endpoint and reloads the list', async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ userId: 'u1', wordId: 'fixturegenadmin_word1', status: 'unassigned' }),
        });
      }
      return Promise.resolve(respond(_url));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<AdminUserDetail userId="u1" onBack={() => {}} onSelectWord={() => {}} onOpenContribution={() => {}} onUsersChanged={() => {}} />);
    await waitFor(() => screen.getByText('epo'));

    await user.click(screen.getByRole('button', { name: 'Unassign' }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Unassigned fixturegenadmin_word1.');
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/assignments/u1/fixturegenadmin_word1', { method: 'DELETE' });
  });
});

// ---------------------------------------------------------------------------
// Who the page is about
// ---------------------------------------------------------------------------
//
// This screen showed the assigned words and nothing else - no email, no name, no role, no
// created date. A curator clicking a name in the Users list arrived somewhere that had
// forgotten the name, and the list they came from showed strictly more.

describe('AdminUserDetail identity', () => {
  function mount(over: Partial<UserDossier> = {}) {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') return Promise.resolve({ ok: true, json: async () => ({ ...USER, ...over }) });
      return Promise.resolve(respond(url, over));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<AdminUserDetail userId="u1" onSelectWord={() => {}} onOpenContribution={() => {}} />);
    return fetchMock;
  }

  it('shows the email address', async () => {
    mount();
    await waitFor(() => expect(screen.getByText('ada@example.com')).toBeInTheDocument());
  });

  it('shows the email even when a display name is the heading', async () => {
    // Making it conditional on having no display name would hide it from exactly the
    // accounts that are easiest to confuse with each other.
    mount();
    const identity = await waitFor(() => screen.getByLabelText('User identity'));
    expect(identity).toHaveTextContent('Ada Lovelace');
    expect(identity).toHaveTextContent('ada@example.com');
  });

  it('falls back to the email as the heading when there is no display name', async () => {
    mount({ displayName: null });
    const identity = await waitFor(() => screen.getByLabelText('User identity'));
    expect(within(identity).getByRole('heading', { level: 2 })).toHaveTextContent('ada@example.com');
  });

  it('shows the role and when the account was created', async () => {
    mount({ role: 'curator' });
    const identity = await waitFor(() => screen.getByLabelText('User identity'));
    expect(identity).toHaveTextContent('curator');
    expect(identity).toHaveTextContent('2026-01-15');
  });

  it('shows the release state, which governs whether their work can be published', async () => {
    mount();
    const rights = await waitFor(() => screen.getByLabelText('Rights'));
    expect(rights).toHaveTextContent('agreed');
    expect(rights).toHaveTextContent('contributor-terms-v1');
  });

  it('says an agreement to older wording does not cover the terms in force', async () => {
    mount({
      rights: { ...USER.rights, agreedVersion: 'contributor-terms-v0', coversCurrentTerms: false },
    });
    const rights = await waitFor(() => screen.getByLabelText('Rights'));
    expect(rights).toHaveTextContent('they need asking again');
  });

  it('separates superseded work from active, rather than showing one total', async () => {
    mount();
    const activity = await waitFor(() => screen.getByLabelText('Activity'));
    expect(activity).toHaveTextContent('3');
    expect(activity).toHaveTextContent('1 superseded');
  });

  it('opens what the person contributed, not the form asking the curator for their own view', async () => {
    // The defect this replaced: every activity row linked into WordReview, which shows
    // nobody's contribution - least of all the one whose row was clicked.
    const onOpenContribution = vi.fn();
    const onSelectWord = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve(
          respond(url, {
            recentContributions: [
              {
                contributionId: 'c1',
                wordId: 'owo_hand',
                displayText: 'ọwọ́',
                axis: 'entry',
                status: 'active',
                submittedAt: '2026-08-01T10:00:00.000Z',
              },
            ],
          }),
        ),
      ),
    );
    render(<AdminUserDetail userId="u1" onSelectWord={onSelectWord} onOpenContribution={onOpenContribution} />);
    const user = userEvent.setup();

    const recent = await waitFor(() => screen.getByLabelText('Recent contributions'));
    await user.click(within(recent).getByRole('button', { name: 'ọwọ́' }));
    expect(onOpenContribution).toHaveBeenCalledWith('c1');
    expect(onSelectWord).not.toHaveBeenCalled();
  });

  it('makes a new-word proposal clickable, which it never was', async () => {
    // 'new_entry' has a null word_id by construction, so a word-keyed link had nothing to
    // point at and the row was rendered as dead text - hiding exactly the work of someone
    // whose main activity is proposing new words.
    const onOpenContribution = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve(
          respond(url, {
            recentContributions: [
              {
                contributionId: 'c9',
                wordId: null,
                displayText: null,
                axis: 'new_entry',
                status: 'active',
                submittedAt: '2026-08-01T10:00:00.000Z',
              },
            ],
          }),
        ),
      ),
    );
    render(<AdminUserDetail userId="u1" onSelectWord={() => {}} onOpenContribution={onOpenContribution} />);
    const user = userEvent.setup();

    const recent = await waitFor(() => screen.getByLabelText('Recent contributions'));
    await user.click(within(recent).getByRole('button', { name: 'a new word' }));
    expect(onOpenContribution).toHaveBeenCalledWith('c9');
  });

  it('still renders the assignments when the user payload is the wrong shape', async () => {
    // A deploy where the API is older than the app must not blank the page: the dossier is
    // supplementary to the assignment manager that was here first.
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: async () => userAssignmentsFixture })));
    render(<AdminUserDetail userId="u1" onSelectWord={() => {}} onOpenContribution={() => {}} />);
    await waitFor(() => expect(screen.getByText('epo')).toBeInTheDocument());
  });

  it('patches only the field that changed', async () => {
    const fetchMock = mount();
    const user = userEvent.setup();
    await waitFor(() => screen.getByText('ada@example.com'));

    await user.click(screen.getByRole('button', { name: 'Edit this account' }));
    const field = screen.getByLabelText('Email address');
    await user.clear(field);
    await user.type(field, 'ada.lovelace@example.com');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');
      expect(patch).toBeDefined();
      // displayName is absent, not null - an untouched field means "leave it alone", and
      // sending null would clear a name the curator never touched.
      expect(JSON.parse((patch![1] as RequestInit).body as string)).toEqual({ email: 'ada.lovelace@example.com' });
    });
  });

  it('surfaces the refusal when a curator tries to change their own email', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (init?.method === 'PATCH') {
          return Promise.resolve({
            ok: false,
            status: 409,
            json: async () => ({ error: 'cannot change your own email address - you would be locked out' }),
          });
        }
        return Promise.resolve(respond(url));
      }),
    );
    const user = userEvent.setup();
    render(<AdminUserDetail userId="u1" onSelectWord={() => {}} onOpenContribution={() => {}} />);
    await waitFor(() => screen.getByText('ada@example.com'));

    await user.click(screen.getByRole('button', { name: 'Edit this account' }));
    const field = screen.getByLabelText('Email address');
    await user.clear(field);
    await user.type(field, 'someone.else@example.com');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('locked out'));
  });
});
