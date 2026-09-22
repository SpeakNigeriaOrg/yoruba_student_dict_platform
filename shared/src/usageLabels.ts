// usageLabels.ts
//
// The sense labels a reviewer may attach to an entry (golden_record.usage_labels, 0029), and how
// they are written on Wiktionary.
//
// A closed list, and deliberately a short one: every value here is a label Wiktionary itself
// defines in Module:labels/data (checked 2026-09-22), so each renders with its glossary link and
// sorts the entry into the matching category. `{{lb}}` will display ANY text it is handed -
// `{{lb|yo|in compounds}}` shows "(in compounds)" - but an undefined label is uncategorised free
// text, which is to say not a label. That is exactly the mistake a free-text box invites, and
// nothing downstream would notice until a Wiktionary editor did.
//
// "Survives only inside other words" is NOT here, for that reason: no label means it. It is its
// own flag (only_in_derived_terms), written upstream as a usage note - see partsOfSpeech.ts.

export interface UsageLabel {
  /** The stored value, which is also the exact `{{lb}}` argument. */
  value: string;
  /** How it reads to a reviewer - Wiktionary's own glossary sense, briefly. */
  description: string;
}

/** In the order they are written - the canonical order renderLabelTemplate emits, so the same
 * set of labels always produces the same wikitext. */
export const USAGE_LABELS: UsageLabel[] = [
  { value: 'obsolete', description: 'no longer in use' },
  { value: 'archaic', description: 'no longer in ordinary use, but still met in older styles (proverbs, oríkì, old texts)' },
  { value: 'dated', description: 'still understood, but sounds old-fashioned' },
  { value: 'historical', description: 'refers to something that no longer exists' },
  { value: 'rare', description: 'seldom used' },
];

export function isKnownUsageLabel(value: string): boolean {
  return USAGE_LABELS.some((l) => l.value === value);
}

/** De-duplicated, in canonical order. Unknown values are dropped - callers validate first, and
 * this is what makes two reviewers who ticked the same boxes in a different order agree. */
export function canonicalUsageLabels(values: readonly string[]): string[] {
  const set = new Set(values);
  return USAGE_LABELS.map((l) => l.value).filter((v) => set.has(v));
}

/** `{{lb|yo|obsolete|rare}}`, or '' when there is nothing to say. */
export function renderLabelTemplate(values: readonly string[]): string {
  const labels = canonicalUsageLabels(values);
  return labels.length === 0 ? '' : `{{lb|yo|${labels.join('|')}}}`;
}
