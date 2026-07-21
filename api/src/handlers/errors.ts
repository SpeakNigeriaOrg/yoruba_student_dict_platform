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

export class UserNotFoundError extends Error {
  constructor(public readonly userId: string) {
    super(`user '${userId}' not found`);
    this.name = 'UserNotFoundError';
  }
}

export class UsernameAlreadyExistsError extends Error {
  constructor(public readonly username: string) {
    super(`username '${username}' already exists`);
    this.name = 'UsernameAlreadyExistsError';
  }
}

export class WordIdsNotFoundError extends Error {
  constructor(public readonly wordIds: string[]) {
    super(`word_id(s) not found in golden_record: ${wordIds.join(', ')}`);
    this.name = 'WordIdsNotFoundError';
  }
}

export class AssignmentNotFoundError extends Error {
  constructor(
    public readonly userId: string,
    public readonly wordId: string,
  ) {
    super(`no assignment of word '${wordId}' to user '${userId}'`);
    this.name = 'AssignmentNotFoundError';
  }
}
