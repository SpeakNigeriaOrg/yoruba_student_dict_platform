// handlers/health.ts
//
// The one endpoint that answers "is the thing that just deployed actually
// alive?" - and it exists because for a full day nothing could.
//
// Every other /api route carries an allowedRoles rule, so an unauthenticated
// request to any of them returns a redirect or a 404 whether the API is
// healthy or dead. The only role-free route was /api/GetRoles, which is the
// platform's rolesSource: SWA calls it internally after login and answers
// external callers with its own 404 regardless of whether the function
// registered. A deploy check pointed at it therefore fails identically on a
// perfectly good deploy and on a completely dead one - which is exactly what
// happened, turning every build red for a day while the site worked fine.
//
// So this route is deliberately anonymous, and deliberately reports more than
// "up": a Functions host that boots but cannot reach Postgres, or is running
// against a database missing the migrations the code expects, is not a
// working deploy, and both are invisible to a status-code-only check.
//
// What it must NOT do is leak anything useful to an attacker: it is public.
// No connection strings, no hostnames, no usernames, no error text (pg error
// messages carry the host and database name). Only shapes and counts.

import { readFileSync } from 'node:fs';
import type { Queryable } from '../db.js';

export interface HealthReport {
  status: 'ok' | 'degraded';
  commit: string;
  builtAt: string | null;
  nodeVersion: string;
  database: 'ok' | 'unreachable';
  databaseLatencyMs: number | null;
  migrationsApplied: number | null;
  latestMigration: string | null;
  checkedAt: string;
}

/** Written by scripts/buildApiDeploy.mjs next to the manifest, so the running
 * app can say which commit it is - the question nobody could answer while
 * chasing whether a deploy had landed at all. Absent in local dev. */
function readBuildInfo(): { commit: string; builtAt: string | null } {
  try {
    const raw = readFileSync(new URL('../../build-info.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw) as { commit?: string; builtAt?: string };
    return { commit: parsed.commit ?? 'unknown', builtAt: parsed.builtAt ?? null };
  } catch {
    return { commit: 'local', builtAt: null };
  }
}

export async function health(db: Queryable): Promise<HealthReport> {
  const build = readBuildInfo();
  const base = {
    commit: build.commit,
    builtAt: build.builtAt,
    nodeVersion: process.version,
    checkedAt: new Date().toISOString(),
  };

  const startedAt = Date.now();
  try {
    // schema_migrations is db/migrate.mjs's own ledger. Reporting the latest
    // filename catches the failure db/README.md records from experience:
    // migrations applied to production by hand and never recorded, so the
    // next migration breaks. A deploy whose code expects 0026 while the
    // database has 0024 is broken in a way no status code reveals.
    const result = await db.query<{ n: string; latest: string | null }>(
      'select count(*)::text as n, max(filename) as latest from schema_migrations',
    );
    const row = result.rows[0];
    return {
      ...base,
      status: 'ok',
      database: 'ok',
      databaseLatencyMs: Date.now() - startedAt,
      migrationsApplied: row ? Number(row.n) : 0,
      latestMigration: row?.latest ?? null,
    };
  } catch {
    // Swallowed deliberately: a pg error message names the host, database and
    // user, and this endpoint is public. The status field carries the signal.
    return {
      ...base,
      status: 'degraded',
      database: 'unreachable',
      databaseLatencyMs: null,
      migrationsApplied: null,
      latestMigration: null,
    };
  }
}
