// handlers/errors.ts
//
// Errors shared across handlers. WordIdAlreadyExistsError started out
// duplicated identically in createWord.ts and createPhrase.ts (each
// creation path defining its own copy) - consolidated here once
// approveContribution.ts needed to compose both of them together and
// catch/attribute the same error regardless of which path a 'new_entry'
// contribution's type took.

export class WordNotFoundError extends Error {
  constructor(public readonly wordId: string) {
    super(`word_id '${wordId}' not found in golden_record`);
    this.name = 'WordNotFoundError';
  }
}

export class WordIdAlreadyExistsError extends Error {
  constructor(public readonly wordId: string) {
    super(`word_id '${wordId}' already exists in golden_record`);
    this.name = 'WordIdAlreadyExistsError';
  }
}
