/**
 * Loading, empty, error and stale.
 *
 * Four screen conditions that are not the transaction's state and must never be
 * confused with it. A merchant reading "we cannot reach Telga" has learnt
 * nothing about whether their customer got airtime, and this file is careful
 * never to suggest otherwise.
 *
 * `staleNotice` is the important one. When a refresh fails, the previous answer
 * stays on screen and this notice appears above it: the data is still the best
 * anyone has, and it is no longer current. Both facts, at once.
 */

import { translateUnknown } from '@telga/localization';
import type { Locale } from '@telga/localization';
import type { RemoteData, RemoteFailure } from '@telga/pos-view-model';
import { h } from './element';
import type { El, Node } from './element';

export function loadingBlock(what: string): El {
  return h(
    'p',
    { 'data-testid': 'loading', role: 'status', 'aria-live': 'polite', 'aria-busy': 'true' },
    `Loading ${what}…`,
  );
}

export function emptyBlock(message: string): El {
  return h('p', { 'data-testid': 'empty', role: 'status' }, message);
}

/**
 * A failure the merchant can act on.
 *
 * The correlation id is shown because it is the one thing that makes a support
 * call short. `reasonCode` is rendered as a small technical line rather than
 * hidden: it is a stable safe code, and an operator reading it to support beats
 * an operator describing the colour of the screen.
 */
export function errorBlock(failure: RemoteFailure, locale: Locale = 'en'): El {
  const translated = translateUnknown(locale, failure.messageKey);
  return h(
    'section',
    { 'data-testid': 'error-block', role: 'alert', 'data-reason-code': failure.reasonCode },
    h(
      'p',
      { 'data-testid': 'error-message' },
      translated?.text ?? 'Something went wrong. Nothing was charged by this screen.',
    ),
    h(
      'p',
      { class: 'error__detail' },
      h('span', { 'data-testid': 'error-reason-code' }, failure.reasonCode),
      failure.correlationId !== null &&
        h('span', { 'data-testid': 'error-correlation-id' }, ` · ${failure.correlationId}`),
    ),
    h(
      'p',
      { 'data-testid': 'error-safety-note' },
      'This message is about the screen, not about your sale. Check the transaction list before selling again.',
    ),
  );
}

/** Shown above data that is known not to be current. */
export function staleNotice(failure: RemoteFailure, loadedAt: string): El {
  return h(
    'p',
    { 'data-testid': 'stale-notice', role: 'status', 'aria-live': 'polite' },
    `Showing the last answer from ${loadedAt}. Telga could not be reached just now (${failure.reasonCode}).`,
  );
}

/**
 * Render one remote value.
 *
 * A single function so every screen treats the four conditions identically. The
 * `LOADING` branch keeps previous data on screen when there is any, which is
 * what stops a poll from blanking a merchant's transaction every few seconds.
 */
export function renderRemote<T>(
  state: RemoteData<T>,
  options: {
    what: string;
    emptyMessage: string;
    locale?: Locale;
    render(data: T): Node;
  },
): Node {
  switch (state.status) {
    case 'IDLE':
      return loadingBlock(options.what);
    case 'LOADING':
      return state.previous === undefined
        ? loadingBlock(options.what)
        : h('div', { 'data-testid': 'refreshing', 'aria-busy': 'true' }, options.render(state.previous));
    case 'READY':
      return options.render(state.data);
    case 'EMPTY':
      return emptyBlock(options.emptyMessage);
    case 'STALE':
      return h(
        'div',
        { 'data-testid': 'stale' },
        staleNotice(state.failure, state.loadedAt),
        options.render(state.data),
      );
    case 'ERROR':
      return errorBlock(state.failure, options.locale);
    default: {
      // Exhaustiveness: a new status must be handled here, not fall through.
      const never: never = state;
      return never;
    }
  }
}
