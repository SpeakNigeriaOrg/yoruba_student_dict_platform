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

/** The only shape a word_id may take. Anchored, so a partial match cannot pass. */
export const WORD_ID_PATTERN = /^[a-z0-9_]+$/;

export class InvalidWordIdError extends Error {
  constructor(public readonly wordId: string) {
    super(
      `word_id '${wordId}' must be lowercase a-z, 0-9 and underscore only - it becomes a ` +
        `filename, a URL and a storage key, so the spelling's tone marks and underdots cannot ` +
        `appear in it. The spelling itself is kept in display_text.`,
    );
    this.name = 'InvalidWordIdError';
  }
}

export function assertWordIdShape(wordId: string): void {
  if (!WORD_ID_PATTERN.test(wordId)) throw new InvalidWordIdError(wordId);
}
