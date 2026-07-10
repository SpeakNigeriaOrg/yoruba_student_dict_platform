// handlers/errors.ts
//
// Error shared by every decision/contribution handler that operates on an
// existing word (as opposed to createWord/createPhrase, which each define
// their own WordIdAlreadyExistsError since that one is specific to
// creation and only used in those two places).

export class WordNotFoundError extends Error {
  constructor(public readonly wordId: string) {
    super(`word_id '${wordId}' not found in golden_record`);
    this.name = 'WordNotFoundError';
  }
}
