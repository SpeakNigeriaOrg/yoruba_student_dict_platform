// scripts/vendorSharedForApi.mjs
//
// Copies shared/ into api/vendor/shared, as a RUNTIME artifact rather than as the package
// shared/ is while you work on it.
//
// ---------------------------------------------------------------------------
// Why the manifest is rewritten instead of copied
// ---------------------------------------------------------------------------
// api/package.json depends on this copy through "file:./vendor/shared", and Azure's Oryx
// runs its own `npm install --production` inside api/ during every deploy - with no
// lockfile, so it re-resolves the whole graph from the manifests.
//
// npm builds the ideal tree with devDependencies INCLUDED and prunes them afterwards, so
// "--production" does not stop it resolving them. This copy therefore dragged shared's dev
// tooling into the deploy's dependency graph, vitest among it - and on 2026-09-03 that
// crashed Oryx's npm (10.9.4) outright while loading vitest's peer set:
//
//     TypeError: Cannot read properties of null (reading 'edgesOut')
//         at #loadPeerSet (@npmcli/arborist/lib/arborist/build-ideal-tree.js:1289)
//
// Nothing in this repo had changed - `vitest` alone in a devDependencies block reproduces
// it under npm 10.9.4, even pinned to the exact version that deployed successfully days
// earlier, so what moved was vitest's peer graph on the registry. npm 11 does not crash on
// it, which is why it never showed up locally.
//
// vitest itself now lives in the ROOT package.json's devDependencies rather than in api's
// and shared's, so neither manifest drags it into a deploy; workspaces hoist it and the test
// scripts still find it on PATH. This rewrite is the second line of defence, for whatever
// dev tooling shared grows next.
//
// A vendored dist has no use for dev tooling or scripts in any case: nothing builds or
// tests this copy - shared/ itself is where that happens. Dropping both keeps the deploy's
// dependency graph to what actually runs in production, which is also the smallest graph
// that can break.

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const OUT = 'api/vendor/shared';

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync('shared/dist', `${OUT}/dist`, { recursive: true });

const manifest = JSON.parse(readFileSync('shared/package.json', 'utf8'));
delete manifest.devDependencies;
delete manifest.scripts;
writeFileSync(`${OUT}/package.json`, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`vendored shared -> ${OUT} (dist + a runtime-only manifest)`);
