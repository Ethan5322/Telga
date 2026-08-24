/**
 * The state-to-UI mapping.
 *
 * Exhaustive over `TRANSACTION_STATES`, the same way the transition tests are
 * exhaustive over the transition map. A new state cannot be added to the domain
 * without these failing until it has been given a presentation, which is the
 * point: an unmapped state would otherwise render as a blank status on a
 * counter screen.
 */

import { describe, expect, it } from 'vitest';
import { TRANSACTION_STATES, VALUE_DISPOSITION, isTerminal } from '@telga/domain';
import type { TransactionState } from '@telga/domain';
import {
  STATE_PRESENTATION,
  fundsStatusFor,
  isUncertain,
  presentationFor,
} from '@telga/pos-view-model';
import { EN, MESSAGE_KEYS } from '@telga/localization';

const REQUIRED_STATES: readonly TransactionState[] = [
  'CREATED',
  'VALIDATED',
  'RESERVED',
  'PROCESSING',
  'PENDING',
  'SUCCESSFUL',
  'FAILED',
  'REVERSAL_REQUIRED',
  'UNDER_REVIEW',
];

describe('state presentation', () => {
  it('covers every domain state', () => {
    for (const state of TRANSACTION_STATES) {
      expect(STATE_PRESENTATION[state], `no presentation for ${state}`).toBeDefined();
      expect(STATE_PRESENTATION[state].state).toBe(state);
    }
    expect(Object.keys(STATE_PRESENTATION)).toHaveLength(TRANSACTION_STATES.length);
  });

  it('covers every state the merchant POS must show', () => {
    for (const state of REQUIRED_STATES) {
      expect(STATE_PRESENTATION[state]).toBeDefined();
    }
  });

  it('uses only message keys that exist in both string tables', () => {
    for (const state of TRANSACTION_STATES) {
      const p = presentationFor(state);
      expect(MESSAGE_KEYS).toContain(p.labelKey);
      expect(MESSAGE_KEYS).toContain(p.explanationKey);
      expect(EN[p.labelKey]).toBeTruthy();
      expect(EN[p.explanationKey]).toBeTruthy();
    }
  });

  it('never renames a domain state', () => {
    for (const state of TRANSACTION_STATES) {
      expect(presentationFor(state).state).toBe(state);
    }
  });
});

describe('no false success', () => {
  it('marks exactly one state as a certain success', () => {
    const certain = TRANSACTION_STATES.filter(
      (state) => STATE_PRESENTATION[state].certainty === 'CERTAIN_SUCCESS',
    );
    expect(certain).toEqual(['SUCCESSFUL']);
  });

  it('offers a receipt only for a confirmed sale', () => {
    const withReceipt = TRANSACTION_STATES.filter(
      (state) => STATE_PRESENTATION[state].receiptAvailable,
    );
    expect(withReceipt).toEqual(['SUCCESSFUL']);
  });

  it('treats every non-terminal state as uncertain', () => {
    for (const state of TRANSACTION_STATES) {
      if (isTerminal(state)) continue;
      expect(isUncertain(state), `${state} should be uncertain`).toBe(true);
    }
  });

  it('never offers PRINT_RECEIPT where the outcome is not known', () => {
    for (const state of TRANSACTION_STATES) {
      if (isUncertain(state)) {
        expect(STATE_PRESENTATION[state].allowedActions).not.toContain('PRINT_RECEIPT');
        expect(STATE_PRESENTATION[state].allowedActions).not.toContain('REPRINT_RECEIPT');
      }
    }
  });
});

describe('retry safety', () => {
  it('sets doNotRetryYet for exactly the uncertain states', () => {
    for (const state of TRANSACTION_STATES) {
      expect(STATE_PRESENTATION[state].doNotRetryYet, state).toBe(isUncertain(state));
    }
  });

  it('forbids retrying the same sale in every state, settled or not', () => {
    for (const state of TRANSACTION_STATES) {
      expect(STATE_PRESENTATION[state].forbiddenActions, state).toContain('RETRY_SAME_SALE');
    }
  });

  it('refuses to release funds while a state still holds them', () => {
    for (const state of TRANSACTION_STATES) {
      expect(STATE_PRESENTATION[state].forbiddenActions, state).toContain('RELEASE_FUNDS');
    }
  });
});

describe('funds status', () => {
  it('is derived from the domain value disposition, not restated', () => {
    const expected: Record<string, string> = {
      NONE: 'NOT_YET_COMMITTED',
      RESERVED: 'HELD',
      UNDER_REVIEW: 'HELD_UNDER_REVIEW',
      DEBITED: 'DEBITED',
      RELEASED: 'RELEASED',
    };
    for (const state of TRANSACTION_STATES) {
      expect(fundsStatusFor(state), state).toBe(expected[VALUE_DISPOSITION[state]]);
    }
  });

  it('holds value for RESERVED and PROCESSING', () => {
    expect(fundsStatusFor('RESERVED')).toBe('HELD');
    expect(fundsStatusFor('PROCESSING')).toBe('HELD');
    expect(fundsStatusFor('PENDING')).toBe('HELD');
  });

  it('never reports released funds for a state the ledger still holds', () => {
    for (const state of TRANSACTION_STATES) {
      const holds = VALUE_DISPOSITION[state] === 'RESERVED' || VALUE_DISPOSITION[state] === 'UNDER_REVIEW';
      if (holds) expect(fundsStatusFor(state)).not.toBe('RELEASED');
    }
  });
});

describe('refresh and escalation', () => {
  it('polls exactly the unsettled states', () => {
    for (const state of TRANSACTION_STATES) {
      const expected = isTerminal(state) ? 'NONE' : 'POLL_UNTIL_RESOLVED';
      expect(STATE_PRESENTATION[state].refresh, state).toBe(expected);
    }
  });

  it('opens a case automatically for UNDER_REVIEW and requires one for REVERSAL_REQUIRED', () => {
    expect(STATE_PRESENTATION.UNDER_REVIEW.supportEscalation).toBe('CASE_OPEN_AUTOMATICALLY');
    expect(STATE_PRESENTATION.REVERSAL_REQUIRED.supportEscalation).toBe('CASE_REQUIRED');
  });
});

describe('status is never colour alone', () => {
  it('gives every state a text label, an icon and a tone', () => {
    for (const state of TRANSACTION_STATES) {
      const p = presentationFor(state);
      expect(EN[p.labelKey].length, state).toBeGreaterThan(0);
      expect(p.icon.length, state).toBeGreaterThan(0);
      expect(p.tone, state).toBeTruthy();
    }
  });

  it('does not distinguish the two caution states by tone alone', () => {
    // PENDING and UNDER_REVIEW share a tone; their labels must differ.
    expect(STATE_PRESENTATION.PENDING.tone).toBe(STATE_PRESENTATION.UNDER_REVIEW.tone);
    expect(EN[STATE_PRESENTATION.PENDING.labelKey]).not.toBe(
      EN[STATE_PRESENTATION.UNDER_REVIEW.labelKey],
    );
  });
});
