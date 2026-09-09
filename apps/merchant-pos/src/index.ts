/**
 * @telga/merchant-pos — the training-mode merchant POS.
 *
 * TRAINING MODE — NO REAL VALUE. Four independent refusals stand between this
 * app and live money, and none of them relies on the other three:
 *
 *   1. `assertTrainingBoundary` refuses to start the server outside TRAINING.
 *   2. `page()` throws rather than render a screen whose mode is not TRAINING.
 *   3. Every write endpoint refuses before it reads the request body.
 *   4. The orchestration and the schema beneath both refuse independently.
 *
 * The app changes no transaction state, posts no ledger entry, completes no
 * reversal and calls no provider. Its only write is a sale through the existing
 * `createSale` service, against a scripted mock.
 */

export * from './ui/element';
export * from './ui/chrome';
export * from './ui/status';
export * from './ui/actions';
export * from './ui/states';
export * from './ui/screens';
export * from './ui/launcher';
export * from './ui/dashboard';
export * from './ui/logo';
export * from './ui/menu';
export * from './ui/menuScreens';
export * from './ui/lockScreen';
export * from './ui/serviceStateScreens';
export * from './ui/cardScreens';
export * from './ui/content';
export * from './ui/telgaPay';
export * from './ui/authScreens';
export * from './ui/registrationScreens';
export * from './ui/activationScreens';
// The throttle behind `POST /register`. Exported so its rules can be tested
// directly rather than only inferred from HTTP status codes — D138.
export * from './registration';
export { htmlDocument, CLIENT_SCRIPT } from './ui/document';
export * from './transport/config';
export * from './transport/tls';
export * from './transport/proxy';
export * from './transport/headers';
export * from './client/apiClient';
export * from './client/flow';
export {
  createPosServer,
  renderScreen,
  assertTrainingBoundary,
  safeReturnTo,
  NotTrainingModeError,
} from './server';
export type { PosServerOptions, ScreenRequest } from './server';
export {
  parseArgs,
  optionsFrom,
  authConfigFrom,
  transportFrom,
  startupLines,
  provision,
  TRAINING_CATALOG,
  TRAINING_VOUCHER_CATALOG,
  TRAINING_VOUCHER_NETWORKS,
  TRAINING_DATA_CATEGORIES,
  TRAINING_DATA_BUNDLES,
  CliArgumentError,
} from './cli';
export type { CliArgs } from './cli';
