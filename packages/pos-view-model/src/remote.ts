/**
 * The boundary between server state and presentation state.
 *
 * Server state is whatever the API last said. Presentation state is what the
 * screen is doing about it: loading, showing, refreshing, failing. Keeping them
 * apart is what lets a refresh failure leave the previous answer on screen,
 * clearly marked as stale, instead of blanking a merchant's transaction to an
 * error while it is still the best information anyone has.
 *
 * ## Why STALE is its own state
 *
 * A POS on a shop counter loses its connection regularly. Two wrong designs:
 *
 *  - Replace the last known state with an error. The merchant loses the
 *    transaction id and the support reference at the moment they need them.
 *  - Keep showing the last state silently. The merchant believes it is current.
 *
 * `STALE` carries the last data **and** the failure, so a screen can show both.
 */

export type RemoteStatus = 'IDLE' | 'LOADING' | 'READY' | 'EMPTY' | 'STALE' | 'ERROR';

/** A failure a screen can render. Never an exception object. */
export interface RemoteFailure {
  readonly reasonCode: string;
  readonly messageKey: string;
  /** null when the request never reached the server. */
  readonly status: number | null;
  readonly correlationId: string | null;
  readonly at: string;
}

export interface RemoteIdle {
  readonly status: 'IDLE';
}
export interface RemoteLoading<T> {
  readonly status: 'LOADING';
  /** Present on a refresh, absent on a first load. */
  readonly previous?: T;
  readonly loadedAt?: string;
}
export interface RemoteReady<T> {
  readonly status: 'READY';
  readonly data: T;
  readonly loadedAt: string;
}
export interface RemoteEmpty {
  readonly status: 'EMPTY';
  readonly loadedAt: string;
}
export interface RemoteStale<T> {
  readonly status: 'STALE';
  readonly data: T;
  readonly loadedAt: string;
  readonly failure: RemoteFailure;
}
export interface RemoteError {
  readonly status: 'ERROR';
  readonly failure: RemoteFailure;
}

export type RemoteData<T> =
  | RemoteIdle
  | RemoteLoading<T>
  | RemoteReady<T>
  | RemoteEmpty
  | RemoteStale<T>
  | RemoteError;

export const idle = (): RemoteData<never> => ({ status: 'IDLE' });

/** Begin a load, carrying any previous data so a refresh does not blank the screen. */
export function startLoad<T>(current: RemoteData<T>): RemoteData<T> {
  if (current.status === 'READY' || current.status === 'STALE') {
    return { status: 'LOADING', previous: current.data, loadedAt: current.loadedAt };
  }
  if (current.status === 'LOADING') return current;
  return { status: 'LOADING' };
}

export function succeed<T>(data: T, at: string): RemoteData<T> {
  return { status: 'READY', data, loadedAt: at };
}

export function succeedList<T>(items: readonly T[], at: string): RemoteData<readonly T[]> {
  return items.length === 0
    ? { status: 'EMPTY', loadedAt: at }
    : { status: 'READY', data: items, loadedAt: at };
}

/**
 * Record a failure.
 *
 * Degrades to `STALE` when there is previous data to keep, and to `ERROR` only
 * when there is genuinely nothing to show.
 */
export function fail<T>(current: RemoteData<T>, failure: RemoteFailure): RemoteData<T> {
  if (current.status === 'READY' || current.status === 'STALE') {
    return { status: 'STALE', data: current.data, loadedAt: current.loadedAt, failure };
  }
  if (current.status === 'LOADING' && current.previous !== undefined) {
    return {
      status: 'STALE',
      data: current.previous,
      loadedAt: current.loadedAt ?? failure.at,
      failure,
    };
  }
  return { status: 'ERROR', failure };
}

/** The data a screen can render right now, if any. */
export function dataOf<T>(state: RemoteData<T>): T | undefined {
  if (state.status === 'READY' || state.status === 'STALE') return state.data;
  if (state.status === 'LOADING') return state.previous;
  return undefined;
}

/** True when what is on screen is known not to be current. */
export function isStale<T>(state: RemoteData<T>): boolean {
  return state.status === 'STALE';
}

export function failureOf<T>(state: RemoteData<T>): RemoteFailure | undefined {
  if (state.status === 'ERROR' || state.status === 'STALE') return state.failure;
  return undefined;
}
