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
import './functions/etymologyReview.js';
import './functions/spellingReview.js';
import './functions/definitionReview.js';
import './functions/kaikkiSearch.js';
import './functions/vocabSearch.js';
import './functions/listAllWords.js';
import './functions/duplicateCheck.js';
import './functions/rejectContribution.js';
import './functions/utteranceSasToken.js';
import './functions/utterances.js';
