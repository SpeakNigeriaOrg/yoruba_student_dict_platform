// decisionInputParsing.ts
//
// Per-axis request-body shape validation, shared by functions/decisions.ts
// (a curator's direct decision) and functions/contributions.ts (a
// volunteer's proposed decision, submitted as a contribution's
// proposed_value) - both accept the identical shape per axis, since a
// contribution's proposed_value is exactly "the decision, not yet
// applied."

import type { ApplyDefinitionDecisionInput } from './handlers/applyDefinitionDecision.js';
import type { ApplyEtymologyDecisionInput } from './handlers/applyEtymologyDecision.js';
import type { ApplySpellingDecisionInput } from './handlers/applySpellingDecision.js';

export function parseSpellingInput(b: Record<string, unknown>): ApplySpellingDecisionInput {
  const action = b.action;
  if (action !== undefined && action !== 'keep_ours' && action !== 'select_candidate' && action !== 'adopt_kaikki') {
    throw new Error("action must be one of 'keep_ours', 'select_candidate', 'adopt_kaikki' if provided");
  }
  const syllableAction = b.syllableAction;
  if (syllableAction !== undefined && syllableAction !== 'keep_manual' && syllableAction !== 'accept_programmatic') {
    throw new Error("syllableAction must be one of 'keep_manual', 'accept_programmatic' if provided");
  }
  return {
    action,
    candidateForm: typeof b.candidateForm === 'string' ? b.candidateForm : undefined,
    newDisplayText: typeof b.newDisplayText === 'string' ? b.newDisplayText : undefined,
    syllableAction,
    syllableNote: typeof b.syllableNote === 'string' ? b.syllableNote : undefined,
    note: typeof b.note === 'string' ? b.note : undefined,
  };
}

export function parseDefinitionInput(b: Record<string, unknown>): ApplyDefinitionDecisionInput {
  if (b.definitionAction !== 'confirm' && b.definitionAction !== 'custom') {
    throw new Error("definitionAction must be 'confirm' or 'custom'");
  }
  return {
    definitionAction: b.definitionAction,
    definitionText: typeof b.definitionText === 'string' ? b.definitionText : undefined,
    definitionSourceForm: typeof b.definitionSourceForm === 'string' ? b.definitionSourceForm : undefined,
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
