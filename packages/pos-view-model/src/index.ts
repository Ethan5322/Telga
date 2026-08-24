/**
 * @telga/pos-view-model — what a merchant may see and do.
 *
 * Pure. No I/O, no DOM, no database, no provider. Every function here is a
 * mapping from a value the server already decided to a value a screen can
 * render, which is why the whole package can be tested without a browser.
 *
 * TRAINING MODE — NO REAL VALUE. `trainingMode` on the view model is derived
 * from the transaction's own `mode` column, so a screen cannot claim training
 * status for a row that does not carry it.
 */

export * from './presentation';
export * from './dto';
export * from './transaction';
export * from './remote';
export * from './polling';
export * from './redaction';
