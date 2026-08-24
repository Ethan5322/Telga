/**
 * The dependency bundle the HTTP layer runs on.
 *
 * Split out of `handlers.ts` so `guard.ts` can name it without importing the
 * handlers it guards, which would be a cycle.
 */

import type { SaleDeps } from '../application/context';
import type { AuthConfig } from '../auth/context';

export interface AuthedApiDeps extends SaleDeps {
  /** Poll interval handed to the client. The recovery policy's own number. */
  readonly statusCheckIntervalMs: number;
  /** Client-side poll cap, so a screen left open does not poll forever. */
  readonly maxClientPolls: number;
  readonly maxStatusAttempts?: number;
  readonly authConfig: AuthConfig;
  /**
   * Selects the scripted mock behaviour for a training sale.
   *
   * Present only because the point of a training POS is to exercise failure
   * paths on demand. Injected rather than imported, so this layer never depends
   * on the mock package, and only consulted when the mode is TRAINING.
   */
  useSimulatedBehaviour?(behaviour: string): void;
}
