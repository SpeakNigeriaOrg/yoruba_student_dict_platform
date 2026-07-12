// migrateSpeaker1And2.mjs
//
// One-off script: registers yoruba-student-dict/content/staged/{words,
// syllables}/{speaker1,speaker2}/ recordings into this platform's real
// utterances/syllable_observations tables. (content/staged/.../speaker3
// is deliberately NOT handled here - it reproduces what
// migrateLegacyAudio.mjs already uploaded, just renamed for the old
// game's storage-blob naming convention.)
//
// Unlike speaker3 (one source recording containing both a natural
// pronunciation and enunciated syllables, later auto-sliced),
// speaker1/speaker2's individual syllable recordings were made in a
// completely separate recording session from any particular word - a
// genuinely decoupled syllable pronunciation library, shared across
// whichever words happen to use that exact syllable. Word-level
// recordings (content/staged/words/{speaker}/{word_id}.wav) are named by
// word_id directly, so those link back trivially; the syllable
// recordings need real resolution work, done here rather than guessed:
//
//   1. Syllable identity from filename: content/staged/syllables/ files
//      are named via yoruba-student-dict/scripts/generate_syllables.py's
//      generate_syllable_info() scheme (tone suffix _high/_low from
//      HIGH_TONE_CHARS/LOW_TONE_CHARS, then config.json's tone_map
//      character substitution, longest key first). Reimplemented here
//      (safeName()) and used to FORWARD-compute the expected filename
//      for every syllable actually used across yoruba-student-dict's own
//      public/vocab.json (92 words, already confirmed to match
//      golden_record exactly) - matching against real staged filenames
//      this way is exact, not a guess. Verified zero real collisions
//      (one apparent one, 'oh.wav', was just two Unicode encodings of
//      the same "ọ" character - resolved by NFC normalization same as
//      generate_syllable_info.py itself does).
//   2. Host-word selection: many resolved syllables are used by more
//      than one of the 92 words (esp. common vowels - "e", "i", "o",
//      "a"). Since the schema's syllable_observations still needs ONE
//      parent word_id (utterances.word_id is NOT NULL), a candidate word
//      is only eligible to host a given speaker's syllable recording if
//      that SAME speaker also has their own word-level recording
//      (content/staged/words/{speaker}/{word_id}.wav) for it - i.e.
//      real, independent evidence this speaker actually engaged with
//      that word. (First version of this script picked the
//      alphabetically-first candidate regardless of whether the speaker
//      had ever recorded it at all - wrong: it attributed syllables to
//      words a speaker never touched, e.g. speaker2's "e" syllable
//      landing on "ejika_shoulder" even though speaker2 never recorded
//      "ejika" itself.) Among the still-eligible candidates (after that
//      filter), ties are broken alphabetically and logged for audit. If
//      NO candidate is eligible - the speaker has no word-level
//      recording for any word using that syllable - the file is skipped
//      and logged, not force-attached to an arbitrary word.
//   3. Unmatched files: syllable recordings that don't correspond to any
//      syllable used by the current 92-word vocab at all (confirmed via
//      public/syllables.json, the generated master list for the CURRENT
//      vocab - these files aren't in it either) - almost certainly
//      leftover recordings from a larger/older vocab. Skipped and
//      logged, not guessed at.
//
// Take-number mapping:
//   - take 1 = the word-level recording (content/staged/words/...), if
//     one exists for that word/speaker - natural pronunciation, no
//     segments, same meaning as the live app's "recording 1."
//   - take 2 = a container (own audio_data left null, same as
//     migrateLegacyAudio.mjs's take 2) holding segments ONLY for
//     whichever syllable(s) this word was picked as host for - may be 0
//     (word has no take 2 at all), 1, or more, and is NOT expected to
//     cover the word's full syllable count (most positions are hosted by
//     some other word instead). This is a deliberate, real difference
//     from the live two-take protocol's take 2, where segments always
//     cover every syllable of THAT SAME recording.
//
// Safety: dry run by default (runs the full transaction, then rolls
// back). Pass --apply to commit. Idempotent either way - reruns upsert
// the same (word_id, speaker_id, take_number) rows rather than
// duplicating.
//
// Usage:
//   DATABASE_URL=postgres://... node scripts/migrateSpeaker1And2.mjs [--apply] [--repo-dir=<path>]

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { orthographyInsensitiveForm, toneInsensitiveForm } from '@yoruba-student-dict-platform/shared';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const repoDirArg = args.find((a) => a.startsWith('--repo-dir='));
const REPO_DIR = repoDirArg ? repoDirArg.slice('--repo-dir='.length) : path.resolve(process.cwd(), '../yoruba-student-dict');

const SPEAKERS = ['speaker1', 'speaker2'];

const HIGH_TONE_CHARS = ['á', 'é', 'ẹ́', 'í', 'ó', 'ọ́', 'ú', 'ń'];
const LOW_TONE_CHARS = ['à', 'è', 'ẹ̀', 'ì', 'ò', 'ọ̀', 'ù', 'ǹ'];

// Unicode combining diacritical marks block is U+0300-U+036F - checked
// via numeric codepoint comparison rather than a regex character class,
// since combining characters typed directly into a regex literal are
// fragile (they visually attach to whatever precedes them in an
// editor/diff, easy to get subtly wrong without noticing).
function stripCombiningMarks(s) {
  return Array.from(s)
    .filter((ch) => {
      const code = ch.codePointAt(0);
      return !(code >= 0x300 && code <= 0x36f);
    })
    .join('');
}

// Ports yoruba-student-dict/scripts/generate_syllables.py's
// generate_syllable_info() exactly - see this file's header.
function safeName(syllable, toneMap) {
  const normalized = syllable.normalize('NFC').toLowerCase();
  let suffix = '';
  if (HIGH_TONE_CHARS.some((c) => normalized.includes(c))) suffix = '_high';
  else if (LOW_TONE_CHARS.some((c) => normalized.includes(c))) suffix = '_low';

  let safe = normalized;
  const keysLongestFirst = Object.keys(toneMap).sort((a, b) => b.length - a.length);
  for (const key of keysLongestFirst) {
    safe = safe.split(key).join(toneMap[key]);
  }
  // Strip any remaining combining marks - same "bulletproof" pass the
  // Python original does.
  safe = stripCombiningMarks(safe.normalize('NFD')).normalize('NFC');

  return `${safe}${suffix}.wav`;
}

function parseWav(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let offset = 12;
  let sampleRate = null;
  let bitsPerSample = null;
  let channels = null;
  let dataStart = null;
  let dataSize = null;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    if (chunkId === 'fmt ') {
      channels = buffer.readUInt16LE(bodyStart + 2);
      sampleRate = buffer.readUInt32LE(bodyStart + 4);
      bitsPerSample = buffer.readUInt16LE(bodyStart + 14);
    } else if (chunkId === 'data') {
      dataStart = bodyStart;
      dataSize = chunkSize;
    }
    offset = bodyStart + chunkSize + (chunkSize % 2);
  }
  if (sampleRate === null || dataStart === null) throw new Error('missing fmt or data chunk');
  const bytesPerSample = bitsPerSample / 8;
  const durationS = dataSize / (sampleRate * channels * bytesPerSample);
  return { sampleRate, durationS };
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const vocab = JSON.parse(readFileSync(path.join(REPO_DIR, 'public/vocab.json'), 'utf8'));
  const toneMap = JSON.parse(readFileSync(path.join(REPO_DIR, 'config.json'), 'utf8')).tone_map;
  console.log(`Loaded ${Object.keys(vocab).length} vocab entries from ${REPO_DIR}/public/vocab.json`);
  console.log(APPLY ? 'Mode: APPLY (will commit)' : 'Mode: DRY RUN (will roll back at the end)');

  // filename -> [{ wordId, position, syllableText }] across the whole vocab.
  const filenameToCandidates = new Map();
  for (const [wordId, info] of Object.entries(vocab)) {
    info.syllables.forEach((syllable, position) => {
      const normalized = syllable.normalize('NFC');
      const fname = safeName(normalized, toneMap);
      const list = filenameToCandidates.get(fname) ?? [];
      list.push({ wordId, position, syllableText: normalized });
      filenameToCandidates.set(fname, list);
    });
  }

  const client = new pg.Client({ connectionString });
  await client.connect();

  let wordTakesRegistered = 0;
  let syllableFilesMatched = 0;
  let syllableFilesUnmatched = 0;
  let syllableFilesNoEligibleHost = 0;
  let multiCandidateDecisions = 0;

  try {
    await client.query('begin');

    const speakerIds = {};
    for (const speaker of SPEAKERS) {
      const existing = await client.query('select speaker_id from speakers where display_name = $1', [speaker]);
      if (existing.rows[0]) {
        speakerIds[speaker] = existing.rows[0].speaker_id;
        console.log(`Reusing existing speaker '${speaker}' (${speakerIds[speaker]})`);
      } else {
        const inserted = await client.query('insert into speakers (display_name) values ($1) returning speaker_id', [speaker]);
        speakerIds[speaker] = inserted.rows[0].speaker_id;
        console.log(`Created speaker '${speaker}' (${speakerIds[speaker]})`);
      }
    }

    for (const speaker of SPEAKERS) {
      const speakerId = speakerIds[speaker];
      console.log(`\n=== ${speaker} ===`);

      // --- Word-level recordings (take 1) ---
      const wordsDir = path.join(REPO_DIR, 'content/staged/words', speaker);
      const recordedWordIds = new Set();
      for (const filename of readdirSync(wordsDir)) {
        const wordId = filename.replace(/\.wav$/, '');
        const vocabEntry = vocab[wordId];
        if (!vocabEntry) {
          console.warn(`SKIP word recording ${speaker}/${filename}: '${wordId}' not in vocab.json`);
          continue;
        }
        recordedWordIds.add(wordId);
        const audioBytes = readFileSync(path.join(wordsDir, filename));
        const wav = parseWav(audioBytes);

        const blobPath = `utterances/${wordId}/${speakerId}/take1.wav`;
        const rawBlobPath = `utterances/${wordId}/${speakerId}/take1-raw.wav`;
        const result = await client.query(
          `insert into utterances (word_id, speaker_id, take_number, blob_path, raw_blob_path, duration_s, sample_rate,
                                    status, audio_data, raw_audio_data, recorded_display_text, recorded_syllables)
           values ($1, $2, 1, $3, $4, $5, $6, 'pending_processing', $7, $7, $8, $9)
           on conflict (word_id, speaker_id, take_number) do update set
             blob_path = excluded.blob_path, raw_blob_path = excluded.raw_blob_path,
             duration_s = excluded.duration_s, sample_rate = excluded.sample_rate,
             audio_data = excluded.audio_data, raw_audio_data = excluded.raw_audio_data,
             recorded_display_text = excluded.recorded_display_text, recorded_syllables = excluded.recorded_syllables,
             recorded_at = now()
           returning utterance_id`,
          [wordId, speakerId, blobPath, rawBlobPath, wav.durationS, wav.sampleRate, audioBytes, vocabEntry.displayText, vocabEntry.syllables],
        );
        wordTakesRegistered++;
        console.log(`OK word ${wordId}: take1 ${result.rows[0].utterance_id}`);
      }

      // --- Syllable-level recordings (take 2, decoupled) ---
      const syllablesDir = path.join(REPO_DIR, 'content/staged/syllables', speaker);
      // hostWordId -> [{ position, syllableText, audioBytes, sourceFilename }]
      const segmentsByHost = new Map();

      for (const filename of readdirSync(syllablesDir)) {
        const candidates = filenameToCandidates.get(filename);
        if (!candidates) {
          console.warn(`SKIP syllable recording ${speaker}/${filename}: doesn't match any syllable in the current vocab`);
          syllableFilesUnmatched++;
          continue;
        }

        const distinctWordIds = [...new Set(candidates.map((c) => c.wordId))].sort();
        // Only a word this SAME speaker has their own word-level
        // recording for is eligible to host their syllable recording -
        // real independent evidence of engagement, not just "some word
        // in the vocab happens to use this syllable" (see file header).
        const eligibleWordIds = distinctWordIds.filter((id) => recordedWordIds.has(id));
        if (eligibleWordIds.length === 0) {
          console.warn(
            `SKIP syllable recording ${speaker}/${filename}: no eligible host - ${speaker} has no word-level ` +
              `recording for any of [${distinctWordIds.join(', ')}]`,
          );
          syllableFilesNoEligibleHost++;
          continue;
        }
        syllableFilesMatched++;

        const hostWordId = eligibleWordIds[0];
        if (eligibleWordIds.length > 1) {
          multiCandidateDecisions++;
          console.log(
            `MULTI-CANDIDATE ${filename}: picked '${hostWordId}' among eligible [${eligibleWordIds.join(', ')}] ` +
              `(full candidate list: [${distinctWordIds.join(', ')}])`,
          );
        }

        // Among this host's own occurrences of the syllable, take the
        // lowest position - only one physical recording exists, so a
        // repeated-syllable word (e.g. "kò" twice in "ìkòkò") just
        // attaches it to its first occurrence.
        const hostOccurrences = candidates.filter((c) => c.wordId === hostWordId).sort((a, b) => a.position - b.position);
        const { position, syllableText } = hostOccurrences[0];

        const audioBytes = readFileSync(path.join(syllablesDir, filename));
        const list = segmentsByHost.get(hostWordId) ?? [];
        list.push({ position, syllableText, audioBytes, sourceFilename: filename });
        segmentsByHost.set(hostWordId, list);
      }

      for (const [wordId, segments] of segmentsByHost) {
        const vocabEntry = vocab[wordId];
        const blobPath = `utterances/${wordId}/${speakerId}/take2.wav`;
        const utteranceResult = await client.query(
          `insert into utterances (word_id, speaker_id, take_number, blob_path, status, recorded_display_text, recorded_syllables)
           values ($1, $2, 2, $3, 'segmented', $4, $5)
           on conflict (word_id, speaker_id, take_number) do update set
             blob_path = excluded.blob_path, status = excluded.status,
             recorded_display_text = excluded.recorded_display_text, recorded_syllables = excluded.recorded_syllables,
             recorded_at = now()
           returning utterance_id`,
          [wordId, speakerId, blobPath, vocabEntry.displayText, vocabEntry.syllables],
        );
        const utteranceId = utteranceResult.rows[0].utterance_id;

        await client.query('delete from syllable_observations where utterance_id = $1', [utteranceId]);
        for (const segment of segments) {
          const wav = parseWav(segment.audioBytes);
          const segmentBlobPath = `utterances/${wordId}/${speakerId}/take2/syllable${segment.position}.wav`;
          const segmentRawBlobPath = `utterances/${wordId}/${speakerId}/take2/syllable${segment.position}-raw.wav`;
          const toneInsensitive = toneInsensitiveForm(segment.syllableText);
          const orthographyInsensitive = orthographyInsensitiveForm(segment.syllableText);
          await client.query(
            `insert into syllable_observations
               (utterance_id, syllable_position, syllable_text, syllable_tone_insensitive, syllable_orthography_insensitive,
                legacy_syllable_key, start_time_s, end_time_s, vad_confidence, blob_path, audio_data,
                raw_blob_path, raw_audio_data)
             values ($1, $2, $3, $4, $5, $5, 0, $6, null, $7, $8, $9, $8)`,
            [
              utteranceId,
              segment.position,
              segment.syllableText,
              toneInsensitive,
              orthographyInsensitive,
              wav.durationS,
              segmentBlobPath,
              segment.audioBytes,
              segmentRawBlobPath,
            ],
          );
        }
        console.log(
          `OK syllable-host ${wordId}: take2 ${utteranceId} (${segments.length} segment(s): ${segments.map((s) => s.sourceFilename).join(', ')})`,
        );
      }
    }

    console.log(
      `\nSummary: ${wordTakesRegistered} word take1(s) registered, ${syllableFilesMatched} syllable file(s) matched ` +
        `to an eligible host (${multiCandidateDecisions} needed a multi-candidate pick among eligible words), ` +
        `${syllableFilesNoEligibleHost} skipped (no eligible host - speaker never recorded any candidate word), ` +
        `${syllableFilesUnmatched} skipped (unmatched - not a syllable in the current vocab at all).`,
    );

    if (APPLY) {
      await client.query('commit');
      console.log('\nCommitted.');
    } else {
      await client.query('rollback');
      console.log('\nDry run complete (rolled back). Re-run with --apply to commit.');
    }
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
