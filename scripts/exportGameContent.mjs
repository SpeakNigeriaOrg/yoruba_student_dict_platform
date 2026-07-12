// exportGameContent.mjs
//
// Replaces the old, fully manual, disconnected pipeline (yoruba-student-
// dict's generate_app.py -> syllable_game_concept's sync_dictionary_data.py
// copy-by-hand -> a never-finished upload_to_r2.py) with one script that
// reads the real, current source of truth (this platform's Postgres)
// and writes the syllable game's actual deployed content directly:
// vocab.json/syllables.json/sessions.json + real per-speaker .wav files,
// straight into syllable_game_concept/public/.
//
// Read-only against Postgres - never mutates the database. Safe/
// idempotent to re-run; always overwrites its own prior output.
//
// ---------------------------------------------------------------------
// DESIGN DECISIONS (recorded here since this script IS the design, not
// just an implementation of a plan written elsewhere):
//
// 1. Same-origin static audio, not R2. The old pipeline depended on a
//    Cloudflare R2 bucket whose upload script was never finished (blank
//    bucket name) and whose public URL is unauthenticated. At this
//    vocab's actual size (currently ~92 words x up to 3 speakers x ~1
//    word clip + ~2-3 syllable clips, each tens of KB), total audio is a
//    few MB - well within what Cloudflare Pages already serves for free
//    as static assets alongside index.html. Shipping audio in the same
//    deploy removes an entire external dependency (R2 credentials,
//    bucket config, a separate upload step) with no real downside at
//    this scale. `syllable_game_concept/public/app.js`'s BASE_URL was
//    changed to a same-origin relative path to match (see that file).
//    If/when the corpus grows enough that bundling audio in every
//    deploy becomes a real size/build-time problem, R2 (or Azure Blob)
//    can be reintroduced then - this isn't a one-way door, just the
//    simplest thing that works today.
//
// 2. Coverage is computed forward, not checked backward. The old
//    generate_sessions.py computed validSpeakers/validStyles AFTER
//    hand-authored levels existed, and its own client (app.js) silently
//    ignored an empty result and played the level anyway with missing
//    audio (confirmed: 3/8 real levels had zero valid speakers, and
//    speaker1/speaker3 validated for NONE of the 8 levels, in
//    production). This script inverts that: it computes each speaker's
//    actual fully-covered word set FIRST (real word audio + every one
//    of that word's current golden_record syllables recorded by that
//    same speaker - reusing the exact "decoupled syllable, matched by
//    exact tone-specific text" design from listSyllableObservations.ts),
//    then builds every level FROM that set. A level with no covered
//    speaker simply isn't generated, structurally, rather than being
//    generated-but-silently-broken.
//
// 3. Syllable coverage is speaker-scoped, using CURRENT golden_record
//    syllables (the curated spelling), not whatever a speaker's own
//    recordedSyllables said at recording time. This means a recording
//    made under a since-superseded spelling won't count toward coverage
//    until re-recorded - an intentional, honest tradeoff (see
//    registerUtterance.ts's own recordedSyllables-vs-golden_record
//    distinction) rather than silently teaching a stale pronunciation.
//
// 4. Themed levels are adapted per speaker, not gated all-or-nothing.
//    Each hand-authored theme (yoruba-student-dict/sessions_source.json)
//    becomes one level PER speaker who covers at least MIN_THEME_WORDS
//    of that theme's words - using only that speaker's covered subset,
//    not the full original word list. This directly fixes the old
//    all-or-nothing gate (one missing word used to invalidate an entire
//    speaker for that whole theme) while keeping the curriculum's real
//    pedagogical intent (themes stay hand-authored; only the per-speaker
//    playability computation is automatic).
//
// 5. New level categories, additive to themes, not replacing them:
//    syllable-reinforcement levels (greedy "fewest new syllables" set
//    packing over each speaker's covered words) and tone-pattern levels
//    (grouped by each word's high/mid/low syllable-tone sequence) - both
//    real, currently-untapped axes the old pipeline never used. Endless
//    mode is approximated as several pre-generated "Endless Practice"
//    bundles (still finite, still coverage-guaranteed) rather than true
//    client-side dynamic round assembly - a deliberately smaller, safer
//    first step; see this file's own "REMAINING TODOs" section below
//    and the session's decisions log for the real, larger version.
//
// 6. Canonical-take selection: NOT implemented. `canonical_utterance_
//    selections`/`canonical_syllable_selections` exist in the schema for
//    exactly this (a curator picking the best among competing takes),
//    but every (word_id, speaker_id, take_number) is upserted in place
//    on re-recording (see registerUtterance.ts) - there is currently no
//    real ambiguity to resolve (no word/speaker has ever had more than
//    one candidate take to choose between). Wiring a picker UI now would
//    be speculative. This script instead just uses take_number=1 for
//    word audio (the only "natural whole word" take that exists) and,
//    for syllable audio, picks the first matching recording found per
//    (speaker, syllable text) - arbitrary among ties, same "just pick
//    one, log it" spirit as migrateSpeaker1And2.mjs's host-word
//    tie-break, since exact-tone-text duplicates are expected to be
//    genuinely interchangeable takes of the same syllable.
//
// 7. Images now load from Postgres too (0010_word_images.sql - mirrors
//    audio's storage design, "art_style" playing speakers' role as the
//    multi-variant category). Unlike audio, image coverage is NOT used
//    to gate level generation - only 56/92 words have any labeled image
//    at all today (the rest of the ~350 generated images in yoruba-
//    student-dict/content/pending_images/ were never matched to a
//    word_id - see migrateStagedImages.mjs's header), so an all-or-
//    nothing image gate would eliminate most content. Each word's
//    vocab.json entry instead gets an honest `imageStyles` array (which
//    styles actually have art for THIS word); app.js's existing
//    onerror->placeholder.png fallback remains the real safety net for
//    the common case of no art yet.
//
// REMAINING TODOs (not done by this script - see conversation log):
//   - True endless/dynamic mode needs a richer client (round assembly
//     in app.js from a full per-speaker word/syllable graph), not just
//     more pre-generated bundles.
//   - Labeling the ~240 remaining unlabeled generated images in
//     content/pending_images/ against real word_ids - needs visual
//     review (filenames are generic, e.g. "z-image_00003_.png"), not
//     something this script or migrateStagedImages.mjs can do blindly.
//     A curator labeling UI (browse unlabeled image, pick a word, save)
//     is the natural next step, same shape as EtymologyReview's inline
//     "add missing component" flow.
//   - No curator-visible coverage view exists yet in the curation app
//     (would surface the same per-speaker-per-word audio coverage, and
//     now per-word image coverage, computed here, as a UI instead of an
//     offline script's console output).
//
// Usage:
//   DATABASE_URL=postgres://... node scripts/exportGameContent.mjs [--repo-dir=<path>] [--game-dir=<path>]

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const found = args.find((a) => a.startsWith(`--${flag}=`));
  return found ? found.slice(flag.length + 3) : fallback;
}
const REPO_DIR = path.resolve(process.cwd(), argValue('repo-dir', '../yoruba-student-dict'));
const GAME_DIR = path.resolve(process.cwd(), argValue('game-dir', '../syllable_game_concept'));

const MIN_THEME_WORDS = 3; // below this, a themed level variant isn't worth generating for that speaker
const REINFORCEMENT_LEVEL_SIZE = 10;
const MIN_TONE_PATTERN_WORDS = 4;
const ENDLESS_BUNDLE_SIZE = 8;
const ENDLESS_BUNDLE_COUNT = 3;

const HIGH_TONE_CHARS = ['á', 'é', 'ẹ́', 'í', 'ó', 'ọ́', 'ú', 'ń'];
const LOW_TONE_CHARS = ['à', 'è', 'ẹ̀', 'ì', 'ò', 'ọ̀', 'ù', 'ǹ'];

function stripCombiningMarks(s) {
  return Array.from(s)
    .filter((ch) => {
      const code = ch.codePointAt(0);
      return !(code >= 0x300 && code <= 0x36f);
    })
    .join('');
}

function toneOf(syllable) {
  const n = syllable.normalize('NFC').toLowerCase();
  if (HIGH_TONE_CHARS.some((c) => n.includes(c))) return 'high';
  if (LOW_TONE_CHARS.some((c) => n.includes(c))) return 'low';
  return 'mid';
}

// Ports yoruba-student-dict/scripts/generate_syllables.py's
// generate_syllable_info() naming scheme exactly (already re-verified in
// migrateSpeaker1And2.mjs) - keeps exported syllable filenames byte-
// identical to what that convention would have produced.
function safeName(syllable, toneMap) {
  const normalized = syllable.normalize('NFC').toLowerCase();
  const suffix = toneOf(normalized) === 'mid' ? '' : `_${toneOf(normalized)}`;
  let safe = normalized;
  const keysLongestFirst = Object.keys(toneMap).sort((a, b) => b.length - a.length);
  for (const key of keysLongestFirst) safe = safe.split(key).join(toneMap[key]);
  safe = stripCombiningMarks(safe.normalize('NFD')).normalize('NFC');
  return `${safe}${suffix}.wav`;
}

function shuffle(array, rng = Math.random) {
  const out = array.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function greedyMinimalSyllableSet(words, targetSize) {
  const remaining = new Map(words.map((w) => [w.wordId, w]));
  const chosen = [];
  const pool = new Set();
  while (chosen.length < targetSize && remaining.size > 0) {
    let best = null;
    let bestNew = Infinity;
    for (const w of remaining.values()) {
      const newCount = w.syllables.filter((s) => !pool.has(s)).length;
      if (newCount < bestNew) {
        best = w;
        bestNew = newCount;
      }
    }
    chosen.push(best);
    remaining.delete(best.wordId);
    best.syllables.forEach((s) => pool.add(s));
  }
  return chosen;
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const toneMap = JSON.parse(readFileSync(path.join(REPO_DIR, 'config.json'), 'utf8')).tone_map;
  let sessionsSource = [];
  const sessionsSourcePath = path.join(REPO_DIR, 'sessions_source.json');
  if (existsSync(sessionsSourcePath)) {
    sessionsSource = JSON.parse(readFileSync(sessionsSourcePath, 'utf8'));
  } else {
    console.warn(`No sessions_source.json found at ${sessionsSourcePath} - skipping themed levels.`);
  }

  const pool = new pg.Pool({ connectionString });

  console.log('[1/7] Loading golden_record...');
  const wordsResult = await pool.query(
    'select word_id, display_text, syllables, definition, entry_type from golden_record order by word_id',
  );
  const vocab = {};
  for (const row of wordsResult.rows) {
    vocab[row.word_id] = {
      displayText: row.display_text,
      syllables: row.syllables,
      definition: row.definition,
      entryType: row.entry_type,
    };
  }
  console.log(`      ${wordsResult.rows.length} words`);

  console.log('[2/7] Loading speakers, word-level audio (take 1), and syllable audio...');
  const speakersResult = await pool.query('select speaker_id, display_name from speakers order by display_name');
  const speakerNameById = new Map(speakersResult.rows.map((r) => [r.speaker_id, r.display_name]));

  // Only a recording whose OWN recorded_display_text/recorded_syllables
  // still matches golden_record's CURRENT canonical values is a valid
  // pronunciation for the game - see publishToR2.mjs's identical check
  // for the full rationale (a word's spelling/tone can be revised after
  // it was recorded; a stale recording must never be served as if it
  // were current). Confirmed 0/96 live recordings actually diverge as
  // of this writing, but nothing previously enforced it.
  const wordAudioResult = await pool.query(
    `select u.word_id, u.speaker_id, u.audio_data
     from utterances u
     join golden_record w on w.word_id = u.word_id
     where u.take_number = 1
       and u.audio_data is not null
       and u.recorded_display_text = w.display_text
       and u.recorded_syllables = w.syllables`,
  );
  // speaker -> word_id -> Buffer
  const wordAudioBySpeaker = new Map();
  for (const row of wordAudioResult.rows) {
    const speaker = speakerNameById.get(row.speaker_id);
    if (!speaker) continue;
    if (!wordAudioBySpeaker.has(speaker)) wordAudioBySpeaker.set(speaker, new Map());
    wordAudioBySpeaker.get(speaker).set(row.word_id, row.audio_data);
  }

  const syllableAudioResult = await pool.query(
    `select e.speaker_id, e.syllable_text, e.audio_data
     from syllable_observations_enriched e
     order by e.speaker_id, e.syllable_text`,
  );
  // speaker -> syllable_text -> Buffer (first one found wins - see file header, decision 6)
  const syllableAudioBySpeaker = new Map();
  for (const row of syllableAudioResult.rows) {
    const speaker = speakerNameById.get(row.speaker_id);
    if (!speaker) continue;
    if (!syllableAudioBySpeaker.has(speaker)) syllableAudioBySpeaker.set(speaker, new Map());
    const map = syllableAudioBySpeaker.get(speaker);
    if (!map.has(row.syllable_text)) map.set(row.syllable_text, row.audio_data);
  }
  console.log(`      ${wordAudioBySpeaker.size} speaker(s) with word audio, ${syllableAudioBySpeaker.size} with syllable audio`);

  console.log('[3/7] Loading images...');
  const imagesResult = await pool.query(
    `select word_id, art_style, image_data
     from word_images
     where variant_number = 1
     order by word_id, art_style`,
  );
  // word_id -> style -> Buffer (variant_number=1 only - see decision 7 above)
  const imagesByWord = new Map();
  for (const row of imagesResult.rows) {
    if (!imagesByWord.has(row.word_id)) imagesByWord.set(row.word_id, new Map());
    imagesByWord.get(row.word_id).set(row.art_style, row.image_data);
  }
  const wordsWithNoImage = Object.keys(vocab).filter((wordId) => !imagesByWord.has(wordId));
  console.log(
    `      ${imagesByWord.size} / ${wordsResult.rows.length} words have at least one labeled image (${wordsWithNoImage.length} have none)`,
  );

  console.log('[4/7] Computing per-speaker coverage...');
  const speakers = [...new Set([...wordAudioBySpeaker.keys(), ...syllableAudioBySpeaker.keys()])].sort();
  // speaker -> array of { wordId, displayText, syllables }, fully covered
  const coveredWordsBySpeaker = new Map();
  for (const speaker of speakers) {
    const wordAudio = wordAudioBySpeaker.get(speaker) ?? new Map();
    const syllableAudio = syllableAudioBySpeaker.get(speaker) ?? new Map();
    const covered = [];
    for (const [wordId, entry] of Object.entries(vocab)) {
      if (!wordAudio.has(wordId)) continue;
      const allSyllablesCovered = entry.syllables.every((s) => syllableAudio.has(s));
      if (!allSyllablesCovered) continue;
      // Image coverage is a hard gate here too, not optional metadata -
      // a word with no real image must never be presented with a
      // placeholder standing in for it (see publishToR2.mjs's identical
      // check for the full rationale).
      if (!imagesByWord.get(wordId)?.size) continue;
      covered.push({ wordId, displayText: entry.displayText, syllables: entry.syllables });
    }
    coveredWordsBySpeaker.set(speaker, covered);
    console.log(`      ${speaker}: ${covered.length} / ${wordsResult.rows.length} words fully playable`);
  }

  console.log('[5/7] Writing audio and image files...');
  let wordFilesWritten = 0;
  let syllableFilesWritten = 0;
  for (const [speaker, wordMap] of wordAudioBySpeaker) {
    const dir = path.join(GAME_DIR, 'public', 'words', speaker);
    mkdirSync(dir, { recursive: true });
    for (const [wordId, buf] of wordMap) {
      writeFileSync(path.join(dir, `${wordId}.wav`), buf);
      wordFilesWritten++;
    }
  }
  for (const [speaker, syllableMap] of syllableAudioBySpeaker) {
    const dir = path.join(GAME_DIR, 'public', 'syllables', speaker);
    mkdirSync(dir, { recursive: true });
    for (const [syllableText, buf] of syllableMap) {
      writeFileSync(path.join(dir, safeName(syllableText, toneMap)), buf);
      syllableFilesWritten++;
    }
  }
  let imageFilesWritten = 0;
  for (const [wordId, styleMap] of imagesByWord) {
    for (const [style, buf] of styleMap) {
      const dir = path.join(GAME_DIR, 'public', 'images', style);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, `${wordId}.png`), buf);
      imageFilesWritten++;
    }
  }
  console.log(`      ${wordFilesWritten} word file(s), ${syllableFilesWritten} syllable file(s), ${imageFilesWritten} image file(s)`);

  console.log('[6/7] Building sessions.json (levels)...');
  const levels = [];

  // --- Themed levels, adapted per speaker (decision 4) ---
  for (const theme of sessionsSource) {
    for (const speaker of speakers) {
      const covered = coveredWordsBySpeaker.get(speaker);
      const coveredIds = new Set(covered.map((w) => w.wordId));
      const themeCoveredWords = theme.words.filter((wordId) => coveredIds.has(wordId));
      if (themeCoveredWords.length < MIN_THEME_WORDS) continue;
      const sorted = themeCoveredWords
        .map((wordId) => vocab[wordId])
        .map((entry, i) => ({ wordId: themeCoveredWords[i], ...entry }))
        .sort((a, b) => a.syllables.length - b.syllables.length);
      levels.push({
        levelId: `${theme.levelId} — ${speaker}`,
        category: 'themed',
        validSpeakers: [speaker],
        words: sorted.map((w) => w.wordId),
      });
      if (themeCoveredWords.length < theme.words.length) {
        console.log(
          `      themed "${theme.levelId}" (${speaker}): ${themeCoveredWords.length}/${theme.words.length} words covered, adapted`,
        );
      }
    }
  }

  // --- Syllable-reinforcement levels (decision 5) ---
  for (const speaker of speakers) {
    const covered = coveredWordsBySpeaker.get(speaker);
    if (covered.length < MIN_THEME_WORDS) continue;
    let remaining = covered.slice();
    let bundleNum = 1;
    while (remaining.length >= MIN_THEME_WORDS) {
      const chunkTarget = Math.min(REINFORCEMENT_LEVEL_SIZE, remaining.length);
      const chosen = greedyMinimalSyllableSet(remaining, chunkTarget);
      const chosenIds = new Set(chosen.map((w) => w.wordId));
      remaining = remaining.filter((w) => !chosenIds.has(w.wordId));
      levels.push({
        levelId: `Syllable Practice ${bundleNum} — ${speaker}`,
        category: 'syllable_reinforcement',
        validSpeakers: [speaker],
        words: chosen.sort((a, b) => a.syllables.length - b.syllables.length).map((w) => w.wordId),
      });
      bundleNum++;
    }
  }

  // --- Tone-pattern levels (decision 5) ---
  for (const speaker of speakers) {
    const covered = coveredWordsBySpeaker.get(speaker);
    const byPattern = new Map();
    for (const w of covered) {
      const pattern = w.syllables.map(toneOf).join('-');
      if (!byPattern.has(pattern)) byPattern.set(pattern, []);
      byPattern.get(pattern).push(w);
    }
    for (const [pattern, words] of byPattern) {
      if (words.length < MIN_TONE_PATTERN_WORDS) continue;
      levels.push({
        levelId: `Tone Pattern (${pattern}) — ${speaker}`,
        category: 'tone_pattern',
        validSpeakers: [speaker],
        words: words.sort((a, b) => a.syllables.length - b.syllables.length).map((w) => w.wordId),
      });
    }
  }

  // --- Endless-practice bundles (decision 5; finite approximation, see file header) ---
  for (const speaker of speakers) {
    const covered = coveredWordsBySpeaker.get(speaker);
    if (covered.length < MIN_THEME_WORDS) continue;
    for (let i = 0; i < ENDLESS_BUNDLE_COUNT; i++) {
      const sampleSize = Math.min(ENDLESS_BUNDLE_SIZE, covered.length);
      const words = shuffle(covered).slice(0, sampleSize);
      levels.push({
        levelId: `Endless Practice ${i + 1} — ${speaker}`,
        category: 'endless_practice',
        validSpeakers: [speaker],
        words: words.map((w) => w.wordId),
      });
    }
  }

  console.log(`      ${levels.length} level(s) generated across ${speakers.length} speaker(s)`);

  console.log('[7/7] Writing vocab.json / syllables.json / sessions.json...');
  const publicDir = path.join(GAME_DIR, 'public');
  mkdirSync(publicDir, { recursive: true });

  const vocabOut = {};
  for (const [wordId, entry] of Object.entries(vocab)) {
    vocabOut[wordId] = {
      displayText: entry.displayText,
      syllables: entry.syllables,
      definition: entry.definition,
      imageStyles: [...(imagesByWord.get(wordId)?.keys() ?? [])],
    };
  }
  writeFileSync(path.join(publicDir, 'vocab.json'), JSON.stringify(vocabOut, null, 2));

  const syllablesOut = {};
  for (const speaker of speakers) {
    syllablesOut[speaker] = {};
    const syllableMap = syllableAudioBySpeaker.get(speaker) ?? new Map();
    for (const syllableText of syllableMap.keys()) {
      syllablesOut[speaker][syllableText] = {
        audio: `syllables/${speaker}/${safeName(syllableText, toneMap)}`,
        tone: toneOf(syllableText),
      };
    }
  }
  writeFileSync(path.join(publicDir, 'syllables.json'), JSON.stringify(syllablesOut, null, 2));

  writeFileSync(path.join(publicDir, 'sessions.json'), JSON.stringify(levels, null, 2));

  await pool.end();
  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
