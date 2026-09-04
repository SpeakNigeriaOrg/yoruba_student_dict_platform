// App.tsx
//
// Mobile-native shell: identity check -> login link or task queue -> the
// selected word's axis review. Bottom tab bar for primary navigation, a
// segmented control for the axis switcher (Entry / Etymology / Audio).
//
// Navigation is hash-routed (route.ts / useRoute.ts) rather than held in
// local state. That was a real defect, not a preference: with no history
// entries, Android's back gesture and iOS Safari's swipe-back left the app
// entirely, a refresh dropped you to the start, and AdminUsers kept its own
// private selection state so Users -> user -> word -> Back landed on the user
// LIST instead of the user. One route, one stack.

import { AddWord } from './screens/AddWord.js';
import { AdminUserDetail } from './screens/AdminUserDetail.js';
import { AdminUsers } from './screens/AdminUsers.js';
import { ContributorTerms } from './screens/ContributorTerms.js';
import { Dictionary } from './screens/Dictionary.js';
import { TaskQueue } from './screens/TaskQueue.js';
import { UserContribution } from './screens/UserContribution.js';
import { WordDossier } from './screens/WordDossier.js';
import { WordReview } from './screens/WordReview.js';
import { getMyGrant } from './api.js';
import { getClientPrincipal, type ClientPrincipal } from './identity.js';
import { useRoute } from './useRoute.js';
import type { Axis, Route } from './route.js';
import { useEffect, useState } from 'react';

type MainView = Route['view'];
// Four, not five. Browse and Review were two tabs asking two questions about one corpus,
// and both are now views inside Dictionary - which is also what lets a count on the
// overview open the words behind it.
//
// The order is the order of the day's work: what am I being asked to do, what is the state
// of the whole thing, add something new, who is doing it.
const MAIN_VIEWS: Array<{ view: MainView; label: string; icon: string }> = [
  { view: 'queue', label: 'Tasks', icon: '📋' },
  { view: 'dictionary', label: 'Dictionary', icon: '📖' },
  { view: 'add', label: 'Add', icon: '➕' },
  { view: 'users', label: 'Users', icon: '👥' },
];

export default function App() {
  const [principal, setPrincipal] = useState<ClientPrincipal | null | undefined>(undefined);
  /** Whether this account still has to answer the contributor agreement (0019).
   *
   * Undefined while unknown, which includes "the call failed". Interrupting on an
   * unanswered question is right; interrupting because a fetch timed out is not, so a
   * failure resolves to false and the app opens normally. That is a deliberate fail-OPEN
   * on a consent prompt, and it is safe because this screen is not the enforcement: the
   * enforcement is at release time, where the export refuses anything a grant does not
   * cover. Locking a teacher out of a day's work to protect a rights check that runs
   * weeks later would cost something real to protect nothing.
   */
  const [needsTerms, setNeedsTerms] = useState<boolean | undefined>(undefined);
  /** True once an account has declined or withdrawn. Every write endpoint refuses one, so
   * the agreement goes back in front of them - showing the queue would be showing work they
   * cannot save, and finding that out at the end of a recording is the worst moment to. */
  const [paused, setPaused] = useState(false);
  const { route, navigate } = useRoute();

  useEffect(() => {
    getClientPrincipal().then(setPrincipal);
  }, []);

  useEffect(() => {
    if (!principal) return;
    getMyGrant()
      // `=== true`/`=== false` rather than the values themselves, because undefined is this
      // state's "still asking" sentinel: a response missing the field would otherwise leave
      // the app on its loading line forever, which is a worse failure than not showing the
      // prompt. Same reason `paused` needs an explicit false and not just a falsy value.
      .then((grant) => {
        setNeedsTerms(grant.needsAcceptance === true);
        setPaused(grant.canContribute === false);
      })
      .catch(() => setNeedsTerms(false));
  }, [principal?.userId]);

  const isCurator = principal?.userRoles.includes('curator') ?? false;

  function openWord(wordId: string, axis: Axis) {
    navigate({ view: 'word', wordId, axis });
  }

  // Which bottom-nav tab reads as current, including for the routes nested under one: a
  // user's detail page and one of their contributions both belong to Users, and a word's
  // dossier belongs to Dictionary, which is where it is reached from.
  const activeView: MainView =
    route.view === 'user' || route.view === 'contribution'
      ? 'users'
      : route.view === 'dossier'
        ? 'dictionary'
        : route.view;

  return (
    <main>
      <div className="topbar">
        <h1>Yoruba Student Dictionary</h1>
        {principal ? (
          <p className="identity-line">
            {principal.userDetails} <a href="/logout">Log out</a>
          </p>
        ) : null}
      </div>

      {principal === undefined ? (
        <p>Checking login status...</p>
      ) : principal === null ? (
        <p>
          <a href="/login">Log in</a> to see your assigned words.
        </p>
      ) : needsTerms === undefined ? (
        <p>Checking login status...</p>
      ) : needsTerms || paused ? (
        // Before the routed views, and instead of them. Shown once per wording version for
        // an account that has not answered - and shown again, indefinitely, for one that
        // declined, because every write endpoint now refuses it and there is no honest way
        // to present a queue of work that cannot be saved.
        <ContributorTerms
          paused={paused}
          onAnswered={(grant) => {
            setNeedsTerms(false);
            setPaused(grant.canContribute === false);
          }}
        />
      ) : (
        <>
          {route.view === 'word' ? (
            <>
              <button type="button" className="back-btn" onClick={() => window.history.back()}>
                ← Back
              </button>
              <WordReview
                wordId={route.wordId}
                axis={route.axis}
                isCurator={isCurator}
                onAxisChange={(axis) => navigate({ view: 'word', wordId: route.wordId, axis }, { replace: true })}
                // Deciding an axis moves on to this word's next unfinished one, the same
                // as inside the queue. Without it, confirming here left you on the axis
                // you had just finished with no acknowledgement that there was more to do.
                advanceAfterDecision
                // Renaming and deleting the entry, offered only here. Both end with the
                // route pointing at a word_id that no longer exists, so both must navigate:
                // a rename REPLACES this history entry (going Back to the old id would 404
                // on a word that was never really a different word), while a deletion pushes
                // the word survey, because there is nothing left to be on.
                entryAdmin={{
                  onRenamed: (newWordId) => navigate({ view: 'word', wordId: newWordId, axis: route.axis }, { replace: true }),
                  onDeleted: () => navigate({ view: 'dictionary', tab: 'words' }),
                }}
              />
            </>
          ) : route.view === 'dossier' && isCurator ? (
            <>
              <button type="button" className="back-btn" onClick={() => window.history.back()}>
                ← Back
              </button>
              <WordDossier
                wordId={route.wordId}
                onOpenWord={(wordId) => openWord(wordId, 'entry')}
                onOpenDossier={(wordId) => navigate({ view: 'dossier', wordId })}
              />
            </>
          ) : /* Gated like its four siblings. It was the one route that was not, so a
                volunteer reaching #/users/{id} rendered the whole admin screen - a live
                assign-all-words control above a list that 403s. */
          route.view === 'user' && isCurator ? (
            <>
              <button type="button" className="back-btn" onClick={() => window.history.back()}>
                ← Back
              </button>
              <AdminUserDetail
                userId={route.userId}
                onSelectWord={(wordId) => openWord(wordId, 'entry')}
                onOpenContribution={(contributionId) =>
                  navigate({ view: 'contribution', userId: route.userId, contributionId })
                }
              />
            </>
          ) : /* Gated with its siblings: it carries other people's unpublished recordings
                and examples in full. */
          route.view === 'contribution' && isCurator ? (
            <>
              <button type="button" className="back-btn" onClick={() => window.history.back()}>
                ← Back
              </button>
              <UserContribution
                userId={route.userId}
                contributionId={route.contributionId}
                onOpenUser={(userId) => navigate({ view: 'user', userId })}
                onOpenDossier={(wordId) => navigate({ view: 'dossier', wordId })}
                onOpenWord={(wordId) => openWord(wordId, 'entry')}
              />
            </>
          ) : route.view === 'dictionary' && isCurator ? (
            <Dictionary
              tab={route.tab}
              onTabChange={(tab) => navigate({ view: 'dictionary', tab }, { replace: true })}
              onOpenWord={openWord}
              onOpenDossier={(wordId) => navigate({ view: 'dossier', wordId })}
            />
          ) : route.view === 'add' && isCurator ? (
            <AddWord onOpenWord={(wordId) => openWord(wordId, 'entry')} />
          ) : route.view === 'users' && isCurator ? (
            <AdminUsers onSelectUser={(userId) => navigate({ view: 'user', userId })} />
          ) : (
            <TaskQueue isCurator={isCurator} onOpenWord={openWord} />
          )}

          {/* Kept visible on review screens too. It used to be hidden
              whenever a word was open, which removed the only escape from
              the longest screens in the app while still reserving its
              height in main's padding. */}
          {isCurator ? (
            <nav aria-label="Main navigation" className="bottom-nav">
              {MAIN_VIEWS.map((view) => (
                <button
                  key={view.view}
                  type="button"
                  aria-current={activeView === view.view ? 'page' : undefined}
                  onClick={() => navigate(view.view === 'dictionary' ? { view: 'dictionary', tab: 'overview' } : ({ view: view.view } as Route))}
                >
                  <span className="nav-icon" aria-hidden="true">
                    {view.icon}
                  </span>
                  {view.label}
                </button>
              ))}
            </nav>
          ) : null}
        </>
      )}
    </main>
  );
}
