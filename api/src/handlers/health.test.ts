// The check that stops a green deploy from meaning nothing. These tests care
// about two things only: that a reachable database reports ok, and that an
// unreachable one reports degraded WITHOUT echoing the driver's error text -
// pg messages name the host, database and user, and /api/health is public.

import { describe, expect, it } from 'vitest';
import { health } from './health.js';
import type { Queryable } from '../db.js';

const reachable: Queryable = {
  query: (async () => ({ rows: [{ n: '26', latest: '0026_audio_artifact_kinds.sql' }] })) as Queryable['query'],
};

const unreachable: Queryable = {
  query: (async () => {
    throw new Error('connect ECONNREFUSED yorubastudentdict.postgres.database.azure.com:5432');
  }) as Queryable['query'],
};

describe('health', () => {
  it('reports the applied migration count and the latest filename', async () => {
    const report = await health(reachable);
    expect(report.status).toBe('ok');
    expect(report.database).toBe('ok');
    expect(report.migrationsApplied).toBe(26);
    expect(report.latestMigration).toBe('0026_audio_artifact_kinds.sql');
    expect(report.databaseLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it('degrades when the database cannot be reached', async () => {
    const report = await health(unreachable);
    expect(report.status).toBe('degraded');
    expect(report.database).toBe('unreachable');
    expect(report.migrationsApplied).toBeNull();
    expect(report.latestMigration).toBeNull();
  });

  it('never leaks the connection details the driver puts in its error', async () => {
    const serialized = JSON.stringify(await health(unreachable));
    expect(serialized).not.toContain('postgres.database.azure.com');
    expect(serialized).not.toContain('ECONNREFUSED');
    expect(serialized).not.toContain('5432');
  });

  it('still answers when there is no build stamp, as in local dev', async () => {
    const report = await health(reachable);
    expect(report.commit).toBe('local');
    expect(report.nodeVersion).toBe(process.version);
  });
});
