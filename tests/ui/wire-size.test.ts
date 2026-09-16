/**
 * What a shop on a poor connection actually downloads.
 *
 * Founder, 2026-09-16: *"It feels slow to open on a phone and POS, especially
 * on a poor connection."*
 *
 * ## Measured before anything was changed
 *
 * ```
 * login page, uncompressed     ~90,000 bytes
 * content-encoding             none
 * compression in the tree      none
 * STYLES                       70,608 bytes, 41% comments
 * CLIENT_SCRIPT                12,092 bytes, 58% comments
 * ```
 *
 * About **36 KB of source documentation** on every page load, and the HTML is
 * deliberately `no-store`, so none of it is ever reused. On a 50 KB/s
 * connection that is roughly 1.8 seconds per screen for bytes that do not
 * change.
 *
 * These tests hold the two things that fixed it — the comments do not ship, and
 * the bytes compress — as budgets rather than as history. A budget fails when
 * somebody adds weight, which is the only time anybody would want to know.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const read = (rel: string): string => readFileSync(resolve(process.cwd(), rel), 'utf-8');
const SERVER = 'apps/merchant-pos/src/server.ts';
const DOCUMENT = 'apps/merchant-pos/src/ui/document.ts';

/** One template literal out of `document.ts`, as authored. */
function literal(name: 'CLIENT_SCRIPT' | 'STYLES'): string {
  const source = read(DOCUMENT);
  const at = source.indexOf(`const ${name}`);
  const open = source.indexOf('= `', at) + 3;
  return source.slice(open, source.indexOf('`;', open));
}

const stripBlocks = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '');

describe('the comments stay in the source and stay off the wire', () => {
  it('ships a stylesheet meaningfully smaller than the one authored', () => {
    const authored = Buffer.byteLength(literal('STYLES'), 'utf-8');
    const shipped = Buffer.byteLength(stripBlocks(literal('STYLES')), 'utf-8');

    expect(authored, 'the stylesheet should still be documented').toBeGreaterThan(40_000);
    expect(
      shipped / authored,
      `stripping saves ${String(authored - shipped)} bytes on every page load`,
    ).toBeLessThan(0.8);
  });

  it('renders from the stripped copies, not the authored ones', () => {
    // The strip is worthless if `htmlDocument` still interpolates the originals.
    const source = read(DOCUMENT);
    expect(source).toContain('SHIPPED_STYLES');
    expect(source).toContain('SHIPPED_SCRIPT');
    expect(source, 'the raw literals must not reach the document').not.toContain('${STYLES}');
    expect(source).not.toContain('${CLIENT_SCRIPT}');
  });

  it('keeps the documentation in the file', () => {
    // The point is to stop shipping them, never to stop writing them. This
    // stylesheet records why the rubric was darkened and why there are no
    // cards; a future reader needs that more than a byte count does.
    const authored = literal('STYLES');
    expect(authored, 'the stylesheet is still documented').toContain('/*');
    expect(authored.match(/\/\*/g)?.length ?? 0).toBeGreaterThan(20);
  });
});

describe('what goes down the wire is compressed', () => {
  it('gzips a page to a fraction of its size', () => {
    // The real ratio on the real bytes, rather than a remembered rule of thumb.
    const body = stripBlocks(literal('STYLES')) + stripBlocks(literal('CLIENT_SCRIPT'));
    const raw = Buffer.from(body, 'utf-8');
    const packed = gzipSync(raw, { level: 6 });

    expect(
      packed.byteLength / raw.byteLength,
      `${String(raw.byteLength)} bytes compress to ${String(packed.byteLength)}`,
    ).toBeLessThan(0.25);
  });

  it('compresses at the one place the request and the response meet', () => {
    /**
     * The first attempt put gzip inside `respondHtml` behind an **optional**
     * `request` parameter. Eighteen callers, none passing it — so it would have
     * shipped switched off.
     *
     * That is the same no-callers failure this session found in
     * `runDueSoftwareFees`, in `tenantRouting`, and in `redeemEnrollmentToken`.
     * Optional parameters are how it happens.
     */
    const server = read(SERVER);
    expect(server, 'the wrapper must exist').toContain('withCompression');
    expect(server, 'and both servers must use it').not.toMatch(
      /createServer\(handler\)|createTlsServer\([^)]*,\s*handler\)/,
    );
  });

  it('tells caches that the body depends on what the client asked for', () => {
    // Without `vary`, a cache can hand a gzipped body to a client that did not
    // ask for one — which reaches a shopkeeper as a page of nonsense.
    const server = read(SERVER);
    const at = server.indexOf('withCompression');
    const block = server.slice(at, at + 4000);
    expect(block).toContain("'vary'");
    expect(block).toContain('accept-encoding');
  });

  it('drops a content-length it can no longer honour', () => {
    // A length measured before compression describes bytes that are no longer
    // being sent. A browser that trusts it truncates the page.
    const server = read(SERVER);
    const at = server.indexOf('withCompression');
    const block = server.slice(at, at + 4000);
    expect(block).toMatch(/delete .*content-length/i);
  });

  it('leaves small responses alone', () => {
    // Below roughly a kilobyte the gzip header costs more than it saves.
    const server = read(SERVER);
    const at = server.indexOf('withCompression');
    expect(server.slice(at, at + 4000)).toContain('1024');
  });

  it('never lets a compression failure cost a screen', () => {
    const server = read(SERVER);
    const at = server.indexOf('withCompression');
    const block = server.slice(at, at + 4000);
    // The raw body is sent when gzip errors.
    expect(block).toMatch(/error \? raw : packed/);
  });
});

describe('what was deliberately not done', () => {
  it('leaves no-store on the HTML exactly as it was', () => {
    /**
     * Caching the HTML would save more than compression does — but a POS is a
     * shared machine, and the header exists so a back button cannot re-render
     * the previous operator's balance from cache. That is a security decision
     * and a performance pass does not get to trade it away.
     */
    const headers = read('apps/merchant-pos/src/transport/headers.ts');
    expect(headers).toContain('no-store');
    expect(headers).toContain('must-revalidate');
  });
});
