// synthesizeComponentReciprocals.ts
//
// Ports generate_kaikki_lexicon.py's synthesize_component_relationships
// (itself a port of yorubadict's build/lib/relationships.mjs approach): a
// compound's own etymology templates only ever give the forward direction
// (compound -> its parts). The reverse - a root's derived-terms list
// naming a compound with no clean etymology template of its own, or none
// at all - is exactly the asymmetric Wiktionary-editor gap this exists to
// fix. Mutates each sense's componentCandidates in place (tagging
// reciprocal entries with their own provenance), so a human reviewing a
// proposal later can tell "Kaikki's own etymology for this word says so"
// apart from "inferred because some other word's derived-terms list names
// this one".
//
// WHICH PARENT, exactly. A derived-terms item is only a spelling (`{type:'term', text:'àtẹ́lẹwọ́'}`),
// so the CHILD end of the link is matched by spelling and can be ambiguous - every etymology spelled
// that way receives it. The PARENT end is not: it is the very entry whose list this is, so its
// entry_id is recorded on the candidate (entryIds), and two parent etymologies sharing a spelling
// that both list the word are merged into one candidate naming both. The review screen shows this
// as a clue from the parent's page, never as the word's own etymology.

import type { DerivedKaikkiSense } from './types.js';

export function synthesizeComponentReciprocals(senses: DerivedKaikkiSense[]): void {
  // spelling -> every sense findable under that exact spelling (its
  // canonical form or any of its standard forms) - independent of the
  // orthography-insensitive index keys used for lookup elsewhere.
  const aliasIndex = new Map<string, DerivedKaikkiSense[]>();
  const addAlias = (key: string, sense: DerivedKaikkiSense): void => {
    const existing = aliasIndex.get(key);
    if (existing) existing.push(sense);
    else aliasIndex.set(key, [sense]);
  };

  for (const sense of senses) {
    addAlias(sense.canonicalForm.value, sense);
    for (const form of sense.standardForms) {
      addAlias(form, sense);
    }
  }

  for (const sense of senses) {
    for (const derivedSpelling of sense.derivedFormTexts) {
      const targets = aliasIndex.get(derivedSpelling) ?? [];
      for (const target of targets) {
        const form = sense.canonicalForm.value;
        // The word's own etymology already names this part: the clue adds nothing.
        if (target.componentCandidates.some((c) => c.form === form && c.provenance !== 'derived_reciprocal')) continue;
        const existing = target.componentCandidates.find((c) => c.form === form && c.provenance === 'derived_reciprocal');
        if (!existing) {
          target.componentCandidates.push({ form, provenance: 'derived_reciprocal', entryIds: [sense.entryId] });
        } else if (!(existing.entryIds ?? []).includes(sense.entryId)) {
          existing.entryIds = [...(existing.entryIds ?? []), sense.entryId];
        }
      }
    }
  }
}
