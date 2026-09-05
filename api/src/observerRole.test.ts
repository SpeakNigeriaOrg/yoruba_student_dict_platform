// The observer role's whole safety argument in one file.
//
// requireCurator admits an observer on GET and refuses every other method
// (migration 0027). That single gate is only sound while "GET" really does mean
// "reads nothing", so the last test asserts exactly that against the real
// function registrations: a future GET endpoint that writes fails the build
// instead of quietly handing board members a way to change the dictionary.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getRoles } from './handlers/getRoles.js';
import { APP_ROLES, describeAppRoles, isAppRole } from './auth.js';
import type { Queryable } from './db.js';

function userWithRole(role: string): Queryable {
  return { query: (async () => ({ rows: [{ role }] })) as Queryable['query'] };
}
const notRegistered: Queryable = { query: (async () => ({ rows: [] })) as Queryable['query'] };
const body = { userDetails: 'board@example.org' };

describe('getRoles', () => {
  it('gives an observer member plus observer, so route rules can name them', async () => {
    expect((await getRoles(userWithRole('observer'), body)).roles).toEqual(['member', 'observer']);
  });

  it('still gives a curator both curator roles and a volunteer only member', async () => {
    expect((await getRoles(userWithRole('curator'), body)).roles).toEqual(['member', 'curator']);
    expect((await getRoles(userWithRole('volunteer'), body)).roles).toEqual(['member']);
  });

  it('never grants observer to an unregistered address', async () => {
    expect((await getRoles(notRegistered, body)).roles).toEqual([]);
  });
});

describe('the route rules an observer is admitted through', () => {
  const config = JSON.parse(
    readFileSync(new URL('../../app/public/staticwebapp.config.json', import.meta.url), 'utf8').replace(
      /^\s*\/\/.*$/gm,
      '',
    ),
  ) as { routes: Array<{ route: string; methods?: string[]; allowedRoles?: string[] }> };

  it('never names observer on a rule restricted to write methods', () => {
    const writeRules = config.routes.filter(
      (r) => r.methods && !r.methods.includes('GET') && r.methods.length > 0,
    );
    for (const rule of writeRules) {
      expect(rule.allowedRoles ?? []).not.toContain('observer');
    }
  });

  it('lets an observer reach the oversight screens a board member joined for', () => {
    const reachable = (path: string) =>
      config.routes.some((r) => r.route === path && (r.allowedRoles ?? []).includes('observer'));
    for (const path of ['/api/users', '/api/users/*', '/api/contributions', '/api/dictionary/*', '/api/consensus']) {
      expect(reachable(path), `${path} should be readable by an observer`).toBe(true);
    }
  });
});

describe('the invariant requireCurator relies on', () => {
  it('has no GET-only registration whose handler writes', () => {
    const dir = fileURLToPath(new URL('./functions', import.meta.url));
    const offenders: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
      const source = readFileSync(join(dir, file), 'utf8');
      for (const match of source.matchAll(/app\.http\('(\w+)',\s*\{([\s\S]*?)\}\);/g)) {
        const [, name, options] = match;
        const methods = /methods:\s*\[([^\]]*)\]/.exec(options)?.[1] ?? '';
        if (/'(POST|PATCH|PUT|DELETE)'/.test(methods)) continue;
        const handler = /handler:\s*(\w+)/.exec(options)?.[1];
        if (!handler) continue;
        const fn = new RegExp(`async function ${handler}\\b[\\s\\S]*?\\n\\}`).exec(source)?.[0] ?? '';
        if (/insert into|update\s+\w+\s+set|delete\s+from|truncate/i.test(fn)) {
          offenders.push(`${file}:${name}`);
        }
      }
    }
    expect(offenders, 'a GET endpoint that writes would let observers change data').toEqual([]);
  });
});

describe('role validation accepts every role the schema allows', () => {
  // The bug this prevents: the TYPE was widened to include 'observer' while two runtime
  // checks in functions/users.ts still compared against the old pair. TypeScript cannot
  // catch that - they test an `unknown` off a JSON body, where every string is equally
  // valid to the compiler - so the API advertised a role it then refused, and the button
  // in the admin UI returned "role must be 'curator' or 'volunteer'".
  it('admits each role in APP_ROLES and nothing else', () => {
    for (const role of APP_ROLES) expect(isAppRole(role)).toBe(true);
    for (const notARole of ['admin', 'Observer', '', 'curator ', null, undefined, 7]) {
      expect(isAppRole(notARole)).toBe(false);
    }
  });

  it('covers exactly what the users_role_check constraint allows', () => {
    // Migration 0027 is the other half of this pair; if one changes the other must.
    const migration = readFileSync(
      new URL('../../db/migrations/0027_observer_role.sql', import.meta.url),
      'utf8',
    );
    const allowed = [...migration.matchAll(/'(\w+)'/g)].map((m) => m[1]);
    for (const role of APP_ROLES) {
      expect(allowed, `${role} must be permitted by the check constraint`).toContain(role);
    }
  });

  it('names every role in the error text, so the message cannot drift from the list', () => {
    for (const role of APP_ROLES) expect(describeAppRoles()).toContain(role);
  });
});
