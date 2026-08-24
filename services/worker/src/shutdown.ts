/**
 * Shutdown control.
 *
 * A tiny cooperative cancellation primitive. The worker checks `stopRequested`
 * between sweeps, and the sweep itself checks it between transactions — both of
 * which are safe boundaries. Nothing here cancels work mid-operation, because a
 * ledger operation interrupted halfway is exactly what the whole system is
 * built to prevent.
 */

export type ShutdownReason = 'SIGTERM' | 'SIGINT' | 'REQUESTED' | 'FATAL_FAILURE';

export interface SignalSource {
  on(signal: string, handler: () => void): unknown;
  off(signal: string, handler: () => void): unknown;
}

export class ShutdownController {
  private stopped = false;
  private reasonValue: ShutdownReason | undefined;
  private readonly listeners = new Set<(reason: ShutdownReason) => void>();
  private uninstall: (() => void) | undefined;

  get stopRequested(): boolean {
    return this.stopped;
  }

  get reason(): ShutdownReason | undefined {
    return this.reasonValue;
  }

  /** Idempotent: a second request keeps the first reason and notifies nobody twice. */
  requestStop(reason: ShutdownReason = 'REQUESTED'): void {
    if (this.stopped) return;
    this.stopped = true;
    this.reasonValue = reason;
    for (const listener of this.listeners) listener(reason);
  }

  onStop(listener: (reason: ShutdownReason) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Passed to the sweep as its safe-boundary check. */
  readonly shouldContinue = (): boolean => !this.stopped;

  /**
   * Install SIGTERM and SIGINT handlers.
   *
   * The source is injected so tests drive it with a fake emitter rather than
   * signalling the test runner's own process.
   */
  install(source: SignalSource): () => void {
    const onTerm = (): void => {
      this.requestStop('SIGTERM');
    };
    const onInt = (): void => {
      this.requestStop('SIGINT');
    };

    source.on('SIGTERM', onTerm);
    source.on('SIGINT', onInt);

    this.uninstall = () => {
      source.off('SIGTERM', onTerm);
      source.off('SIGINT', onInt);
    };
    return this.uninstall;
  }

  dispose(): void {
    this.uninstall?.();
    this.uninstall = undefined;
    this.listeners.clear();
  }
}
