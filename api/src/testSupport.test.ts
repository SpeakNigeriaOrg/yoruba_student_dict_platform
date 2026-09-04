// The guard that was missing on 2026-09-03, when the API suite was pointed at
// the production Azure database because api/local.settings.json holds that URL
// and the suite never checked. Nothing here touches a database.

import { describe, expect, it } from 'vitest';
import { assertLocalDatabaseUrl } from './testSupport.js';

describe('assertLocalDatabaseUrl', () => {
  it('accepts the local Postgres this suite is meant to run against', () => {
    expect(() => assertLocalDatabaseUrl('postgres://breallis@localhost:5432/yoruba_student_dict_platform')).not.toThrow();
    expect(() => assertLocalDatabaseUrl('postgres://user:pw@127.0.0.1:5432/db')).not.toThrow();
    expect(() => assertLocalDatabaseUrl('postgres://user@[::1]:5432/db')).not.toThrow();
  });

  it('refuses the production host, naming it', () => {
    expect(() =>
      assertLocalDatabaseUrl('postgresql://speak_admin_nigeria:pw@yorubastudentdict.postgres.database.azure.com:5432/postgres?sslmode=require'),
    ).toThrow(/yorubastudentdict\.postgres\.database\.azure\.com/);
  });

  it('refuses a host that merely contains "localhost"', () => {
    // The reason the check parses the URL instead of matching a substring.
    expect(() => assertLocalDatabaseUrl('postgres://user@localhost.evil.example.com:5432/db')).toThrow(/non-local/);
  });

  it('refuses a connection string it cannot parse, rather than assuming it is safe', () => {
    expect(() => assertLocalDatabaseUrl('host=prod.example.com dbname=postgres')).toThrow(/parseable/);
  });
});
