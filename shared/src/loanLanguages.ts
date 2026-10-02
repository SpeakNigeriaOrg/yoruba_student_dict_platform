// loanLanguages.ts
//
// The languages a Yoruba loanword can be marked as borrowed FROM (golden_record.borrowed_from,
// 0032). Each value is the Wiktionary language code its {{bor|yo|<code>|<word>}} template takes,
// so a draft can say "Borrowed from English radio" in Wiktionary's own markup.
//
// Ordered by how many Yoruba Wiktionary entries are borrowed from each (counted 2026-10-02 over
// the 533 entries carrying a bor/bor+ template: English 346, Hausa 104, Arabic 20, Edo 16,
// Baatonum 16, Nupe 9, Portuguese 5, ...). French is included for loanwords in Yoruba spoken in
// Benin, where it is the contact language. `und` is Wiktionary's "undetermined" code, for a word
// known to be borrowed from a language nobody has identified.

export interface LoanLanguage {
  code: string;
  name: string;
}

export const LOAN_LANGUAGES: LoanLanguage[] = [
  { code: 'en', name: 'English' },
  { code: 'ha', name: 'Hausa' },
  { code: 'ar', name: 'Arabic' },
  { code: 'bin', name: 'Edo' },
  { code: 'bba', name: 'Baatonum' },
  { code: 'nup', name: 'Nupe' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'fr', name: 'French' },
  { code: 'fon', name: 'Fon' },
  { code: 'ig', name: 'Igbo' },
  { code: 'ff', name: 'Fula' },
  { code: 'son', name: 'Songhay' },
  { code: 'und', name: 'another language (not identified)' },
];

export function isKnownLoanLanguage(code: string): boolean {
  return LOAN_LANGUAGES.some((l) => l.code === code);
}

export function loanLanguageName(code: string): string {
  return LOAN_LANGUAGES.find((l) => l.code === code)?.name ?? code;
}

/** A Wiktionary source-language code reduced to the list's: regional variants (`en-GB`) count as
 * the language, anything else unlisted is kept as given. */
export function normalizeLoanLanguage(code: string): string {
  const base = code.split('-')[0];
  return isKnownLoanLanguage(code) ? code : isKnownLoanLanguage(base) ? base : code;
}
