// LoanwordFields.tsx
//
// "Is this a loanword, and from what?" (0032) - on Add Word and on the etymology review. A
// language, not just a yes: Wiktionary marks a loanword as {{bor|yo|en|radio}}, and "borrowed"
// without the source says nothing a learner or a draft can use. The original word is optional.
//
// Starts from Wiktionary's own answer when the cited entry carries one, said in one line, so for
// the hundreds of loanwords Wiktionary already knows a reviewer confirms rather than re-enters.

import { LOAN_LANGUAGES, loanLanguageName } from '@yoruba-student-dict-platform/shared';

export interface LoanDraft {
  /** Wiktionary language code, or null when not a loanword. */
  from: string | null;
  term: string;
}

export const NOT_A_LOANWORD: LoanDraft = { from: null, term: '' };

export function loanDraftFrom(b: { from: string; term: string | null } | null | undefined): LoanDraft {
  return b ? { from: b.from, term: b.term ?? '' } : NOT_A_LOANWORD;
}

export function sameLoan(a: LoanDraft, b: { from: string; term: string | null } | null | undefined): boolean {
  return (a.from ?? null) === (b?.from ?? null) && (a.from ? a.term.trim() : '') === (b?.from ? (b.term ?? '').trim() : '');
}

/** "borrowed from English (radio)" - for claim rows and the record. */
export function describeLoan(from: string | null | undefined, term: string | null | undefined): string | null {
  return from ? `borrowed from ${loanLanguageName(from)}${term ? ` (${term})` : ''}` : null;
}

export function LoanwordFields({
  idPrefix,
  value,
  onChange,
  wiktionary,
}: {
  idPrefix: string;
  value: LoanDraft;
  onChange: (next: LoanDraft) => void;
  /** What the cited Wiktionary entry says, when it says the word is borrowed. */
  wiktionary?: { from: string; term: string | null } | null;
}) {
  const known = value.from === null || LOAN_LANGUAGES.some((l) => l.code === value.from);
  return (
    <div className="usage-fieldset" aria-label="Loanword">
      <label className="field-inline">
        <input
          type="checkbox"
          checked={value.from !== null}
          onChange={(e) =>
            onChange(e.target.checked ? { from: wiktionary?.from ?? 'en', term: wiktionary?.term ?? value.term } : NOT_A_LOANWORD)
          }
        />
        <span>Loanword - borrowed from another language</span>
      </label>
      {wiktionary ? (
        <p className="field-note" aria-label="Wiktionary says">
          Wiktionary says: {describeLoan(wiktionary.from, wiktionary.term)}.
        </p>
      ) : null}
      {value.from !== null ? (
        <>
          <div className="field">
            <label htmlFor={`${idPrefix}-loan-language`}>Borrowed from</label>
            <select id={`${idPrefix}-loan-language`} value={value.from} onChange={(e) => onChange({ ...value, from: e.target.value })}>
              {/* A code Wiktionary uses that is not on our list keeps its own option rather than
                  being swapped for something else - same rule as PartOfSpeechField. */}
              {known ? null : <option value={value.from}>{value.from}</option>}
              {LOAN_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${idPrefix}-loan-term`}>Original word (optional)</label>
            <input
              id={`${idPrefix}-loan-term`}
              type="text"
              value={value.term}
              onChange={(e) => onChange({ ...value, term: e.target.value })}
              placeholder="e.g. radio"
            />
          </div>
        </>
      ) : null}
    </div>
  );
}
