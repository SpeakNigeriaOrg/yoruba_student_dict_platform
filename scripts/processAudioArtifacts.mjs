#!/usr/bin/env node
// Batch raw native recordings into trusted game WAV artifacts. Requires ffmpeg + ffprobe in PATH.
// Raw bytes are never changed. Each output is content-addressed, measured, and traceable to a run.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';

const exec = promisify(execFile);
const APPLY = process.argv.includes('--apply');
const PROFILE = 'game-pcm-v1';
const PROCESSOR = 'ffmpeg';
const PROCESSOR_VERSION = '1';
const MAX_SOURCE_BYTES = 15 * 1024 * 1024;
const MAX_DURATION_S = 120;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function sourceMedia(format = '') {
  if (format.split(',').includes('wav')) return { container: 'wav', mediaType: 'audio/wav' };
  if (format.includes('webm') || format.includes('matroska')) return { container: 'webm', mediaType: 'audio/webm' };
  if (format.includes('ogg')) return { container: 'ogg', mediaType: 'audio/ogg' };
  if (['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2'].some((name) => format.split(',').includes(name))) {
    return { container: 'mp4', mediaType: 'audio/mp4' };
  }
  return { container: null, mediaType: null };
}

async function toolVersion(tool) {
  const { stdout } = await exec(tool, ['-version'], { maxBuffer: 1024 * 1024 });
  return stdout.split('\n')[0];
}

async function inspect(file) {
  const { stdout } = await exec('ffprobe', [
    '-v', 'error', '-show_entries', 'format=format_name,duration:stream=codec_type,codec_name,sample_rate,channels',
    '-of', 'json', file,
  ], { maxBuffer: 1024 * 1024 });
  const data = JSON.parse(stdout);
  const streams = data.streams ?? [];
  const audio = streams.filter((stream) => stream.codec_type === 'audio');
  if (audio.length !== 1 || streams.some((stream) => stream.codec_type !== 'audio')) {
    throw new Error('source must contain exactly one audio stream and no other streams');
  }
  const duration = Number(data.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_DURATION_S) {
    throw new Error(`source duration must be between 0 and ${MAX_DURATION_S} seconds`);
  }
  return { format: data.format?.format_name, duration, stream: audio[0] };
}

async function transcode(source, destination) {
  await exec('ffmpeg', [
    '-nostdin', '-v', 'error', '-y', '-i', source, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '48000',
    '-af', 'silenceremove=start_periods=1:start_duration=0.03:start_threshold=-50dB:stop_periods=-1:stop_duration=0.08:stop_threshold=-50dB,loudnorm=I=-20:TP=-2:LRA=7',
    '-c:a', 'pcm_s16le', destination,
  ], { maxBuffer: 4 * 1024 * 1024 });
  return inspect(destination);
}

async function sources(client) {
  const { rows } = await client.query(`
    select 'utterance' as source_kind, u.utterance_id as source_id, u.speaker_id,
           null::text as syllable_text, u.raw_audio_data as bytes, u.raw_media_type,
           a.source_sha256 as processed_source_sha256
      from utterances u
      left join lateral (select source_sha256 from audio_artifacts
        where utterance_id=u.utterance_id and profile=$1 order by created_at desc limit 1) a on true
     where u.take_number = 1 and u.raw_audio_data is not null
    union all
    select 'observation', so.observation_id, u.speaker_id, so.syllable_text,
           so.raw_audio_data, so.raw_media_type, a.source_sha256
      from syllable_observations so join utterances u on u.utterance_id = so.utterance_id
      left join lateral (select source_sha256 from audio_artifacts
        where observation_id=so.observation_id and profile=$1 order by created_at desc limit 1) a on true
     where so.raw_audio_data is not null
    order by source_kind, source_id`, [PROFILE]);
  return rows.filter((row) => sha256(row.bytes) !== row.processed_source_sha256);
}

// Artifacts created before source metadata reconciliation still carry the verified source hash
// and ffprobe manifest. Backfill only when that hash matches the raw bytes currently stored, so
// an artifact from an earlier recording can never make a re-recording look current.
async function reconcileProcessedMetadata(client) {
  const reconcile = async (table, idColumn, artifactIdColumn) => client.query(`
    with latest as (
      select distinct on (${artifactIdColumn}) ${artifactIdColumn} as source_id, source_sha256,
             manifest->'source'->>'format' as source_format
        from audio_artifacts
       where ${artifactIdColumn} is not null and profile=$1
       order by ${artifactIdColumn}, created_at desc
    )
    update ${table} source
       set raw_sha256 = latest.source_sha256,
           raw_container = coalesce(source.raw_container, case
             when latest.source_format = 'wav' then 'wav'
             when latest.source_format like '%webm%' or latest.source_format like '%matroska%' then 'webm'
             when latest.source_format like '%ogg%' then 'ogg'
             when latest.source_format ~ '(^|,)(mov|mp4|m4a|3gp|3g2|mj2)(,|$)' then 'mp4'
           end),
           raw_media_type = coalesce(source.raw_media_type, case
             when latest.source_format = 'wav' then 'audio/wav'
             when latest.source_format like '%webm%' or latest.source_format like '%matroska%' then 'audio/webm'
             when latest.source_format like '%ogg%' then 'audio/ogg'
             when latest.source_format ~ '(^|,)(mov|mp4|m4a|3gp|3g2|mj2)(,|$)' then 'audio/mp4'
           end)
      from latest
     where source.${idColumn} = latest.source_id
       and encode(digest(source.raw_audio_data, 'sha256'), 'hex') = latest.source_sha256
       and (source.raw_sha256 is distinct from latest.source_sha256
         or source.raw_container is null or source.raw_media_type is null)`, [PROFILE]);
  const utterances = await reconcile('utterances', 'utterance_id', 'utterance_id');
  const observations = await reconcile('syllable_observations', 'observation_id', 'observation_id');
  if (utterances.rowCount + observations.rowCount > 0) {
    console.log(`Reconciled source metadata for ${utterances.rowCount + observations.rowCount} processed legacy row(s)`);
  }
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const versions = { ffmpeg: await toolVersion('ffmpeg'), ffprobe: await toolVersion('ffprobe') };
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const temp = await mkdtemp(path.join(tmpdir(), 'yoruba-audio-'));
  let runId;
  try {
    if (APPLY) await reconcileProcessedMetadata(client);
    const pending = await sources(client);
    console.log(`${pending.length} raw source(s) need ${PROFILE}; mode=${APPLY ? 'apply' : 'preview'}`);
    if (!APPLY) return;
    const run = await client.query(`insert into audio_processing_runs
      (processor, processor_version, profile, config) values ($1,$2,$3,$4) returning run_id`,
      [PROCESSOR, PROCESSOR_VERSION, PROFILE, { versions, sampleRate: 48000, channels: 1, codec: 'pcm_s16le' }]);
    runId = run.rows[0].run_id;
    for (const source of pending) {
      const job = await client.query(`insert into audio_processing_jobs
        (run_id, utterance_id, observation_id, status, attempts, claimed_at)
        values ($1,$2,$3,'running',1,now()) returning job_id`,
        [runId, source.source_kind === 'utterance' ? source.source_id : null,
          source.source_kind === 'observation' ? source.source_id : null]);
      const jobId = job.rows[0].job_id;
      try {
        if (source.bytes.length > MAX_SOURCE_BYTES) throw new Error('source exceeds 15 MB');
        const input = path.join(temp, `${jobId}.input`);
        const output = path.join(temp, `${jobId}.wav`);
        await writeFile(input, source.bytes);
        const sourceInfo = await inspect(input);
        const sourceMetadata = sourceMedia(sourceInfo.format);
        const outputInfo = await transcode(input, output);
        const artifact = await readFile(output);
        const purpose = source.source_kind === 'utterance' ? 'game_word' : 'game_syllable';
        const manifest = { source: sourceInfo, output: outputInfo, versions, profile: PROFILE };
        await client.query('begin');
        const inserted = await client.query(`insert into audio_artifacts
          (job_id, utterance_id, observation_id, purpose, profile, source_sha256, artifact_sha256,
           audio_data, media_type, sample_rate, duration_s, manifest)
          values ($1,$2,$3,$4,$5,$6,$7,$8,'audio/wav',48000,$9,$10) returning artifact_id`, [
          jobId, source.source_kind === 'utterance' ? source.source_id : null,
          source.source_kind === 'observation' ? source.source_id : null, purpose, PROFILE,
          sha256(source.bytes), sha256(artifact), artifact, outputInfo.duration, manifest,
        ]);
        if (source.source_kind === 'utterance') {
          await client.query(`update utterances set audio_data=$1, delivery_media_type='audio/wav', raw_sha256=$3,
            raw_container=coalesce(raw_container,$4), raw_media_type=coalesce(raw_media_type,$5) where utterance_id=$2`,
          [artifact, source.source_id, sha256(source.bytes), sourceMetadata.container, sourceMetadata.mediaType]);
        } else {
          await client.query(`update syllable_observations set audio_data=$1, delivery_media_type='audio/wav', raw_sha256=$3,
            raw_container=coalesce(raw_container,$4), raw_media_type=coalesce(raw_media_type,$5) where observation_id=$2`,
          [artifact, source.source_id, sha256(source.bytes), sourceMetadata.container, sourceMetadata.mediaType]);
          await client.query(`insert into game_syllable_artifact_selections
            (speaker_id, syllable_text, profile, artifact_id, selection_method, rationale)
            values ($1,$2,$3,$4,'automatic',$5)
            on conflict (speaker_id, normalized_syllable_text, profile) do update
              set artifact_id=excluded.artifact_id, selected_at=now(), rationale=excluded.rationale
              where game_syllable_artifact_selections.selection_method='automatic'`,
            [source.speaker_id, source.syllable_text, PROFILE, inserted.rows[0].artifact_id, { method: 'first_valid_processed_artifact' }]);
        }
        await client.query("update audio_processing_jobs set status='ready', finished_at=now() where job_id=$1", [jobId]);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        await client.query("update audio_processing_jobs set status='failed', error_message=$2, finished_at=now() where job_id=$1", [jobId, error.message]);
        console.error(`${source.source_kind} ${source.source_id}: ${error.message}`);
      }
    }
    await client.query("update audio_processing_runs set status='completed', finished_at=now() where run_id=$1", [runId]);
  } catch (error) {
    if (runId) await client.query("update audio_processing_runs set status='failed', error_message=$2, finished_at=now() where run_id=$1", [runId, error.message]);
    throw error;
  } finally {
    await rm(temp, { recursive: true, force: true });
    client.release();
    await pool.end();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
