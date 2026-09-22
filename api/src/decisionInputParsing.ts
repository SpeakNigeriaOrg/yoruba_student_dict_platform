// decisionInputParsing.ts
//
// Per-axis request-body shape validation, shared by functions/decisions.ts
// (a curator's direct decision) and functions/contributions.ts (a
// volunteer's proposed decision, submitted as a contribution's
// proposed_value) - both accept the identical shape per axis, since a
// contribution's proposed_value is exactly "the decision, not yet
// applied."

import type { ApplyEntryDecisionInput } from './handlers/applyEntryDecision.js';
import type { ApplyEtymologyDecisionInput } from './handlers/applyEtymologyDecision.js';

/** Shape validation only - whether BOTH halves of the entry decision are
 * present is a business rule, enforced by applyEntryDecision's own
 * validateEntryDecisionInput so it holds for the contribution-approval path
 * too, not just direct POSTs. */
export function parseEntryInput(b: Record<string, unknown>): ApplyEntryDecisionInput {
  const action = b.action;
  if (
    action !== undefined &&
    action !== 'keep_ours' &&
    action !== 'select_candidate' &&
    action !== 'adopt_kaikki' &&
    action !== 'respell'
  ) {
    throw new Error("action must be one of 'keep_ours', 'select_candidate', 'adopt_kaikki', 'respell' if provided");
  }
  if (
    b.newSyllables !== undefined &&
    (!Array.isArray(b.newSyllables) || !b.newSyllables.every((x) => typeof x === 'string' && x.length > 0))
  ) {
    throw new Error('newSyllables must be an array of non-empty strings if provided');
  }
  const syllableAction = b.syllableAction;
  if (syllableAction !== undefined && syllableAction !== 'keep_manual' && syllableAction !== 'accept_programmatic') {
    throw new Error("syllableAction must be one of 'keep_manual', 'accept_programmatic' if provided");
  }
  const definitionAction = b.definitionAction;
  if (definitionAction !== undefined && definitionAction !== 'confirm' && definitionAction !== 'custom') {
    throw new Error("definitionAction must be 'confirm' or 'custom' if provided");
  }
  const setOrConfirm = (key: string) => {
    const v = b[key];
    if (v !== undefined && v !== 'confirm' && v !== 'set') throw new Error(`${key} must be 'confirm' or 'set' if provided`);
    return v as 'confirm' | 'set' | undefined;
  };
  const posAction = setOrConfirm('posAction');
  const usageLabelsAction = setOrConfirm('usageLabelsAction');
  const onlyInDerivedTermsAction = setOrConfirm('onlyInDerivedTermsAction');
  if (b.usageLabels !== undefined && (!Array.isArray(b.usageLabels) || !b.usageLabels.every((x) => typeof x === 'string'))) {
    throw new Error('usageLabels must be an array of strings if provided');
  }
  if (b.onlyInDerivedTerms !== undefined && typeof b.onlyInDerivedTerms !== 'boolean') {
    throw new Error('onlyInDerivedTerms must be a boolean if provided');
  }
  return {
    // Whether a pos or label is in the vocabulary is a business rule, checked by
    // validateEntryUsageInput on both the decision and the contribution path.
    posAction,
    pos: typeof b.pos === 'string' && b.pos ? b.pos : undefined,
    usageLabelsAction,
    usageLabels: b.usageLabels as string[] | undefined,
    onlyInDerivedTermsAction,
    onlyInDerivedTerms: b.onlyInDerivedTerms as boolean | undefined,
    action,
    candidateForm: typeof b.candidateForm === 'string' ? b.candidateForm : undefined,
    newDisplayText: typeof b.newDisplayText === 'string' ? b.newDisplayText : undefined,
    newSyllables: b.newSyllables as string[] | undefined,
    syllableAction,
    syllableNote: typeof b.syllableNote === 'string' ? b.syllableNote : undefined,
    definitionAction,
    definitionText: typeof b.definitionText === 'string' ? b.definitionText : undefined,
    definitionSourceForm: typeof b.definitionSourceForm === 'string' ? b.definitionSourceForm : undefined,
    // Whether the id names a real, citable etymology is checked where the
    // citation is written (writeCitationInTransaction), against the corpus - the
    // only place that can actually know.
    senseEntryId: typeof b.senseEntryId === 'string' && b.senseEntryId ? b.senseEntryId : undefined,
    note: typeof b.note === 'string' ? b.note : undefined,
  };
}

const COMPONENTS_ACTIONS = ['confirm_atomic', 'confirm_existing', 'reject_proposed', 'accept_proposed', 'custom'];

export function parseEtymologyInput(b: Record<string, unknown>): ApplyEtymologyDecisionInput {
  if (typeof b.componentsAction !== 'string' || !COMPONENTS_ACTIONS.includes(b.componentsAction)) {
    throw new Error(`componentsAction must be one of ${COMPONENTS_ACTIONS.join(', ')}`);
  }
  if (b.components !== undefined && (!Array.isArray(b.components) || !b.components.every((c) => typeof c === 'string'))) {
    throw new Error('components must be an array of word_id strings if provided');
  }
  return {
    componentsAction: b.componentsAction as ApplyEtymologyDecisionInput['componentsAction'],
    components: b.components as string[] | undefined,
    note: typeof b.note === 'string' ? b.note : undefined,
  };
}
