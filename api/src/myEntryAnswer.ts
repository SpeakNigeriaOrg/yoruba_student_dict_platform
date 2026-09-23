// myEntryAnswer.ts
//
// The word as THIS volunteer has said it is: their active answer on the entry axis, whenever it
// differs from the record.
//
// A volunteer who corrects a spelling has told us, confidently, what the word is. An answer is one
// vote and does not reach golden_record until a curator confirms it - but that is the platform's
// bookkeeping, not theirs to navigate. So every screen they then work on for that word (etymology,
// audio, examples, the entry screen itself, their task list) shows the word as they said it, with a
// small marker that it is their change. The marker is there to catch the change someone made
// without meaning to, not to send them back to the record.
//
// It started as the audio screen's alone (d880d84: the recorder offered the spelling a speaker had
// just argued against). Every other screen still showed the record, so a volunteer saw their
// correction apply on one screen of four and vanish on the rest - including the entry screen they
// had just submitted it on.
//
// Read from resolved_value, the outcome frozen at submission (0013): what they asserted, not what
// that assertion would mean against a record that has since moved. Compared NFC-normalised, because
// a difference of Unicode composition alone is not a correction - five production words are stored
// in NFD and would otherwise each carry a marker for a change nobody made.

import type { Queryable } from './db.js';

export interface MyEntryAnswer {
  displayText: string;
  syllables: string[];
  definition: string | null;
  /** Which parts of it differ from the record - what the marker names. */
  spellingChanged: boolean;
  definitionChanged: boolean;
  /** Present when their answer carried them (0029). */
  pos?: string | null;
  usageLabels?: string[];
  onlyInDerivedTerms?: boolean;
  /** The record's own values, for the marker's "on record: ..." - never for display as the word. */
  recordDisplayText: string;
  recordDefinition: string | null;
}

interface StoredOutcome {
  displayText?: string;
  syllables?: string[];
  definitionText?: string | null;
  pos?: string | null;
  usageLabels?: string[];
  onlyInDerivedTerms?: boolean;
}

const nfc = (s: string) => s.normalize('NFC');
const sameText = (a: string, b: string) => nfc(a) === nfc(b);
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((s, i) => sameText(s, b[i]));

/** One entry per word the caller has an answer on that differs from the record. Words with no
 * answer, or an answer identical to the record, are simply absent. */
export async function loadMyEntryAnswers(
  client: Queryable,
  wordIds: string[],
  userId: string,
): Promise<Map<string, MyEntryAnswer>> {
  const out = new Map<string, MyEntryAnswer>();
  if (wordIds.length === 0) return out;

  // distinct on: the newest active answer per word. The partial unique index (0013) already allows
  // only one active answer per person per word and axis, so this is belt and braces.
  const { rows } = await client.query<{
    word_id: string;
    resolved_value: StoredOutcome | null;
    display_text: string;
    syllables: string[];
    definition: string | null;
    resolved_pos: string | null;
    usage_labels: string[];
    only_in_derived_terms: boolean;
  }>(
    `select distinct on (n.word_id) n.word_id, n.resolved_value,
            g.display_text, g.syllables, g.definition,
            coalesce(g.pos, c.pin ->> 'pos') as resolved_pos, g.usage_labels, g.only_in_derived_terms
       from contributions n
       join golden_record g on g.word_id = n.word_id
       left join upstream_citations c on c.word_id = n.word_id
      where n.word_id = any($1) and n.submitted_by = $2 and n.axis = 'entry' and n.status = 'active'
      order by n.word_id, n.submitted_at desc`,
    [wordIds, userId],
  );

  for (const r of rows) {
    const o = r.resolved_value;
    if (!o?.displayText || !o.syllables?.length) continue;
    const definition = o.definitionText ?? null;
    const spellingChanged = !sameText(o.displayText, r.display_text) || !sameList(o.syllables, r.syllables);
    const definitionChanged = (definition === null ? '' : nfc(definition).trim()) !== (r.definition === null ? '' : nfc(r.definition).trim());
    const usageChanged =
      (o.pos !== undefined && o.pos !== r.resolved_pos) ||
      (o.usageLabels !== undefined && o.usageLabels.join('|') !== r.usage_labels.join('|')) ||
      (o.onlyInDerivedTerms !== undefined && o.onlyInDerivedTerms !== r.only_in_derived_terms);
    if (!spellingChanged && !definitionChanged && !usageChanged) continue;

    out.set(r.word_id, {
      displayText: o.displayText,
      syllables: o.syllables,
      definition,
      spellingChanged,
      definitionChanged,
      ...(o.pos !== undefined ? { pos: o.pos } : {}),
      ...(o.usageLabels !== undefined ? { usageLabels: o.usageLabels } : {}),
      ...(o.onlyInDerivedTerms !== undefined ? { onlyInDerivedTerms: o.onlyInDerivedTerms } : {}),
      recordDisplayText: r.display_text,
      recordDefinition: r.definition,
    });
  }
  return out;
}

export async function loadMyEntryAnswer(client: Queryable, wordId: string, userId: string): Promise<MyEntryAnswer | null> {
  return (await loadMyEntryAnswers(client, [wordId], userId)).get(wordId) ?? null;
}
