// handlers/publicationFields.ts
//
// Parses 0018's three publication overrides off the wire, in one place for both
// creation edges (POST /api/words and POST /api/phrases).
//
// Same reason parseCitationInput lives beside the citation rather than in each
// function file: two independent parsers for one field set are two places for the
// rules to drift, and the rule here is not obvious. An ABSENT field and an
// explicitly null one both mean "no override, read the pin" - but an empty STRING
// does not mean that. It is a field someone opened, cleared, and submitted, and
// storing '' would make english_gloss non-null and therefore authoritative, so the
// generator would publish a blank sense line instead of falling back to the pin's
// glosses. Blank collapses to null.

export interface PublicationFields {
  pos?: string | null;
  englishGloss?: string | null;
  etymidLabel?: string | null;
}

function parseOne(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error(`${name} must be a string if provided`);
  return value.trim() || null;
}

export function parsePublicationFields(body: Record<string, unknown>): PublicationFields {
  return {
    pos: parseOne(body.pos, 'pos'),
    englishGloss: parseOne(body.englishGloss, 'englishGloss'),
    etymidLabel: parseOne(body.etymidLabel, 'etymidLabel'),
  };
}
