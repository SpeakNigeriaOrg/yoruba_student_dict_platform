// vitest.config.ts
//
// The handler tests run against a real local Postgres (see testSupport.ts),
// not a mock - which is deliberate and worth keeping, but means every test
// file mutates ONE shared database.
//
// fileParallelism: false because per-file namespacing cannot make
// whole-table operations safe. createAssignments' scope: 'all' resolves
// every golden_record row and then inserts assignments referencing them; a
// concurrently-running file that deletes one of its own words between those
// two statements breaks the foreign key. Observed as intermittent failures
// in createAssignments/listUserAssignments before this was set.
//
// The cost is small (the suite is a few seconds either way) and it buys
// deterministic runs, which matters more here than wall-clock.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
