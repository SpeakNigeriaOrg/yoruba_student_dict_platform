// exportWiktionaryDrafts.mjs
//
// Turns what this platform holds into Wiktionary source, and - more useful today -
// says exactly what stops each entry from being contributable.
//
// Read-only against Postgres. Writes only local files. Safe to re-run; always
// overwrites its own prior output.
//
// Usage:
//   DATABASE_URL=postgres://... node scripts/exportWiktionaryDrafts.mjs
//   ... --out some/dir        where the drafts go (default: out/wiktionary)
//   ... --word owo_hand       one entry, for looking closely at a single case
//   ... --report-only         print the report, write nothing
//
// ---------------------------------------------------------------------------
// The direction that is actually valuable, and it is not the obvious one
// ---------------------------------------------------------------------------
// A CITED entry is one we already found on Wiktionary, so drafting a page for it
// would propose creating something that exists. The entries worth contributing are
// the ones carrying an EXEMPT citation - a real Yoruba word or phrase with no
// upstream entry at all: loanwords (rédíò, gúáfà), calendar names (Beélú, Ṣẹẹrẹ),
// locally composed phrases (ìfọyín, ẹ jọ̀ọ́).
//
// And those are precisely the entries this database knows least about, which is the
// inversion 0018 exists to correct. A cited entry has a pin holding pos, glosses and
// upstream's own etymology prose; an exempt entry has an empty pin ({}) and, before
// 0018, no part of speech and no dictionary-style English gloss anywhere. So this
// script's first job is not to produce beautiful wikitext - it is to name that gap
// per entry, so the work of closing it is a list rather than a feeling.
//
// A cited entry still gets a draft, of a different kind: the things we have that
// upstream does not. Audio recorded by real Yoruba speakers is the big one - the
// corpus carries pronunciation transcriptions but the entries have no recordings -
// followed by usage examples with translations, and an {{etymid}} label, which only
// 72 of 6,272 corpus entries carry at all.
//
// ---------------------------------------------------------------------------
// Where each field comes from, and what has no source
// ---------------------------------------------------------------------------
//   headword       golden_record.display_text. Ours, and the real editorial value:
//                  tone corrections are routine here (Phase F) and upstream is
//                  frequently un-toned or differently toned.
//   part of speech golden_record.pos, else the pin's. NEITHER for an exempt entry
//                  added before 0018 - the commonest blocker below.
//   sense line     golden_record.english_gloss, else the pin's glosses. NOT
//                  golden_record.definition, which is deliberately simplified for
//                  students and would be the wrong register upstream.
//   {{etymid}}     golden_record.etymid_label, else derived from the word_id hint,
//                  which is already exactly that: a short English disambiguator a
//                  curator chose when they picked the etymology.
//   etymology      golden_record_components, as {{af|yo|...}} with each part's own
//                  gloss. A phrase whose spelling its parts cannot produce (`o ṣé`
//                  from `o` + `ṣe`) is flagged rather than decomposed, because the
//                  real relation there is a clipping and this schema cannot yet say
//                  so - see the note at the bottom of this file.
//   {{uxi}}        word_examples, live rows only, and ONLY where their AUTHOR agreed to
//                  the contributor terms. The sentence and its translation are that
//                  person's writing, not a fact about the word.
//   {{audio}}      utterances, and ONLY from a speaker who agreed (0019). Its `a=` is an
//                  ACCENT qualifier, so it carries speakers.dialect_region, never a
//                  credit - Commons credits through the uploaded file's own metadata.
//
// Both rights checks report rather than filter: anything withheld is named per entry
// with the state that withheld it, because a silently shorter draft looks finished.
//
// ---------------------------------------------------------------------------
// Two things a human must check before the first real submission
// ---------------------------------------------------------------------------
// Template choices here are conservative on purpose, but they are still choices:
//
//   {{head|yo|<pos>}} is used for the headword line rather than a language-specific
//   template like {{yo-noun}}. head is the universal fallback and is always valid;
//   whether Yoruba has a better per-POS template is a question about current
//   Wiktionary practice, which this script cannot see.
//
//   {{yo-IPA}} is emitted with no argument, so the pronunciation is generated from
//   the spelling we are contributing. We deliberately do not hand-write a
//   transcription: 0016 records that our syllable unit is the tone-bearing unit and
//   IPA's is the phonetic syllable, and they disagree on 332 forms where ours is the
//   one we want. Emitting the template keeps that disagreement out of the entry.

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { checkPhraseSpelling, describePhraseSpelling, etymidLabelFromWordId } from '../shared/dist/index.js';

const OUT_DEFAULT = 'out/wiktionary';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

/** Kaikki's pos codes -> the section heading and the {{head}} argument Wiktionary
 * uses. Unmapped codes pass through capitalised rather than being dropped: a wrong
 * heading a human can see and fix beats an entry silently missing its part of
 * speech. */
const POS_NAMES = {
  noun: 'Noun',
  verb: 'Verb',
  adj: 'Adjective',
  adv: 'Adverb',
  intj: 'Interjection',
  pron: 'Pronoun',
  prep: 'Preposition',
  particle: 'Particle',
  conj: 'Conjunction',
  num: 'Numeral',
  name: 'Proper noun',
  det: 'Determiner',
  character: 'Letter',
  phrase: 'Phrase',
  proverb: 'Proverb',
};

function posName(pos) {
  if (!pos) return null;
  return POS_NAMES[pos] ?? pos.charAt(0).toUpperCase() + pos.slice(1);
}

/** The head of a gloss, for a template argument rather than a sense line.
 *
 * `{{af|yo|o|ṣe|t1=you (second-person singular non-honorific personal pronoun)}}` renders an
 * etymology nobody can read; upstream writes `o (“you”)`. Kaikki glosses carry their
 * disambiguation in a trailing clause, so the first one is the gloss and the rest is
 * apparatus - the same first-clause rule shared/'s meaningSlug already applies when it turns a
 * gloss into a word_id hint, kept here as prose rather than a slug. The sense line keeps the
 * gloss in full: there the apparatus is the point. */
function shortGloss(gloss) {
  return String(gloss).split(/[,;(]/)[0].trim() || String(gloss).trim();
}

/** Escapes nothing and quotes nothing - wikitext is the output format, and a gloss
 * containing `|` would break the template it sits in. Only that one character needs
 * handling, via the standard {{!}} escape. */
function wikiArg(text) {
  return String(text).replace(/\|/g, '{{!}}');
}

async function loadEntries(pool, only) {
  const { rows } = await pool.query(
    `select g.word_id, g.display_text, g.syllables, g.definition, g.entry_type,
            g.pos, g.english_gloss, g.etymid_label,
            c.entry_id, c.exempt_reason, c.pin
       from golden_record g
       left join upstream_citations c on c.word_id = g.word_id
      ${only ? 'where g.word_id = $1' : ''}
      order by g.word_id`,
    only ? [only] : [],
  );
  return rows;
}

async function loadComponents(pool) {
  // Each component's own spelling and its own gloss, because {{af|yo|o|ṣeun|t1=you|t2=...}}
  // wants both and the gloss is what makes the etymology readable.
  //
  // Gloss precedence is the same everywhere in this script and matters most here: the
  // authored publication gloss, else what upstream said in the component's own pin, and
  // only then the student definition. Falling to the definition first put `to do something`
  // into an etymology template where upstream's own `to do` belonged - the simplified
  // register leaking into the one place it is most obviously wrong.
  const { rows } = await pool.query(
    `select gc.word_id, gc.component_position, gc.component_word_id, p.display_text,
            coalesce(p.english_gloss, c.pin -> 'glosses' ->> 0, p.definition) as gloss
       from golden_record_components gc
       join golden_record p on p.word_id = gc.component_word_id
       left join upstream_citations c on c.word_id = p.word_id
      order by gc.word_id, gc.component_position`,
  );
  const byWord = new Map();
  for (const row of rows) {
    if (!byWord.has(row.word_id)) byWord.set(row.word_id, []);
    byWord.get(row.word_id).push({ wordId: row.component_word_id, displayText: row.display_text, gloss: row.gloss });
  }
  return byWord;
}

/** Usage examples, paired with their AUTHOR's release rights.
 *
 * An example sentence and its English translation are someone's writing, not a fact
 * about the word, and this script publishes both as {{uxi}}. So they gate on a grant
 * exactly as audio does - via contributor_release_rights, keyed on the account that
 * wrote them (0019). Everything is returned, permitted or not, so the report can name
 * what was withheld rather than quietly emitting a shorter entry. */
async function loadExamples(pool) {
  const { rows } = await pool.query(
    `select e.word_id, e.example_text, e.translation, r.display_name, r.email, r.release_state
       from word_examples e
       join contributor_release_rights r on r.user_id = e.submitted_by
      where e.excluded_at is null
      order by e.word_id, e.submitted_at`,
  );
  const byWord = new Map();
  for (const row of rows) {
    if (!byWord.has(row.word_id)) byWord.set(row.word_id, []);
    byWord.get(row.word_id).push({
      text: row.example_text,
      translation: row.translation,
      author: row.display_name ?? row.email,
      releaseState: row.release_state,
    });
  }
  return byWord;
}

/** Word audio, paired with the speaker's release rights.
 *
 * Take 1 and a recording that still matches the current spelling, the same two rules
 * exportGameContent.mjs and publishToR2.mjs already apply - a recording of a
 * since-corrected spelling is a pronunciation of a word we no longer publish, and
 * contributing it upstream would be worse than serving it in a game.
 *
 * Rights come from speaker_release_rights (0019), which is the only place the
 * precedence rule lives. Everything is returned, permitted or not: what is withheld
 * and why is the report's most actionable line, and a filtered query could not say it. */
async function loadAudio(pool) {
  const { rows } = await pool.query(
    `select u.word_id, r.speaker_id, r.display_name, r.release_state, r.dialect_region
       from utterances u
       join golden_record w on w.word_id = u.word_id
       join speaker_release_rights r on r.speaker_id = u.speaker_id
      where u.take_number = 1
        and u.audio_data is not null
        and u.recorded_display_text = w.display_text
        and u.recorded_syllables = w.syllables
      order by u.word_id, r.display_name`,
  );
  const byWord = new Map();
  for (const row of rows) {
    if (!byWord.has(row.word_id)) byWord.set(row.word_id, []);
    byWord.get(row.word_id).push({
      speakerId: row.speaker_id,
      speaker: row.display_name,
      releaseState: row.release_state,
      dialectRegion: row.dialect_region,
    });
  }
  return byWord;
}

/** The Commons filename a recording would be uploaded under.
 *
 * Commons convention for pronunciation files is `<Lang code>-<word>.wav`. The file does
 * not exist yet - nothing has been uploaded - so this is what the draft REFERS to and
 * what the upload step would have to produce. Named here so the two cannot disagree
 * later. */
function commonsAudioName(displayText, speaker) {
  return `Yo-${displayText.normalize('NFC').replace(/ /g, '_')}-${speaker.replace(/[^A-Za-z0-9]+/g, '')}.wav`;
}

function buildDraft(entry, components, examples, audio) {
  const pin = entry.pin && Object.keys(entry.pin).length > 0 ? entry.pin : null;
  const cited = Boolean(entry.entry_id);

  const pos = entry.pos ?? pin?.pos ?? null;
  const glosses = entry.english_gloss ? [entry.english_gloss] : (pin?.glosses ?? []);
  const etymid = entry.etymid_label ?? etymidLabelFromWordId(entry.word_id, entry.display_text);

  const blockers = [];
  const notes = [];

  if (!cited && !entry.exempt_reason) {
    // No citation row at all. 0014 backfilled nothing by design, so this is a word
    // predating citations rather than a fault - but nothing here can tell whether
    // upstream has it, which is the first thing a contributor must know.
    blockers.push('no citation row: cannot tell whether Wiktionary already has this entry');
  }
  if (!pos) blockers.push('no part of speech (set golden_record.pos)');
  if (glosses.length === 0) blockers.push('no English gloss (set golden_record.english_gloss)');
  if (!etymid) notes.push('no etymid label, and the word_id is not in <spelling>_<hint> shape to derive one');

  // A phrase whose spelling its parts cannot produce. Reported rather than resolved:
  // the honest etymology is usually a clipping or a contraction of something else
  // (`o ṣé` is {{clipping|yo|o ṣeun}} upstream), and this schema records composition
  // only, with no relation type and no way to point at an entry we do not hold.
  if (components.length > 0) {
    const spelling = checkPhraseSpelling(entry.display_text, components.map((c) => c.displayText));
    if (!spelling.matches) {
      notes.push(
        `spelling is not its components joined (${describePhraseSpelling(spelling)}); ` +
          'the etymology section says only what it is composed of, which may not be the real relation',
      );
    }
  }

  const permitted = audio.filter((a) => a.releaseState === 'agreed');
  for (const a of audio) {
    if (a.releaseState !== 'agreed') {
      notes.push(`audio by ${a.speaker} withheld: contributor agreement is '${a.releaseState}' (see 0019)`);
    }
  }
  if (audio.length === 0) notes.push('no publishable recording of this word yet');

  // Written contributions gate on their author's grant for the same reason audio does:
  // the sentence and its translation are that person's writing, and this script would
  // publish them.
  const publishableExamples = examples.filter((e) => e.releaseState === 'agreed');
  for (const e of examples) {
    if (e.releaseState !== 'agreed') {
      notes.push(`example by ${e.author} withheld: contributor agreement is '${e.releaseState}' (see 0019)`);
    }
  }

  if (cited && permitted.length === 0 && publishableExamples.length === 0) {
    // The honest reading of an additions draft with nothing in it. Counted separately from
    // "no recording", because the two have different fixes: record the word, or accept that
    // this entry is simply already complete as far as we are concerned.
    notes.push('nothing to contribute to this entry yet - it is cited, with no releasable audio and no examples');
  }

  const lines = [];
  // An additions draft is not a page to create - the entry is already there. Said at the top,
  // in the file, because a directory of .wiki files all looking like new pages is exactly how
  // someone would paste one over an existing entry and wipe what upstream already has.
  if (cited) {
    lines.push(`<!-- ALREADY ON WIKTIONARY as ${entry.entry_id}.`);
    lines.push('     This is NOT a page to create. What is new here is the audio, the usage');
    lines.push('     examples, and the etymid label; the rest is rendered from the citation pin so');
    lines.push('     it can be compared against the live entry before anything is added. -->');
  }
  lines.push('==Yoruba==');
  lines.push('');

  const etymologyLines = [];
  if (etymid) etymologyLines.push(`{{etymid|yo|${wikiArg(etymid)}}}`);
  if (components.length > 0) {
    const args = components.map((c) => wikiArg(c.displayText)).join('|');
    const glossArgs = components
      .map((c, i) => (c.gloss ? `|t${i + 1}=${wikiArg(shortGloss(c.gloss))}` : ''))
      .join('');
    etymologyLines.push(`{{af|yo|${args}${glossArgs}}}`);
  } else if (pin?.etymologyText) {
    // Upstream's own prose, as a comment. It is what a human read when they judged
    // this the right etymology, and it belongs in front of whoever edits this draft -
    // but it is upstream's sentence, not ours to re-assert.
    etymologyLines.push(`<!-- Wiktionary's own etymology at citation time: ${pin.etymologyText} -->`);
  }
  // Omitted entirely when there is nothing to put in it. An empty ===Etymology=== heading is
  // not a smaller version of an etymology; it is a malformed section that a reviewer has to
  // delete before the page is acceptable.
  if (etymologyLines.length > 0) {
    lines.push('===Etymology===');
    lines.push(...etymologyLines);
    lines.push('');
  }
  // The IPA template is for an entry we are creating. On an additions draft it would propose
  // re-stating a pronunciation upstream already generates the same way, so the section appears
  // there only when we actually have a recording to contribute.
  if (!cited || permitted.length > 0) {
    lines.push('===Pronunciation===');
    if (!cited) lines.push('* {{yo-IPA}}');
    for (const a of permitted) {
      // `a=` is an ACCENT qualifier, not a credit line - see Template:audio's own
      // documentation. This used to put the speaker's name there, which would have
      // labelled every recording as if the person's name were a dialect. Crediting on
      // Commons is carried by the uploaded file's metadata, not by this template, so the
      // right value here is the speaker's dialect region when we know it and nothing when
      // we do not.
      const accent = a.dialectRegion ? `|a=${wikiArg(a.dialectRegion)}` : '';
      lines.push(`* {{audio|yo|${commonsAudioName(entry.display_text, a.speaker)}${accent}}}`);
    }
    lines.push('');
  }
  lines.push(`===${posName(pos) ?? 'UNKNOWN PART OF SPEECH'}===`);
  lines.push(`{{head|yo|${posName(pos)?.toLowerCase() ?? 'UNKNOWN'}|head=${wikiArg(entry.display_text)}}}`);
  lines.push('');
  if (glosses.length === 0) {
    lines.push('# UNKNOWN SENSE');
  } else {
    for (const gloss of glosses) lines.push(`# ${wikiArg(gloss)}`);
  }
  for (const ex of publishableExamples) {
    lines.push(`#: {{uxi|yo|${wikiArg(ex.text)}|${wikiArg(ex.translation)}}}`);
  }

  return {
    wordId: entry.word_id,
    displayText: entry.display_text,
    kind: cited ? 'additions' : entry.exempt_reason ? 'new' : 'unknown',
    citedEntryId: entry.entry_id,
    blockers,
    notes,
    audioPermitted: permitted,
    wikitext: `${lines.join('\n')}\n`,
  };
}

function report(drafts) {
  const by = (kind) => drafts.filter((d) => d.kind === kind);
  const ready = drafts.filter((d) => d.blockers.length === 0);
  const lines = [];

  lines.push('# Wiktionary draft export');
  lines.push('');
  lines.push(`${drafts.length} ${drafts.length === 1 ? 'entry' : 'entries'} considered.`);
  lines.push('');
  lines.push(`- **${by('new').length}** would be NEW upstream entries (their citation is an explicit exemption:`);
  lines.push('  a real word Wiktionary does not have). These are the contributions.');
  lines.push(`- **${by('additions').length}** already exist upstream (they cite an etymology), so their draft holds`);
  lines.push('  only what we could ADD: audio, examples, an etymid label.');
  lines.push(`- **${by('unknown').length}** have no citation row at all, so nothing here can tell which of the two`);
  lines.push('  they are.');
  lines.push('');
  lines.push(`**${ready.length} of ${drafts.length} have no blocking gap.**`);
  lines.push('');

  const counts = new Map();
  for (const d of drafts) for (const b of d.blockers) counts.set(b, (counts.get(b) ?? 0) + 1);
  if (counts.size > 0) {
    lines.push('## What blocks the rest');
    lines.push('');
    for (const [blocker, n] of [...counts].sort((a, b) => b[1] - a[1])) {
      lines.push(`- ${n} × ${blocker}`);
    }
    lines.push('');
  }

  const noteCounts = new Map();
  for (const d of drafts) {
    for (const n of d.notes) {
      // Collapse the per-speaker and per-word detail into the shape of the problem,
      // so the summary counts kinds of gap rather than instances of prose.
      const key = n.replace(/by [^:]+:/, 'by a speaker:').replace(/\(.*\)/, '(...)');
      noteCounts.set(key, (noteCounts.get(key) ?? 0) + 1);
    }
  }
  if (noteCounts.size > 0) {
    lines.push('## Worth knowing, but not blocking');
    lines.push('');
    for (const [note, n] of [...noteCounts].sort((a, b) => b[1] - a[1])) lines.push(`- ${n} × ${note}`);
    lines.push('');
  }

  lines.push('## Per entry');
  lines.push('');
  for (const d of drafts) {
    const state = d.blockers.length === 0 ? 'ready' : `blocked (${d.blockers.length})`;
    lines.push(`### ${d.wordId} — ${d.displayText} [${d.kind}, ${state}]`);
    if (d.citedEntryId) lines.push(`- cites \`${d.citedEntryId}\``);
    for (const b of d.blockers) lines.push(`- **blocker:** ${b}`);
    for (const n of d.notes) lines.push(`- note: ${n}`);
    lines.push('');
  }
  return lines.join('\n');
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }
  const only = arg('--word', null);
  const outDir = arg('--out', OUT_DEFAULT);
  const reportOnly = process.argv.includes('--report-only');

  const pool = new pg.Pool({ connectionString });
  try {
    const [entries, components, examples, audio] = await Promise.all([
      loadEntries(pool, only),
      loadComponents(pool),
      loadExamples(pool),
      loadAudio(pool),
    ]);

    if (entries.length === 0) {
      console.error(only ? `No entry with word_id '${only}'.` : 'No entries in golden_record.');
      process.exit(1);
    }

    const drafts = entries.map((entry) =>
      buildDraft(entry, components.get(entry.word_id) ?? [], examples.get(entry.word_id) ?? [], audio.get(entry.word_id) ?? []),
    );

    const text = report(drafts);
    console.log(text.split('## Per entry')[0]);

    if (!reportOnly) {
      // Cleared rather than merged: a draft left behind from a previous run is a page
      // for an entry that may no longer exist, and there is nothing in the file itself
      // to say it is stale.
      rmSync(outDir, { recursive: true, force: true });
      mkdirSync(outDir, { recursive: true });
      for (const d of drafts) {
        writeFileSync(path.join(outDir, `${d.wordId}.wiki`), d.wikitext, 'utf8');
      }
      writeFileSync(path.join(outDir, 'REPORT.md'), text, 'utf8');
      console.log(`Wrote ${drafts.length} draft(s) and REPORT.md to ${outDir}/`);
    }
  } finally {
    await pool.end();
  }
}

// ---------------------------------------------------------------------------
// The gap this script cannot close, stated where it will be read
// ---------------------------------------------------------------------------
// An etymology here can only ever say "composed of these words, in this order".
// Wiktionary's own data for Yoruba says much more, and the corpus we already ingest
// carries it: 3,843 of 6,272 entries have at least one etymology template, and among
// them are 172 contractions, 107 blends, 93 reduplications, 58 doublets and 40
// clippings - none of which is a composition, and all of which land nowhere, because
// ingest keeps only the morpheme FORMS and drops the template NAME.
//
// `o ṣé` is the case to hold in mind. Its parts are `o` and `ṣe`, but its real
// etymology is {{clipping|yo|o ṣeun|t=thank you}}, and `o ṣeun` is itself an entry we
// may not hold. So a faithful draft needs a typed relation whose target may be a word
// we have, an upstream entry we do not, or a form in another language - none of which
// golden_record_components can express, since it is untyped, ordered, and a foreign
// key into our own vocabulary.
//
// Until that exists, every draft above states composition or nothing, and the report
// names each entry where that is known to be the wrong answer.

// Only when run as a script. Importing this file - to test the draft builder without a
// database, or to reuse the report from another script the way upstreamPublishCheck.mjs is
// reused - must not connect to Postgres and write files as a side effect of the import.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
