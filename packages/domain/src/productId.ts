/**
 * Reading a training product id.
 *
 * Product ids are built as `{network}_{type}_{rest}` — for example
 * `NETWORK_A_AIRTIME_2500` or `NETWORK_B_DATA_MONTHLY_1GB_30D`. Both the
 * network id and the remainder contain underscores of their own, so
 * `split('_')[0]` is wrong in both directions: it returned `NETWORK` rather
 * than `NETWORK_A`, which is why the Network line on every slip printed a
 * truncated id.
 *
 * This parser anchors on the **product type**, which is a closed set, so the
 * network is everything before it and the descriptor everything after. One
 * function, in the domain, so the API and the POS cannot disagree about what
 * a product id means.
 */

/** The product types a training product id may carry. */
export const PRODUCT_KINDS = ['AIRTIME', 'TOPUP', 'DATA'] as const;

export type ProductKind = (typeof PRODUCT_KINDS)[number];

export interface ParsedProductId {
  /** e.g. `NETWORK_A`. */
  readonly network: string;
  readonly kind: ProductKind;
  /** Everything after the kind, e.g. `2500` or `MONTHLY_1GB_30D`. */
  readonly descriptor: string;
}

const PATTERN = new RegExp(`^(.+?)_(${PRODUCT_KINDS.join('|')})_(.+)$`);

/**
 * Parse a voucher product id, or `undefined` for anything else.
 *
 * A legacy `/sell` sale carries a bare product id such as `AIRTIME` with no
 * network at all, and gets `undefined` — which callers read as "this is not a
 * voucher", not as an error.
 */
export function parseProductId(productId: string): ParsedProductId | undefined {
  const match = PATTERN.exec(productId);
  if (match === null) return undefined;
  return {
    network: match[1],
    kind: match[2] as ProductKind,
    descriptor: match[3],
  };
}

/**
 * A short human label for a product, for the slip's Service line.
 *
 * `NETWORK_A_AIRTIME_2500` reads as `Airtime`, not as a raw identifier — a
 * merchant handing over paper should not be showing a customer a database
 * key. The denomination is already on the slip's Amount line, so it is not
 * repeated here; a data bundle keeps its descriptor because that *is* what
 * was bought.
 */
export function productLabelFor(productId: string): string {
  const parsed = parseProductId(productId);
  if (parsed === undefined) return productId;
  switch (parsed.kind) {
    case 'AIRTIME':
      return 'Airtime';
    case 'TOPUP':
      return 'Airtime top-up';
    case 'DATA':
      return `Data — ${parsed.descriptor.replace(/_/g, ' ')}`;
  }
}
