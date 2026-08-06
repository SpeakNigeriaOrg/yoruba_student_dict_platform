// checkSyllableSplitAgainstIpa.mjs
//
// Checks our syllable splitting against the only independent evidence we have: Wiktionary's own
// IPA, which carries explicit syllable boundaries for 5,040 of 6,272 entries (kept since 0016).
//
// READ ONLY. Reports; writes nothing, decides nothing.
//
// ---------------------------------------------------------------------------
// What this is authoritative about, and what it is not
// ---------------------------------------------------------------------------
// AUTHORITATIVE: the nasal decision. A nasal after a vowel is either a coda nasalising that vowel
// or a syllable of its own, and bare spelling does not always say which. The IPA says outright -
// a coda appears as a tilde on the vowel (`ẹṣin` -> /ɛ̄.ʃĩ̄/), a syllabic nasal as a lone dotted
// segment (`olóńgbò` -> /ō.ló.ŋ́.ɡ͡bò/). This is the class worth acting on.
//
// NOT AUTHORITATIVE: syllable COUNT in general, because its unit is not ours. IPA counts phonetic
// syllables; we count tone-bearing units, because the game plays one clip and asks one tone per
// unit. `àámú` is /àá.mṹ/ upstream (2) and ['à','á','mú'] here (3), and ours is the one we want -
// `à` and `á` carry different tones. Those disagreements are reported separately and are not
// findings.
//
//   DATABASE_URL=postgres://... node scripts/checkSyllableSplitAgainstIpa.mjs

import pg from 'pg';
import { syllabifyWord } from '../shared/dist/index.js';

/** IPA that is really a copy of the headword - a few entries have one - carries no IPA-only
 * symbol and would otherwise be read as a one-syllable transcription. */
const IPA_ONLY = /[ɛɔŋɾʃãẽĩõũ]|d͡ʒ|k͡p|ɡ͡b|ꜜ/u;

/** A dotted segment that is nothing but a nasal: the IPA's way of writing a syllabic nasal. The
 * homorganic forms all appear - ŋ before a velar, m before a labial, n elsewhere. */
const LONE_NASAL_SEGMENT = /^[ŋmn][̀́̄]?$/u;

function ipaSyllables(ipa) {
  return ipa
    .replace(/^[/[]|[/\]]$/gu, '')
    .trim()
    .split('.');
}

function ourSplitHasLoneNasal(syllables) {
  return syllables.some((s) => /^[nm][̀́̄]?$/u.test(s.normalize('NFD')));
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString });

  const { rows } = await pool.query(
    `select entry_id, canonical_value, ipa from kaikki_senses
     where ipa is not null and ipa like '%.%' and canonical_value not like '% %'
     order by canonical_value`,
  );

  const usable = rows.filter((r) => IPA_ONLY.test(r.ipa));

  let bothSyllabic = 0;
  let bothCoda = 0;
  const weSayCoda = []; // IPA says syllabic - the class to act on
  const weSaySyllabic = []; // IPA says coda
  const countOnly = []; // counts differ but the nasal decision agrees

  for (const row of usable) {
    const ours = syllabifyWord(row.canonical_value);
    const theirs = ipaSyllables(row.ipa);
    const oursLone = ourSplitHasLoneNasal(ours);
    const theirsLone = theirs.some((s) => LONE_NASAL_SEGMENT.test(s.normalize('NFD')));

    if (oursLone && theirsLone) bothSyllabic += 1;
    else if (!oursLone && !theirsLone) bothCoda += 1;
    else if (theirsLone) weSayCoda.push({ ...row, ours, theirs });
    else weSaySyllabic.push({ ...row, ours, theirs });

    if (oursLone === theirsLone && ours.length !== theirs.length) countOnly.push({ ...row, ours, theirs });
  }

  const agreed = bothSyllabic + bothCoda;
  console.log(`entries with dotted IPA, single word     ${rows.length}`);
  console.log(`  usable (real IPA, not a headword copy) ${usable.length}`);
  console.log(`\nthe nasal decision - IPA is authoritative here`);
  console.log(`  both say syllabic                      ${bothSyllabic}`);
  console.log(`  both say coda                          ${bothCoda}`);
  console.log(`  agreement                              ${((agreed / usable.length) * 100).toFixed(2)}%`);

  console.log(`\nFINDINGS: IPA has a syllabic nasal where our split has a coda  ${weSayCoda.length}`);
  for (const r of weSayCoda) {
    console.log(`  ${r.canonical_value.padEnd(18)} ours [${r.ours.join('|')}]  ipa ${r.ipa}  ${r.entry_id}`);
  }
  console.log(`\nthe reverse - our split has a syllabic nasal where IPA has none  ${weSaySyllabic.length}`);
  for (const r of weSaySyllabic) {
    console.log(`  ${r.canonical_value.padEnd(18)} ours [${r.ours.join('|')}]  ipa ${r.ipa}  ${r.entry_id}`);
  }

  // Reported, not a finding: see the header. Printed as a count so a sudden change in it is
  // visible, without inviting anyone to "fix" our unit to match a different one.
  console.log(
    `\nnot findings: ${countOnly.length} entries agree on the nasal but differ in syllable COUNT` +
      ` (IPA counts phonetic syllables, we count tone-bearing units - e.g. àá is one to them and two to us)`,
  );
  for (const r of countOnly.slice(0, 5)) {
    console.log(`  ${r.canonical_value.padEnd(18)} ours ${r.ours.length} [${r.ours.join('|')}]  ipa ${r.theirs.length} ${r.ipa}`);
  }
  if (countOnly.length > 5) console.log(`  ... and ${countOnly.length - 5} more`);

  await pool.end();
  // Never a non-zero exit: this is a report about the corpus, not a gate on anything.
}

await main();
