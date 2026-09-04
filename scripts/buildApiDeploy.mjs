// scripts/buildApiDeploy.mjs
//
// Assembles api-deploy/ - the self-contained Function app that actually gets uploaded.
//
// ---------------------------------------------------------------------------
// Why api/ itself cannot be deployed
// ---------------------------------------------------------------------------
// api/ is a workspace of the monorepo root, and that is fatal to a directory upload.
// Installing inside a workspace HOISTS every real dependency to the root node_modules and
// leaves api/node_modules holding one thing: the link to vendor/shared. The deploy uploads
// api/ alone, so @azure/functions and pg never travel with it, the host cannot load a
// single function, and the whole app is silently dead.
//
// That failure is invisible from the build log - the upload succeeds, because nothing in it
// ever tries to LOAD the app. What it looks like in production is every /api/* route
// returning 403 and the nav rendering empty: with no function answering, the platform's
// rolesSource call to /api/GetRoles returns nothing, so every signed-in account is left
// with no roles at all.
//
// A directory that is not a declared workspace has no such root above it, so npm installs
// there normally and the tree is complete. That is the whole trick.
//
// ---------------------------------------------------------------------------
// The manifest is trimmed to what runs
// ---------------------------------------------------------------------------
// No devDependencies and no scripts. Oryx runs `npm install` and then any `build` script it
// finds, so a deploy manifest carrying `tsc -p tsconfig.json` asks it to rebuild TypeScript
// that was already compiled here - with a compiler that a production install did not
// install. dist/ is built before this script runs; the deploy artifact only has to run it.

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const OUT = 'api-deploy';

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// dist and vendor are the app; host.json is what makes it a Function app at all.
cpSync('api/dist', `${OUT}/dist`, { recursive: true });
cpSync('api/vendor', `${OUT}/vendor`, { recursive: true });
cpSync('api/host.json', `${OUT}/host.json`);

const manifest = JSON.parse(readFileSync('api/package.json', 'utf8'));
delete manifest.devDependencies;
delete manifest.scripts;
writeFileSync(`${OUT}/package.json`, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`assembled ${OUT}/ (dist + vendor + host.json + a runtime-only manifest)`);
