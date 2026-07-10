// index.ts
//
// Functions host entrypoint (package.json's "main") - each import below
// registers one HTTP function as a side effect of module load (app.http(...)).

import './functions/getRoles.js';
import './functions/words.js';
import './functions/phrases.js';
import './functions/decisions.js';
