/**
 * Transaction state machine.
 *
 * Maps one-to-one onto the transition table in
 * `03 Domain/Transaction State Machine.md`. Every legal transition is asserted
 * to succeed, and every illegal one — all 100 of them — is asserted to throw.
 */

import { describe, expect, it } from 'vitest';
import {
  allInvalidTransitions,
  allValidTransitions,
  assertTransition,
  canTransition,
  holdsMerchantValue,
  IllegalTransitionError,
  INITIAL_STATE,
  isTerminal,
  TERMINAL_STATES,
  TerminalStateError,
  TRANSACTION_STATES,
  transitionTo,
  VALUE_DISPOSITION,
} from '@telga/domain';
import type { TransactionState } from '@telga/domain';
import { at, makeTransaction } from '../helpers';

/** Walk a transaction from CREATED along a path, asserting each hop is legal. */
function walk(path: readonly TransactionState[]) {
  let txn = makeTransaction();
  for (const next of path) {
    txn = transitionTo(txn, next, { at: at(), reason: `to ${next}` });
  }
  return txn;
}

describe('required transitions', () => {
  it('CREATED -> VALIDATED', () => {
    const txn = walk(['VALIDATED']);
    expect(txn.state).toBe('VALIDATED');
    expect(txn.history.at(-1)).toMatchObject({ from: 'CREATED', to: 'VALIDATED' });
  });

  it('VALIDATED -> RESERVED', () => {
    expect(walk(['VALIDATED', 'RESERVED']).state).toBe('RESERVED');
  });

  it('RESERVED -> SUBMITTED', () => {
    expect(walk(['VALIDATED', 'RESERVED', 'SUBMITTED']).state).toBe('SUBMITTED');
  });

  it('RESERVED -> PROCESSING (adapter with no separate acknowledgement)', () => {
    expect(walk(['VALIDATED', 'RESERVED', 'PROCESSING']).state).toBe('PROCESSING');
  });

  it('PROCESSING -> SUCCESSFUL', () => {
    expect(walk(['VALIDATED', 'RESERVED', 'PROCESSING', 'SUCCESSFUL']).state).toBe('SUCCESSFUL');
  });

  it('PROCESSING -> FAILED', () => {
    expect(walk(['VALIDATED', 'RESERVED', 'PROCESSING', 'FAILED']).state).toBe('FAILED');
  });

  it('PROCESSING -> PENDING (a timeout is never a failure)', () => {
    const txn = walk(['VALIDATED', 'RESERVED', 'PROCESSING', 'PENDING']);
    expect(txn.state).toBe('PENDING');
    expect(canTransition('PROCESSING', 'PENDING')).toBe(true);
  });

  it('PENDING -> SUCCESSFUL', () => {
    expect(walk(['VALIDATED', 'RESERVED', 'PROCESSING', 'PENDING', 'SUCCESSFUL']).state).toBe('SUCCESSFUL');
  });

  it('PENDING -> FAILED', () => {
    expect(walk(['VALIDATED', 'RESERVED', 'PROCESSING', 'PENDING', 'FAILED']).state).toBe('FAILED');
  });

  it('PENDING -> UNDER_REVIEW', () => {
    expect(walk(['VALIDATED', 'RESERVED', 'PROCESSING', 'PENDING', 'UNDER_REVIEW']).state).toBe('UNDER_REVIEW');
  });

  it('PENDING -> REVERSAL_REQUIRED', () => {
    expect(walk(['VALIDATED', 'RESERVED', 'PROCESSING', 'PENDING', 'REVERSAL_REQUIRED']).state).toBe(
      'REVERSAL_REQUIRED',
    );
  });

  it('REVERSAL_REQUIRED -> REVERSED', () => {
    const txn = walk([
      'VALIDATED',
      'RESERVED',
      'PROCESSING',
      'PENDING',
      'REVERSAL_REQUIRED',
      'REVERSED',
    ]);
    expect(txn.state).toBe('REVERSED');
    expect(isTerminal(txn.state)).toBe(true);
  });

  it('UNDER_REVIEW -> REVERSAL_REQUIRED -> REVERSED', () => {
    const txn = walk([
      'VALIDATED',
      'RESERVED',
      'PROCESSING',
      'PENDING',
      'UNDER_REVIEW',
      'REVERSAL_REQUIRED',
      'REVERSED',
    ]);
    expect(txn.state).toBe('REVERSED');
    expect(txn.history).toHaveLength(7);
  });
});

describe('invalid transitions', () => {
  it('rejects every pair absent from the transition map', () => {
    const invalid = allInvalidTransitions();
    expect(invalid.length).toBeGreaterThan(0);
    for (const [from, to] of invalid) {
      expect(() => {
        assertTransition(from, to);
      }).toThrow();
    }
  });

  it('accepts every pair present in the transition map', () => {
    for (const [from, to] of allValidTransitions()) {
      expect(() => {
        assertTransition(from, to);
      }).not.toThrow();
    }
  });

  it('a timeout may never be recorded as a failure directly from RESERVED', () => {
    expect(() => {
      assertTransition('RESERVED', 'FAILED');
    }).toThrow(IllegalTransitionError);
  });

  it('a transaction may not skip validation', () => {
    expect(() => {
      assertTransition('CREATED', 'RESERVED');
    }).toThrow(IllegalTransitionError);
  });

  it('a transaction may not skip straight to SUCCESSFUL', () => {
    expect(() => {
      assertTransition('CREATED', 'SUCCESSFUL');
    }).toThrow(IllegalTransitionError);
  });

  it('throws TerminalStateError out of every terminal state', () => {
    for (const terminal of TERMINAL_STATES) {
      expect(() => {
        assertTransition(terminal, 'PROCESSING');
      }).toThrow(TerminalStateError);
    }
  });

  it('the aggregate refuses an illegal move and leaves the transaction untouched', () => {
    const txn = makeTransaction();
    expect(() => transitionTo(txn, 'SUCCESSFUL', { at: at() })).toThrow(IllegalTransitionError);
    expect(txn.state).toBe('CREATED');
    expect(txn.history).toHaveLength(0);
  });
});

describe('terminal states', () => {
  it('has exactly four, and none of them can move', () => {
    expect([...TERMINAL_STATES]).toEqual(['SUCCESSFUL', 'FAILED', 'REVERSED', 'REJECTED']);
    for (const terminal of TERMINAL_STATES) {
      for (const to of TRANSACTION_STATES) {
        expect(canTransition(terminal, to)).toBe(false);
      }
    }
  });

  it('starts at CREATED', () => {
    expect(INITIAL_STATE).toBe('CREATED');
    expect(makeTransaction().state).toBe('CREATED');
  });
});

describe('value disposition — no state leaves value unaccounted for', () => {
  it('assigns every state exactly one bucket', () => {
    for (const state of TRANSACTION_STATES) {
      expect(VALUE_DISPOSITION[state]).toBeDefined();
    }
    expect(Object.keys(VALUE_DISPOSITION)).toHaveLength(TRANSACTION_STATES.length);
  });

  it('holds merchant value through the whole in-flight path', () => {
    for (const state of ['RESERVED', 'SUBMITTED', 'PROCESSING', 'PENDING', 'UNDER_REVIEW', 'REVERSAL_REQUIRED'] as const) {
      expect(holdsMerchantValue(state)).toBe(true);
    }
  });

  it('holds no merchant value before reservation or after settlement', () => {
    for (const state of ['CREATED', 'VALIDATED', 'SUCCESSFUL', 'FAILED', 'REVERSED', 'REJECTED'] as const) {
      expect(holdsMerchantValue(state)).toBe(false);
    }
  });

  it('keeps under-review value out of the reserved bucket', () => {
    expect(VALUE_DISPOSITION.UNDER_REVIEW).toBe('UNDER_REVIEW');
    expect(VALUE_DISPOSITION.REVERSAL_REQUIRED).toBe('UNDER_REVIEW');
  });
});
