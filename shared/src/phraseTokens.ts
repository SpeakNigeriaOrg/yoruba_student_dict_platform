// phraseTokens.ts
//
// One definition of "this spelling is more than one word", used by both sides of the Add Word /
// Add Phrase split.
//
// ---------------------------------------------------------------------------
// Why the naive rule is the right rule here
// ---------------------------------------------------------------------------
// Wiktionary has no rule against multi-word entries, so they arrive in the same corpus as single words
// and appeared in the Add WORD search alongside them. Adding one there produces a row that is really a
// phrase - and the word/phrase split exists precisely to make a curator say which words a phrase is
// made of.
//
// Splitting on whitespace sounds fragile, so it was measured against all 6272 corpus etymologies
// before being relied on:
//
//   480 (7.7%) contain internal whitespace
//     0        have leading or trailing whitespace - the "accidental trailing space" case does not
//              occur, so trimming is a formality rather than a defence
//     1        distinct whitespace character in the entire corpus: U+0020. No NBSP, no U+2009, nothing
//              exotic that would need a broader class or a normalisation pass
//
// So `trim().split(/\s+/)` is sufficient rather than merely convenient. `\s+` is still used instead of
// a literal space because a doubled space costs nothing to absorb and would otherwise yield an empty
// token.
//
// ---------------------------------------------------------------------------
// What is deliberately NOT a phrase
// ---------------------------------------------------------------------------
// 143 entries are hyphenated with no whitespace, and they are overwhelmingly bound affixes - `ì-`,
// `-kí-`, `oní-` - which are morphemes rather than words and should not become entries at all, let
// alone phrases. A hyphenated compound like `ilé-ìwé` is a single orthographic word by Yoruba
// convention. Neither is caught, and that is the intent: this function asks "did a human write this as
// separate words", not "is this morphologically complex". The etymology axis answers the second
// question, and answers it far better.

/** The separate words in a spelling, NFC-normalised, in order.
 *
 * NFC because these tokens get compared to dictionary spellings by string equality, and stored text is
 * not consistently normalised - an NFD `ọ` is a different string from an NFC `ọ` even though it is the
 * same letter. That exact mismatch silently broke syllable-audio lookup in the published game, so it
 * is normalised at every boundary now rather than hoped about. */
export function phraseTokens(text: string): string[] {
  return text
    .trim()
    .split(/\s+/)
    .filter((token) => token !== '')
    .map((token) => token.normalize('NFC'));
}

/** Whether this spelling is more than one word, and therefore a phrase.
 *
 * The single source for that judgement: the Add Word search labels results with it, the word form
 * refuses to submit one, and the Phrase tab seeds a component slot per token from it. */
export function isMultiWord(text: string): boolean {
  return phraseTokens(text).length >= 2;
}
