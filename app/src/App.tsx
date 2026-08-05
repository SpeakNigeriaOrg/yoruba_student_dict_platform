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
import { AllWordsList } from './screens/AllWordsList.js';
import { ReviewQueue } from './screens/ReviewQueue.js';
import { TaskQueue } from './screens/TaskQueue.js';
import { WordReview } from './screens/WordReview.js';
import { getClientPrincipal, type ClientPrincipal } from './identity.js';
import { useRoute } from './useRoute.js';
import type { Axis, Route } from './route.js';
import { useEffect, useState } from 'react';

type MainView = Route['view'];
const MAIN_VIEWS: Array<{ view: MainView; label: string; icon: string }> = [
  { view: 'queue', label: 'Tasks', icon: '📋' },
  { view: 'browse', label: 'Browse', icon: '🔍' },
  { view: 'add', label: 'Add', icon: '➕' },
  { view: 'contributions', label: 'Review', icon: '✅' },
  { view: 'users', label: 'Users', icon: '👥' },
];

export default function App() {
  const [principal, setPrincipal] = useState<ClientPrincipal | null | undefined>(undefined);
  const { route, navigate } = useRoute();

  useEffect(() => {
    getClientPrincipal().then(setPrincipal);
  }, []);

  const isCurator = principal?.userRoles.includes('curator') ?? false;

  function openWord(wordId: string, axis: Axis) {
    navigate({ view: 'word', wordId, axis });
  }

  // Which bottom-nav tab reads as current, including for the nested user
  // detail route.
  const activeView: MainView = route.view === 'user' ? 'users' : route.view;

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
              />
            </>
          ) : route.view === 'user' ? (
            <>
              <button type="button" className="back-btn" onClick={() => window.history.back()}>
                ← Back
              </button>
              <AdminUserDetail userId={route.userId} onSelectWord={(wordId) => openWord(wordId, 'entry')} />
            </>
          ) : route.view === 'browse' && isCurator ? (
            <AllWordsList onSelect={(wordId) => openWord(wordId, 'entry')} />
          ) : route.view === 'add' && isCurator ? (
            <AddWord />
          ) : route.view === 'contributions' && isCurator ? (
            <ReviewQueue onOpenWord={openWord} />
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
                  onClick={() => navigate({ view: view.view } as Route)}
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
