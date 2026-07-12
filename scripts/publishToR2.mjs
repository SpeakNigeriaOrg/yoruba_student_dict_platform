// publishToR2.mjs
//
// The real automation of the bucket approach (replaces the never-run
// upload_to_r2.py - see that file's own docstring: written but never
// executed, blank bucket name, needed local `wrangler login`). This
// script instead authenticates with a portable R2 API token (Access Key
// ID + Secret Access Key, R2's S3-compatible API) read from environment
// variables - works identically from any machine or CI runner, with no
// dependency on any one laptop's local `wrangler login` session.
//
// Pipeline (all from Postgres, the platform's real source of truth):
//   1. Load word audio (take 1), syllable audio, and images exactly like
//      exportGameContent.mjs does.
//   2. Upload every one of those blobs to R2 via PutObject, using the
//      SAME key scheme the game's app.js and the old Python pipeline
//      already expect (words/{speaker}/{wordId}.wav,
//      syllables/{speaker}/{legacy-style-safe-name}.wav,
//      images/{style}/{wordId}.png) - no app.js/key-scheme changes needed.
//   3. Verify each upload with a HeadObject read-back rather than trusting
//      a successful PutObject response alone - this is the same "verify
//      forward from a real check, don't just assume" discipline
//      exportGameContent.mjs's header documents (decision 2), now applied
//      to the network call instead of a local file write.
//   4. Compute validSpeakers/validStyles per level from the SET OF KEYS
//      JUST VERIFIED PRESENT IN R2 - structurally the same computation
//      generate_sessions.py used to do via a separate HTTP HEAD pass
//      against the bucket, just done here as one continuous publish step
//      instead of two hand-coordinated ones (upload, then separately
//      remember to regenerate sessions.json against whatever state the
//      bucket happens to be in). This is what actually closes the gap
//      that caused the real, currently-live bug found this session (code
//      shipped assuming R2 content that silently wasn't there for 3/8
//      levels): after this script runs, sessions.json can only ever claim
//      a speaker/style is valid for content that was JUST confirmed to
//      exist in the bucket, in the same run.
//   5. Write vocab.json/syllables.json/sessions.json locally into
//      <game-dir>/public/ - these three small JSON files are still
//      committed to git and deployed with the app's code (same as
//      before), since they're cheap, and bundling them is what lets
//      app.js fetch level/vocab metadata same-origin with no bucket
//      round-trip before it even knows what to ask the bucket for. Only
//      the actual audio/image BYTES live in R2 - no local words/,
//      syllables/, images/ directories are written by this script.
//
// Required environment variables:
//   DATABASE_URL          - this platform's Postgres connection string
//   R2_ACCOUNT_ID         - Cloudflare account ID (from the R2 API token
//                           creation screen, or the dashboard URL)
//   R2_ACCESS_KEY_ID      - from an R2 API token scoped to the bucket
//                           below, with Object Read & Write permission
//   R2_SECRET_ACCESS_KEY  - the matching secret
//   R2_BUCKET_NAME        - the real bucket name (visible in the R2
//                           dashboard's bucket list - NOT the public
//                           pub-xxxx.r2.dev hostname, which is just the
//                           public read endpoint)
//
// Safety: defaults to a dry run (prints what it would upload, uploads
// nothing). Pass --apply to actually push to R2.
//
// Usage:
//   DATABASE_URL=... R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... \
//   R2_SECRET_ACCESS_KEY=... R2_BUCKET_NAME=... \
//     node scripts/publishToR2.mjs [--apply] [--repo-dir=<path>] [--game-dir=<path>]

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
function argValue(flag, fallback) {
  const found = args.find((a) => a.startsWith(`--${flag}=`));
  return found ? found.slice(flag.length + 3) : fallback;
}
const REPO_DIR = path.resolve(process.cwd(), argValue('repo-dir', '../yoruba-student-dict'));
const GAME_DIR = path.resolve(process.cwd(), argValue('game-dir', '../syllable_game_concept'));

const MIN_THEME_WORDS = 3;
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

// Same port of generate_syllable_info() as exportGameContent.mjs/
// migrateSpeaker1And2.mjs - kept duplicated here rather than shared,
// matching this repo's established one-file-per-script convention.
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
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME } = process.env;
  for (const [name, value] of Object.entries({
    DATABASE_URL: connectionString,
    R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    R2_BUCKET_NAME,
  })) {
    if (!value) {
      console.error(`${name} is not set.`);
      process.exit(1);
    }
  }

  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  });

  async function putAndVerify(key, buffer, contentType) {
    if (apply) {
      await s3.send(new PutObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key, Body: buffer, ContentType: contentType }));
      await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
    }
    return key;
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

  console.log('[1/6] Loading golden_record...');
  const wordsResult = await pool.query(
    'select word_id, display_text, syllables, definition, entry_type from golden_record order by word_id',
  );
  const vocab = {};
  for (const row of wordsResult.rows) {
    vocab[row.word_id] = { displayText: row.display_text, syllables: row.syllables, definition: row.definition, entryType: row.entry_type };
  }
  console.log(`      ${wordsResult.rows.length} words`);

  console.log('[2/6] Loading speakers, word-level audio (take 1), syllable audio, images...');
  const speakersResult = await pool.query('select speaker_id, display_name from speakers order by display_name');
  const speakerNameById = new Map(speakersResult.rows.map((r) => [r.speaker_id, r.display_name]));

  const wordAudioResult = await pool.query(
    `select word_id, speaker_id, audio_data from utterances where take_number = 1 and audio_data is not null`,
  );
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
  const syllableAudioBySpeaker = new Map();
  for (const row of syllableAudioResult.rows) {
    const speaker = speakerNameById.get(row.speaker_id);
    if (!speaker) continue;
    if (!syllableAudioBySpeaker.has(speaker)) syllableAudioBySpeaker.set(speaker, new Map());
    const map = syllableAudioBySpeaker.get(speaker);
    if (!map.has(row.syllable_text)) map.set(row.syllable_text, row.audio_data);
  }

  const imagesResult = await pool.query(
    `select word_id, art_style, image_data from word_images where variant_number = 1 order by word_id, art_style`,
  );
  const imagesByWord = new Map();
  for (const row of imagesResult.rows) {
    if (!imagesByWord.has(row.word_id)) imagesByWord.set(row.word_id, new Map());
    imagesByWord.get(row.word_id).set(row.art_style, row.image_data);
  }
  console.log(
    `      ${wordAudioBySpeaker.size} speaker(s) with word audio, ${syllableAudioBySpeaker.size} with syllable audio, ${imagesByWord.size} words with an image`,
  );

  console.log(`[3/6] ${apply ? 'Uploading to' : '[dry-run] would upload to'} R2 bucket "${R2_BUCKET_NAME}"...`);
  const verifiedWordAudioKey = new Map(); // speaker -> word_id -> key (only entries actually verified present)
  const verifiedSyllableAudioKey = new Map(); // speaker -> syllable_text -> key
  const verifiedImageKey = new Map(); // word_id -> style -> key
  let uploadCount = 0;
  let failCount = 0;

  for (const [speaker, wordMap] of wordAudioBySpeaker) {
    verifiedWordAudioKey.set(speaker, new Map());
    for (const [wordId, buf] of wordMap) {
      const key = `words/${speaker}/${wordId}.wav`;
      try {
        await putAndVerify(key, buf, 'audio/wav');
        verifiedWordAudioKey.get(speaker).set(wordId, key);
        uploadCount++;
      } catch (err) {
        console.warn(`  FAILED ${key}: ${err.message}`);
        failCount++;
      }
    }
  }
  for (const [speaker, syllableMap] of syllableAudioBySpeaker) {
    verifiedSyllableAudioKey.set(speaker, new Map());
    for (const [syllableText, buf] of syllableMap) {
      const key = `syllables/${speaker}/${safeName(syllableText, toneMap)}`;
      try {
        await putAndVerify(key, buf, 'audio/wav');
        verifiedSyllableAudioKey.get(speaker).set(syllableText, key);
        uploadCount++;
      } catch (err) {
        console.warn(`  FAILED ${key}: ${err.message}`);
        failCount++;
      }
    }
  }
  for (const [wordId, styleMap] of imagesByWord) {
    verifiedImageKey.set(wordId, new Map());
    for (const [style, buf] of styleMap) {
      const key = `images/${style}/${wordId}.png`;
      try {
        await putAndVerify(key, buf, 'image/png');
        verifiedImageKey.get(wordId).set(style, key);
        uploadCount++;
      } catch (err) {
        console.warn(`  FAILED ${key}: ${err.message}`);
        failCount++;
      }
    }
  }
  console.log(`      ${uploadCount} object(s) ${apply ? 'uploaded and verified' : 'would be uploaded'}, ${failCount} failed`);

  if (!apply) {
    // Dry run: sessions.json/vocab.json/syllables.json would only be
    // trustworthy if built from what's REALLY in the bucket after a real
    // upload - so a dry run stops here rather than writing manifests
    // that claim coverage nothing has actually verified yet.
    console.log('\nDry run only - no objects uploaded, no local manifest written. Pass --apply to publish for real.');
    await pool.end();
    return;
  }

  console.log('[4/6] Computing per-speaker/per-style coverage from what R2 just verified...');
  const speakers = [...new Set([...verifiedWordAudioKey.keys(), ...verifiedSyllableAudioKey.keys()])].sort();
  const coveredWordsBySpeaker = new Map();
  for (const speaker of speakers) {
    const wordAudio = verifiedWordAudioKey.get(speaker) ?? new Map();
    const syllableAudio = verifiedSyllableAudioKey.get(speaker) ?? new Map();
    const covered = [];
    for (const [wordId, entry] of Object.entries(vocab)) {
      if (!wordAudio.has(wordId)) continue;
      const allSyllablesCovered = entry.syllables.every((s) => syllableAudio.has(s));
      if (allSyllablesCovered) covered.push({ wordId, displayText: entry.displayText, syllables: entry.syllables });
    }
    coveredWordsBySpeaker.set(speaker, covered);
    console.log(`      ${speaker}: ${covered.length} / ${wordsResult.rows.length} words fully playable`);
  }

  console.log('[5/6] Building sessions.json (levels)...');
  const levels = [];
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
    }
  }
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

  console.log('[6/6] Writing vocab.json / syllables.json / sessions.json (local, small - still committed+deployed with app code)...');
  const publicDir = path.join(GAME_DIR, 'public');
  mkdirSync(publicDir, { recursive: true });

  const vocabOut = {};
  for (const [wordId, entry] of Object.entries(vocab)) {
    vocabOut[wordId] = {
      displayText: entry.displayText,
      syllables: entry.syllables,
      definition: entry.definition,
      imageStyles: [...(verifiedImageKey.get(wordId)?.keys() ?? [])],
    };
  }
  writeFileSync(path.join(publicDir, 'vocab.json'), JSON.stringify(vocabOut, null, 2));

  const syllablesOut = {};
  for (const speaker of speakers) {
    syllablesOut[speaker] = {};
    const syllableKeyMap = verifiedSyllableAudioKey.get(speaker) ?? new Map();
    for (const [syllableText, key] of syllableKeyMap) {
      syllablesOut[speaker][syllableText] = { audio: key, tone: toneOf(syllableText) };
    }
  }
  writeFileSync(path.join(publicDir, 'syllables.json'), JSON.stringify(syllablesOut, null, 2));
  writeFileSync(path.join(publicDir, 'sessions.json'), JSON.stringify(levels, null, 2));

  await pool.end();
  console.log('\nDone. Word/syllable audio keys are R2 object keys (e.g. "words/speaker2/eye_bird.wav") -');
  console.log('app.js\'s BASE_URL must point at the bucket\'s public URL for these to resolve.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
