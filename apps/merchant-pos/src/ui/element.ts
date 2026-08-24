/**
 * A tiny element tree, and why there is no framework here.
 *
 * The POS screens are pure functions from a view model to an `El` tree. The
 * tree serialises to HTML for the server, and a test queries it directly — by
 * role, by label, by test id — without a DOM emulator.
 *
 * ## Why not React, or jsdom, or a bundler
 *
 * The repository already decided, twice, that a new build technology has to
 * earn its place: the build emits CommonJS from plain `tsc` rather than adopt a
 * bundler, and the recovery tests spawn real processes rather than mock them.
 * The same reasoning applies here. What the UI tests need to assert is:
 *
 *   - the training banner is present on every screen;
 *   - an uncertain state never renders a success affordance;
 *   - the "do not retry yet" instruction is present and is not merely a colour;
 *   - controls carry accessible names and reachable focus order.
 *
 * All four are properties of the tree, not of a layout engine. A DOM emulator
 * would add a dependency and answer the same questions. If a real browser test
 * is wanted later, these render functions feed one unchanged — `mount()` builds
 * genuine DOM nodes from the same tree.
 *
 * Escaping is the one thing that must not be optional, so it happens in
 * `renderToHtml` for every text node and every attribute value, with no way for
 * a caller to opt out.
 */

export type Attributes = Readonly<Record<string, string | number | boolean | undefined>>;

export interface El {
  readonly tag: string;
  readonly attrs: Attributes;
  readonly children: readonly Node[];
}

export type Node = El | string;

export const isElement = (node: Node): node is El => typeof node !== 'string';

/** Build an element. `false` and `undefined` children are dropped, so a conditional reads cleanly. */
export function h(
  tag: string,
  attrs: Attributes = {},
  ...children: ReadonlyArray<Node | false | null | undefined>
): El {
  return {
    tag,
    attrs,
    children: children.filter((child): child is Node => child !== false && child != null),
  };
}

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link']);

/** The five characters that turn text into markup. */
export function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderToHtml(node: Node): string {
  if (typeof node === 'string') return escapeText(node);

  const attrs = Object.entries(node.attrs)
    .filter(([, value]) => value !== undefined && value !== false)
    .map(([key, value]) =>
      value === true ? ` ${key}` : ` ${key}="${escapeText(String(value))}"`,
    )
    .join('');

  if (VOID_TAGS.has(node.tag)) return `<${node.tag}${attrs}>`;
  const inner = node.children.map(renderToHtml).join('');
  return `<${node.tag}${attrs}>${inner}</${node.tag}>`;
}

// --- queries, for tests and for the client ---------------------------------

export function walk(node: Node, visit: (el: El) => void): void {
  if (typeof node === 'string') return;
  visit(node);
  for (const child of node.children) walk(child, visit);
}

export function findAll(root: Node, predicate: (el: El) => boolean): readonly El[] {
  const found: El[] = [];
  walk(root, (el) => {
    if (predicate(el)) found.push(el);
  });
  return found;
}

export function find(root: Node, predicate: (el: El) => boolean): El | undefined {
  return findAll(root, predicate)[0];
}

export function byTestId(root: Node, id: string): El | undefined {
  return find(root, (el) => el.attrs['data-testid'] === id);
}

export function allByTestId(root: Node, id: string): readonly El[] {
  return findAll(root, (el) => el.attrs['data-testid'] === id);
}

/**
 * Implicit ARIA roles for the handful of tags these screens use.
 *
 * Deliberately short: a role that is not in this table is one the POS does not
 * use, and adding one should be a decision rather than an accident.
 */
const IMPLICIT_ROLE: Readonly<Record<string, string>> = Object.freeze({
  button: 'button',
  a: 'link',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  ul: 'list',
  ol: 'list',
  li: 'listitem',
  table: 'table',
  form: 'form',
  main: 'main',
  nav: 'navigation',
  header: 'banner',
  section: 'region',
});

export function roleOf(el: El): string | undefined {
  const explicit = el.attrs['role'];
  if (typeof explicit === 'string') return explicit;
  if (el.tag === 'input' && el.attrs['type'] === 'submit') return 'button';
  if (el.tag === 'input' && (el.attrs['type'] === 'text' || el.attrs['type'] === 'tel')) {
    return 'textbox';
  }
  return IMPLICIT_ROLE[el.tag];
}

export function byRole(root: Node, role: string): readonly El[] {
  return findAll(root, (el) => roleOf(el) === role);
}

/** All text in an element, concatenated. What a screen reader would read out. */
export function textOf(node: Node): string {
  if (typeof node === 'string') return node;
  return node.children.map(textOf).join('');
}

/**
 * The accessible name: `aria-label`, else the element's own text.
 *
 * Not a full accessible-name computation — it covers `aria-label` and content,
 * which is what these screens use. Anything relying on `aria-labelledby` would
 * need this extended, and a test would catch the omission as an empty name.
 */
export function accessibleName(el: El): string {
  const label = el.attrs['aria-label'];
  if (typeof label === 'string') return label;
  return textOf(el).trim();
}

/** Elements a keyboard can reach, in document order. */
export function focusOrder(root: Node): readonly El[] {
  return findAll(root, (el) => {
    if (el.attrs['disabled'] === true) return false;
    if (el.attrs['tabindex'] === '-1' || el.attrs['tabindex'] === -1) return false;
    // A hidden input is not keyboard-reachable. Counting it would make a focus
    // order assertion pass while the real tab order differed.
    if (el.tag === 'input' && el.attrs['type'] === 'hidden') return false;
    if (el.tag === 'button' || el.tag === 'a' || el.tag === 'input' || el.tag === 'select') {
      return true;
    }
    return el.attrs['tabindex'] !== undefined;
  });
}

/**
 * Build real DOM from the same tree.
 *
 * Used only by the browser client. Typed against a minimal structural interface
 * so this package never needs DOM library types, and so a test can pass a stub.
 */
export interface DomLike {
  createElement(tag: string): DomElement;
  createTextNode(text: string): DomNode;
}

export interface DomNode {
  appendChild(child: DomNode): unknown;
}

export interface DomElement extends DomNode {
  setAttribute(name: string, value: string): void;
}

export function mount(document: DomLike, node: Node): DomNode {
  if (typeof node === 'string') return document.createTextNode(node);
  const el = document.createElement(node.tag);
  for (const [key, value] of Object.entries(node.attrs)) {
    if (value === undefined || value === false) continue;
    el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of node.children) el.appendChild(mount(document, child));
  return el;
}
