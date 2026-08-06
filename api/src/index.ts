// index.ts
//
// Functions host entrypoint (package.json's "main") - each import below
// registers one HTTP function as a side effect of module load (app.http(...)).

import './functions/words.js';
import './functions/phrases.js';
import './functions/decisions.js';
import './functions/contributions.js';
import './functions/approveContribution.js';
import './functions/assignmentsMe.js';
import './functions/assignments.js';
import './functions/getRoles.js';
import './functions/users.js';
import './functions/etymologyReview.js';
import './functions/entryReview.js';
import './functions/kaikkiSearch.js';
import './functions/vocabSearch.js';
import './functions/listAllWords.js';
import './functions/duplicateCheck.js';
import './functions/excludeContribution.js';
import './functions/consensus.js';
import './functions/upstreamDrift.js';
import './functions/examples.js';
import './functions/utteranceSasToken.js';
import './functions/utterances.js';
import './functions/axisStatus.js';
import './functions/utteranceList.js';
import './functions/syllableObservations.js';
