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
//     node scripts/publishToR2.mjs [--apply] [--repo-dir=<path>] [--manifest-dir=<path>]
//
// Flags (note: `--flag=value` only - a space-separated `--flag value` is silently ignored):
//   --apply             actually upload and write manifests; without it, nothing is written anywhere
//   --repo-dir=         source of config.json (tone_map) and sessions_source.json
//   --manifest-dir=     where the three JSON manifests go; defaults to the REAL game
//   --game-dir=         legacy alias, means <game-dir>/public
//   --word=a,b          push only these words' audio and images
//   --speaker=name      push only this speaker's word and syllable audio
//   --style=name        push only this image style
//   --no-skip           re-upload even objects whose bytes already match
//   --prune             DELETE orphaned objects (refuses alongside any targeting flag)
//   --force             overwrite manifests written by the other producer
//   --strict-upstream   exit non-zero on Wiktionary citation drift instead of warning
//
// ---------------------------------------------------------------------------
// Three ways into the same three files, and why this one names its target
// ---------------------------------------------------------------------------
// vocab.json/syllables.json/sessions.json have more than one producer:
//
//   this script            bare R2 keys in syllables.json; no local media. For the deployed game.
//   exportGameContent.mjs  relative paths + media written locally. For running a game offline.
//   website-games/sync_dictionary_data.py   a third path that vendors them into the real game.
//
// The first two write identical filenames into one directory with incompatible contents, so whichever
// ran last silently decided which origin the game would ask for audio - and if that origin did not have
// the files, the only symptom was silence during play. Both now leave a .manifest-source.json marker and
// refuse to clobber the other's without --force.
//
// ---------------------------------------------------------------------------
// When to move to versioned keys
// ---------------------------------------------------------------------------
// Keys here are stable and content is replaced in place, which caps how long the edge may cache (see
// CACHE_CONTROL). Content-addressed keys - `words/{speaker}/{wordId}.{hash}.wav`, with the manifest
// naming the exact version - would make `immutable` safe, replacement instant, and stale objects
// harmless rather than wrong.
//
// That is deliberately not done yet, because today a published asset has exactly ONE possible
// derivation. Verified rather than assumed: raw_audio_data is byte-identical to audio_data for all 96
// utterances and all 193 segments, so 0008's raw/served split is currently a no-op; all three
// canonical_*_selections tables are empty; and there is nothing to select between anyway - the two takes
// per session are different artifacts by design (take 1 is the whole word, take 2 carries the syllable
// segments), and no word has more than one image variant per style.
//
// Adopt versioned keys when ANY of those stops being true:
//   * post-processing lands, so audio_data starts differing from raw_audio_data
//   * curated take/speaker selection lands, so the canonical_* tables are actually read
//   * a second consumer (a student-facing dictionary) needs a DIFFERENT derivation of one recording
// Each makes one logical asset have several legitimate byte-level versions, which is exactly when
// overwrite-in-place stops being adequate.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { reportUpstreamHealth } from './upstreamPublishCheck.mjs';
import { S3Client, PutObjectCommand, HeadObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
function argValue(flag, fallback) {
  const found = args.find((a) => a.startsWith(`--${flag}=`));
  return found ? found.slice(flag.length + 3) : fallback;
}
const REPO_DIR = path.resolve(process.cwd(), argValue('repo-dir', '../yoruba-student-dict'));

/** Where the three manifests are written - the directory itself, not a repo root.
 *
 * This used to be `--game-dir` with `/public` appended, defaulting to `../syllable_game_concept`. That
 * was an early proof of concept and is now an empty non-git directory holding `{}`/`[]` stubs, so a
 * default `--apply` run pushed media to R2 correctly and then wrote its manifests where nothing would
 * ever read them. The live game is `website-games/public/phonics`, whose layout does not have the
 * `<root>/public` shape the old flag assumed - hence naming the directory outright.
 *
 * `--game-dir` still works and still means `<game-dir>/public`, so any existing invocation is
 * unchanged. */
const MANIFEST_DIR = path.resolve(
  process.cwd(),
  argValue('manifest-dir', null) ??
    (argValue('game-dir', null) ? path.join(argValue('game-dir', ''), 'public') : '../website-games/public/phonics'),
);

/** How long a cache may serve these bytes.
 *
 * Audio was shipping with NO Cache-Control at all, so a player's own browser re-fetched every clip on
 * every play. This sets it. But read the next paragraph before assuming it fixed edge caching.
 *
 * ---------------------------------------------------------------------------
 * This header alone does NOT make Cloudflare cache the audio
 * ---------------------------------------------------------------------------
 * Measured on the live host, after setting exactly this header on a real object:
 *
 *     words/speaker2/aja_dog.wav    cache-control: public, max-age=86400, ...   cf-cache-status: DYNAMIC
 *     images/cartoon/aja_dog.png    cache-control: max-age=14400                cf-cache-status: HIT
 *
 * Same host, same moment, and the .wav has the BETTER header - yet only the .png is cached. Cloudflare
 * decides cache eligibility from its own default file-EXTENSION list before it ever looks at the
 * origin's header; .png is on that list and .wav is not. So an origin header cannot buy edge caching
 * for audio on its own.
 *
 * What this header DOES buy, and it is real: browsers honour it regardless of extension, so a returning
 * player - or a replay later the same day - serves from local disk instead of the network.
 *
 * To get EDGE caching (the part that matters for a first play by a player far from the bucket) a
 * Cloudflare **Cache Rule** on gamemedia.speaknigeria.org must mark these paths eligible for cache -
 * "Eligible for cache" with Edge TTL "use cache-control header". That lives in Cloudflare's dashboard,
 * not in this repo, and the R2 token here has no zone scope to set it. Until it exists, expect
 * cf-cache-status: DYNAMIC on every .wav no matter what this script sends.
 *
 * ---------------------------------------------------------------------------
 * A day, not `immutable`
 * ---------------------------------------------------------------------------
 * Keys here are STABLE and content is replaced IN PLACE (PutObject over the same key), so a long TTL
 * would pin superseded audio with no way to invalidate it short of a purge. stale-while-revalidate keeps
 * that from ever costing a player a wait: past 24h the cache serves the old clip immediately and
 * refreshes behind the request.
 *
 * The way out of that tradeoff is content-addressed keys, which would make `immutable` safe. That is
 * deliberately NOT done yet - see "When to move to versioned keys" in the header. */
const CACHE_CONTROL = 'public, max-age=86400, stale-while-revalidate=604800';

// --- targeting, for pushing one asset instead of the whole corpus ---
function argList(flag) {
  const found = args.filter((a) => a.startsWith(`--${flag}=`)).flatMap((a) => a.slice(flag.length + 3).split(','));
  return found.map((s) => s.trim()).filter(Boolean);
}
const onlyWords = new Set(argList('word'));
const onlySpeakers = new Set(argList('speaker'));
const onlyStyles = new Set(argList('style'));
const targeted = onlyWords.size > 0 || onlySpeakers.size > 0 || onlyStyles.size > 0;
const noSkip = args.includes('--no-skip');
const prune = args.includes('--prune');

let uploaded = 0;
let skipped = 0;

const wantsSpeaker = (speaker) => onlySpeakers.size === 0 || onlySpeakers.has(speaker);
const wantsWord = (wordId, speaker) =>
  (onlyWords.size === 0 || onlyWords.has(wordId)) && wantsSpeaker(speaker) && onlyStyles.size === 0;
const wantsImage = (wordId, style) =>
  (onlyWords.size === 0 || onlyWords.has(wordId)) &&
  (onlyStyles.size === 0 || onlyStyles.has(style)) &&
  onlySpeakers.size === 0;

/** The three manifests have TWO producers that disagree about what `syllables.json`'s `audio` means.
 *
 * publishToR2 writes a bare R2 object key ("syllables/speaker2/ba.wav") and the game prepends its
 * BASE_URL, so the bytes come from the bucket. exportGameContent writes a RELATIVE path and also writes
 * the media locally, so the bytes come same-origin. Both are correct for their own target and both write
 * the same filenames into the same directory, so running one after the other left the game pointing at
 * an origin that does not serve those files - silently, with no error anywhere.
 *
 * A marker file next to the manifests records who wrote them. Mismatched producer means stop, because
 * the failure mode being prevented is invisible at publish time and only shows up as missing audio for
 * a player. --force is the deliberate override for genuinely switching a directory's target. */
const MANIFEST_MARKER = '.manifest-source.json';
const PRODUCER = { producer: 'publishToR2.mjs', assetBase: 'r2' };

function assertManifestOwnership(dir) {
  const markerPath = path.join(dir, MANIFEST_MARKER);
  if (existsSync(markerPath)) {
    try {
      const prior = JSON.parse(readFileSync(markerPath, 'utf8'));
      if (prior.assetBase && prior.assetBase !== PRODUCER.assetBase && !args.includes('--force')) {
        console.error(
          `\nRefusing to overwrite manifests in ${dir}.\n` +
            `  They were written by ${prior.producer ?? 'an unknown script'} with assetBase="${prior.assetBase}",\n` +
            `  and this script writes assetBase="${PRODUCER.assetBase}" (bare R2 keys). Mixing the two points the\n` +
            `  game at an origin that does not serve its audio. Pass --force if you really mean to switch this\n` +
            `  directory over.`,
        );
        process.exit(1);
      }
    } catch {
      // An unreadable marker is not a reason to block a publish; treat it as absent.
    }
  }
  writeFileSync(markerPath, `${JSON.stringify({ ...PRODUCER, generatedAt: new Date().toISOString() }, null, 2)}\n`);
}

/** Lists what is in the bucket and reports what nothing references any more.
 *
 * Report-only unless --prune, because this tooling previously could not remove an object at ALL:
 * DeleteObject was never even imported, so every deleted word, re-spelling, re-syllabification and
 * renamed speaker left its bytes behind - unreferenced by the manifests, yet still publicly fetchable
 * at a guessable URL. The bucket could only ever grow.
 *
 * --prune deliberately refuses to run alongside targeting. `expectedKeys` is built from the whole
 * corpus regardless of filters for exactly this reason, but a filtered run is also a run where the
 * operator is thinking about one word, which is the wrong frame for a bulk delete. */
async function reportOrphans(s3, bucket, expectedKeys) {
  const found = [];
  for (const prefix of ['words/', 'syllables/', 'images/']) {
    let token;
    do {
      const page = await s3.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const obj of page.Contents ?? []) if (!expectedKeys.has(obj.Key)) found.push(obj.Key);
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }

  if (found.length === 0) {
    console.log(`      no orphaned objects - the bucket matches the ${expectedKeys.size} expected keys`);
    return;
  }
  console.log(`      ${found.length} ORPHANED object(s) - present in the bucket, referenced by nothing:`);
  for (const key of found.slice(0, 20)) console.log(`        ${key}`);
  if (found.length > 20) console.log(`        ... and ${found.length - 20} more`);

  if (!prune) {
    console.log('      (report only - pass --prune to delete them)');
    return;
  }
  if (targeted) {
    console.log('      REFUSING to prune: --prune cannot be combined with --word/--speaker/--style.');
    return;
  }
  if (!apply) {
    console.log('      (dry run - would delete the above; add --apply)');
    return;
  }
  for (let i = 0; i < found.length; i += 1000) {
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: found.slice(i, i + 1000).map((Key) => ({ Key })) },
      }),
    );
  }
  console.log(`      deleted ${found.length} orphaned object(s)`);
}

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

  /** Uploads one object unless the bucket already holds exactly these bytes, then verifies it.
   *
   * The HeadObject-after-Put is the load-bearing part and predates the rest: coverage is computed only
   * from keys this function RETURNED, so sessions.json can never claim a speaker is valid for content
   * that is not really in the bucket. See the header.
   *
   * The HeadObject-BEFORE-Put is the new part, and it is what makes a full republish cheap enough to
   * stay the default - which matters because the manifests can only be trusted when built from a whole
   * -corpus pass. R2 returns a plain MD5 as the ETag for a non-multipart object (verified against a
   * live object before relying on it), so an unchanged asset is detectable without downloading it.
   * Anything unexpected in that comparison falls through to uploading, because a needless upload is
   * harmless and a skipped changed asset is not.
   */
  async function putAndVerify(key, buffer, contentType) {
    if (!apply) return key;

    if (!noSkip) {
      const local = createHash('md5').update(buffer).digest('hex');
      try {
        const head = await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
        const remote = (head.ETag ?? '').replace(/"/g, '');
        // A multipart ETag looks like "<md5>-<partcount>" and cannot be compared this way; the
        // length check rejects it along with anything else unexpected.
        if (remote.length === 32 && remote === local) {
          skipped += 1;
          return key;
        }
      } catch (err) {
        // Not found is the normal first-publish case. Anything else is also non-fatal here - it just
        // means "cannot prove it is unchanged", and the upload below settles it.
        if (err?.name !== 'NotFound' && err?.$metadata?.httpStatusCode !== 404) {
          console.warn(`    (could not compare ${key}: ${err.message} - uploading anyway)`);
        }
      }
    }

    await s3.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
        Body: buffer,
        ContentType: contentType,
        CacheControl: CACHE_CONTROL,
      }),
    );
    await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
    uploaded += 1;
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

  // Before anything is written or uploaded: say how much of what is about to
  // ship still matches the Wiktionary etymologies it cites. Warns by default -
  // see upstreamPublishCheck.mjs for why drift is a review signal rather than a
  // reason to withhold human-validated content.
  console.log('[0] Checking upstream citations...');
  const upstream = await reportUpstreamHealth(pool, { strict: process.argv.includes('--strict-upstream') });
  if (!upstream.ok) {
    await pool.end();
    process.exit(1);
  }

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

  // Only a recording whose OWN recorded_display_text/recorded_syllables
  // still matches golden_record's CURRENT canonical values is a valid
  // pronunciation for the game - a word's spelling/tone can be revised
  // by a curator (word_decisions' spelling axis) after it was recorded,
  // and a stale recording must never be silently served as if it were
  // the current canonical pronunciation. Same "verify against CURRENT
  // golden_record, not whatever was true at recording time" discipline
  // this script already applies to syllable coverage (see this file's
  // header) - now applied to the word-level clip itself too, closing a
  // real gap (confirmed: 0/96 live recordings actually diverge today,
  // but nothing previously checked for it).
  const wordAudioResult = await pool.query(
    `select u.word_id, u.speaker_id, u.audio_data
     from utterances u
     join golden_record w on w.word_id = u.word_id
     where u.take_number = 1
       and u.audio_data is not null
       and u.recorded_display_text = w.display_text
       and u.recorded_syllables = w.syllables`,
  );
  const staleCountResult = await pool.query(
    `select count(*)::int as n
     from utterances u
     join golden_record w on w.word_id = u.word_id
     where u.take_number = 1
       and u.audio_data is not null
       and (u.recorded_display_text != w.display_text or u.recorded_syllables != w.syllables)`,
  );
  if (staleCountResult.rows[0].n > 0) {
    console.warn(
      `      ${staleCountResult.rows[0].n} take-1 recording(s) EXCLUDED: recorded pronunciation no longer matches golden_record (word re-spelled since recording - needs re-recording)`,
    );
  }
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
    // NFC, because the game looks a syllable up BY STRING: it takes the syllable out of vocab.json and
    // indexes syllables.json with it. Stored text is not consistently normalised, and an NFD `ọ`
    // (o + U+0323) is a different key from an NFC `ọ` (U+1ECD) even though they are the same letter - so
    // the lookup missed and the button fell silent while the audio sat in the bucket. Live at the time
    // this was written: `oba_king` and `ose_soap` for speaker1 and speaker2.
    //
    // It also de-duplicates deliberately. safeName() strips combining marks, so both forms already
    // produced the SAME R2 filename - two rows were silently overwriting one object, which is why the
    // upload count exceeded the number of distinct keys by exactly one.
    const syllableText = row.syllable_text.normalize('NFC');
    if (!map.has(syllableText)) map.set(syllableText, row.audio_data);
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

  // The full set of keys this corpus SHOULD have, recorded whether or not targeting skips them.
  // Needed by the orphan report, which must diff against the whole expectation - an orphan list built
  // from a filtered expectation would call live assets orphans.
  const expectedKeys = new Set();

  for (const [speaker, wordMap] of wordAudioBySpeaker) {
    verifiedWordAudioKey.set(speaker, new Map());
    for (const [wordId, buf] of wordMap) {
      const key = `words/${speaker}/${wordId}.wav`;
      expectedKeys.add(key);
      if (!wantsWord(wordId, speaker)) continue;
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
      expectedKeys.add(key);
      // Syllables are not word-scoped, so --word cannot select among them; only --speaker applies.
      if (!wantsSpeaker(speaker) || onlyWords.size > 0 || onlyStyles.size > 0) continue;
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
      expectedKeys.add(key);
      if (!wantsImage(wordId, style)) continue;
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
  if (apply) {
    console.log(`      ${uploaded} uploaded, ${skipped} already identical (skipped), ${failCount} failed`);
  } else {
    console.log(`      ${uploadCount} object(s) would be uploaded, ${failCount} failed`);
  }

  await reportOrphans(s3, R2_BUCKET_NAME, expectedKeys);

  if (!apply) {
    // Dry run: sessions.json/vocab.json/syllables.json would only be
    // trustworthy if built from what's REALLY in the bucket after a real
    // upload - so a dry run stops here rather than writing manifests
    // that claim coverage nothing has actually verified yet.
    console.log('\nDry run only - no objects uploaded, no local manifest written. Pass --apply to publish for real.');
    await pool.end();
    return;
  }

  if (targeted) {
    // Same reasoning as the dry run above, and it is the reason targeting is safe to offer at all.
    // Coverage is computed from the keys THIS RUN verified, so a filtered run has verified only a
    // fraction of them - writing manifests from that would mark every unvisited speaker/word as
    // uncovered and silently drop them from every level. That is precisely the class of bug the
    // verify-in-the-same-run design was introduced to kill (3/8 levels once shipped with zero valid
    // speakers), so a filtered run pushes bytes and refuses to touch the manifests.
    console.log(
      '\nTargeted run - media pushed, manifests deliberately NOT written.\n' +
        '  vocab/syllables/sessions.json are computed from the keys verified in THIS run, so writing them\n' +
        '  now would drop every word this run did not visit. Re-run without --word/--speaker/--style to\n' +
        '  regenerate them.',
    );
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
      if (!allSyllablesCovered) continue;
      // A word with no real image must never be presented with a
      // placeholder standing in for it - that's fabricated content, not
      // a graceful degrade. Image coverage is a hard gate here, same as
      // audio, not optional metadata (see conversation: this was
      // previously NOT gated, and app.js silently substituted a
      // placeholder graphic for any word missing art).
      if (!verifiedImageKey.get(wordId)?.size) continue;
      covered.push({ wordId, displayText: entry.displayText, syllables: entry.syllables });
    }
    coveredWordsBySpeaker.set(speaker, covered);
    console.log(`      ${speaker}: ${covered.length} / ${wordsResult.rows.length} words fully playable (audio + image)`);
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
  const publicDir = MANIFEST_DIR;
  mkdirSync(publicDir, { recursive: true });
  assertManifestOwnership(publicDir);

  const vocabOut = {};
  for (const [wordId, entry] of Object.entries(vocab)) {
    vocabOut[wordId] = {
      displayText: entry.displayText,
      // NFC for the same reason as the syllables.json keys above - these two lists are joined BY STRING
      // by the game, so they have to agree on encoding or the audio is unreachable.
      syllables: entry.syllables.map((s) => s.normalize('NFC')),
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
