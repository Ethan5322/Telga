/**
 * A money figure with its unit rubricated beside it.
 *
 * ## The defect this exists to stop
 *
 * `DESIGN.md`: *"The balance leads. The available figure is the largest thing on
 * the merchant home screen, **its unit rubricated and set small beside it**."*
 *
 * Two screens implemented that by rendering the preformatted amount and then
 * appending the currency in a `.balance__unit` span. But the domain's `format()`
 * already ends every figure with its currency — `100.00 ETB` — so both screens
 * printed it twice:
 *
 *     100.00 ETB ETB
 *
 * On the dashboard that was the single number a shopkeeper opens this app to
 * read, and on `/home` it was the lead figure of the balance card.
 *
 * ## Why the split happens here and not in `format()`
 *
 * `format()` is the domain's own formatter. It feeds printed slips, statements,
 * the operations console and roughly two thousand assertions, and a figure on
 * paper needs its unit attached — a slip line reading `100.00` is ambiguous the
 * moment it leaves the screen. So the string keeps its unit and **the screen**
 * takes it off, which is the layer that wanted it set differently.
 *
 * ## A figure with no unit is returned unchanged
 *
 * Not every caller's string comes from `format()`. One that does not simply has
 * no unit to rubricate, and gets a plain figure rather than a guess.
 */

import { h } from './element';
import type { Attributes, El } from './element';

/** The figure and its unit, split on the last space. */
export function splitAmount(formatted: string): { figure: string; unit: string } {
  const at = formatted.lastIndexOf(' ');
  // A currency code, not the last word of anything: letters only, and the ISO
  // codes this app deals in are three of them. Anything else is left alone.
  if (at === -1) return { figure: formatted, unit: '' };
  const tail = formatted.slice(at + 1);
  if (!/^[A-Za-z]{2,4}$/.test(tail)) return { figure: formatted, unit: '' };
  return { figure: formatted.slice(0, at), unit: tail };
}

/**
 * Render `formatted` with its unit in red ink beside it.
 *
 * `attrs` go on the figure, not the wrapper, so an existing `data-testid` keeps
 * pointing at the digits it always pointed at.
 */
export function amountWithUnit(formatted: string, attrs: Attributes = {}): readonly El[] {
  const { figure, unit } = splitAmount(formatted);
  const figureEl = h('span', attrs, figure);
  if (unit === '') return [figureEl];
  return [figureEl, h('span', { class: 'balance__unit' }, unit)];
}
