// textFingerprint.ts
//
// The primitives every content fingerprint in this project is built from -
// consensus.ts's fingerprintOutcome (do two contributors assert the same
// thing?) and upstreamPin.ts's pinContentFingerprint (did Wiktionary change
// under a citation?).
//
// Extracted rather than duplicated because each convention below encodes a bug
// that was actually hit once. A second private copy of NULL_MARKER is exactly
// how one of them comes back.

// Separators that cannot occur in Yoruba text or an English gloss, so field
// boundaries in a fingerprint are unambiguous - joining with a printable
// character would let "a|b" + "c" collide with "a" + "b|c".
//
// Built with fromCharCode rather than as a unicode escape or a literal byte.
// Both alternatives have failed in this repo: literal control bytes get eaten
// silently by an editor or a write tool, and the escape form was itself
// rewritten into literal bytes by tooling while looking correct on screen. This
// form has no non-printable byte and no escape sequence to mangle, so what you
// read is what compiles.
export const FIELD_SEP = String.fromCharCode(0x1f); // US, unit separator
export const LIST_SEP = String.fromCharCode(0x1e); // RS, record separator

/** Distinct from the empty string, so "absent" never collides with "present
 * but normalized to empty".
 *
 * GS (0x1d), NOT NUL. It was 0x00 first, which Postgres rejects outright -
 * `text` forbids NUL - so every entry with no definition produced a fingerprint
 * that could not be stored. Any control character except NUL is storable and
 * unreachable from a text input. */
export const NULL_MARKER = String.fromCharCode(0x1d); // GS, group separator

/** Unicode NFC + whitespace normalization, applied to every field.
 *
 * NFC matters here specifically: Yoruba text carries combining tone marks and
 * underdots, so the same visible form can arrive as precomposed or decomposed
 * codepoints depending on the contributor's keyboard or OS. Without NFC two
 * people who typed the identical word would fingerprint differently. */
export function normalizeText(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/g, ' ');
}

/** English gloss / definition text only.
 *
 * Case is folded because these are English and "Giraffe" is not a different
 * claim from "giraffe".
 *
 * Case is NOT folded on Yoruba text. Yoruba orthography is case-bearing in a
 * way that matters - `Agẹmọ` is a month name, and folding would merge proper
 * nouns with common ones. Diacritics and underdots are never folded anywhere:
 * they ARE the semantic content, which is the whole premise of the entry
 * axis. */
export function normalizeGloss(value: string): string {
  return normalizeText(value).toLowerCase();
}
