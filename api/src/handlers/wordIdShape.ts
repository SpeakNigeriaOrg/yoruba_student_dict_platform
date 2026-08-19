// handlers/wordIdShape.ts
//
// A word_id must be safe to put in a filename, a URL and a storage key, because it already is.
//
// ---------------------------------------------------------------------------
// The guarantee this makes real
// ---------------------------------------------------------------------------
// Two different names come out of one entry, and they must never be confused:
//
//   the SPELLING       `ọwọ́`, `o ṣé`, `aárùn-ún`. Underdots, tone marks, hyphens, spaces.
//                      Human-facing. Wiktionary's Yoruba policy REQUIRES ẹ, ọ and ṣ in a page
//                      title, so this is where the special characters belong.
//   the WORD_ID        `owo_hand`, `o_se_thank_you`. Machine-facing: the key everything
//                      external is built from - R2 object keys (words/{speaker}/{word_id}.wav),
//                      game asset paths, Commons upload filenames.
//
// AddWord derives the id from orthographyInsensitiveForm, which strips tone marks AND underdots,
// then slugs the meaning hint - so an id has always been plain ASCII, and production bears that
// out: 106 of 106 match this pattern. But it was a convention, not a rule. Both creation
// handlers took whatever `wordId` string arrived on the wire, so `ọwọ́_hand` was accepted, and
// every downstream name built from it would then carry combining diacritics into somebody
// else's filesystem, bucket or upload API - the class of failure that shows up as a broken link
// months later rather than as an error here.
//
// Lowercase because orthographyInsensitiveForm lowercases; underscore because that is the
// existing separator between the form and the hint; digits because a discriminated id can end in
// one (see discriminateWordId and hashDiscriminateWordId in shared/src/deriveWordId.ts, which
// append an entry-id token or an eight-hex-digit hash).
//
// ---------------------------------------------------------------------------
// A HYPHEN is part of the id, and refusing it was this file's own bug
// ---------------------------------------------------------------------------
// `rẹ́rìn-ín` derives `rerin-in_to_laugh` and was then refused by the rule above, which is a
// contradiction rather than a policy: orthographyInsensitiveForm strips tone marks and underdots
// and NOTHING ELSE, and deriveWordId replaces only whitespace. So the deriver has always emitted
// hyphens and the validator has always rejected them - the invariant this file exists to state
// (nothing derivable can be refused) was false for every hyphenated entry. 307 corpus forms
// contain a hyphen.
//
// It is also not the hazard the rest of the rule guards against. The danger being kept out is a
// combining diacritic reaching somebody else's filesystem, bucket or upload API; a hyphen is safe
// in a filename, safer than an underscore in a URL, and legal in an R2 key and a Commons title.
//
// And converting it to an underscore instead would lose two things. It would conflate a compound
// with a phrase - `ilé-ìwé` is ONE orthographic word that routes to Add Word, `ilé ìwé` would be
// two that route to Add Phrase, and both would land on `ile_iwe_school`. It would also break
// etymidLabelFromWordId, which reads the meaning half back out by stripping exactly the prefix
// deriveWordId built, hyphen included - so every hyphenated word would stop yielding an
// {{etymid}} label.
//
// A leading hyphen is allowed too, and 2 corpus entries need it: the interfix `-kí-` and the
// suffix `-ọlá` (22 more end in one, the `i-` prefixes). It is the only thing distinguishing a
// bound affix from the free word of the same spelling, so dropping it would collide them. The
// usual objection - a filename beginning with a dash reads as a flag - does not arise here
// because every name built from an id is path-prefixed (words/{speaker}/{word_id}.wav).

/** The only shape a word_id may take. Anchored, so a partial match cannot pass.
 *
 * The single source of this rule: wordIdShape.test.ts asserts the DERIVER against this constant
 * rather than against a regex of its own. That is not a style preference - the test had written
 * its own `/^[a-z0-9_-]+$/`, someone widened it to admit `ilé-ìwé`, and the contradiction with
 * the narrower pattern here passed CI unnoticed until a curator hit it. */
export const WORD_ID_PATTERN = /^[a-z0-9_-]+$/;

export class InvalidWordIdError extends Error {
  constructor(public readonly wordId: string) {
    super(
      `word_id '${wordId}' must be lowercase a-z, 0-9, underscore and hyphen only - it becomes ` +
        `a filename, a URL and a storage key, so the spelling's tone marks and underdots cannot ` +
        `appear in it. The spelling itself is kept in display_text.`,
    );
    this.name = 'InvalidWordIdError';
  }
}

export function assertWordIdShape(wordId: string): void {
  if (!WORD_ID_PATTERN.test(wordId)) throw new InvalidWordIdError(wordId);
}
