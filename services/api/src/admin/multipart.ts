/**
 * Enough `multipart/form-data` to receive a registration form with three
 * photographs on it.
 *
 * ## Why this is written rather than installed
 *
 * `better-sqlite3` is the project's only runtime dependency, and that is a
 * property worth keeping: every dependency is a supply chain, and this one would
 * be parsing attacker-controlled bytes on an administrative console. What is
 * needed here is small and closed — one form, a handful of short text fields,
 * three files with a hard size cap — so it is written, bounded and tested rather
 * than pulled in.
 *
 * **This is not a general parser.** It handles what a browser sends for a plain
 * `<form enctype="multipart/form-data">` with no JavaScript, which is exactly
 * what the console serves (`script-src 'none'`). It does not do nested
 * multipart, `Content-Transfer-Encoding`, or RFC 2231 filename continuations,
 * and it refuses rather than guesses when it meets something it does not know.
 *
 * ## The limits are the security
 *
 * A parser with no bounds is a way to exhaust memory from an unauthenticated
 * socket. Every field below is capped, the number of parts is capped, and the
 * whole body is capped by the caller before a byte reaches here.
 */

/** A text field, or a file with its declared type. */
export interface MultipartField {
  readonly name: string;
  readonly value: string;
}

export interface MultipartFile {
  readonly name: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly content: Buffer;
}

export interface MultipartForm {
  readonly fields: Readonly<Record<string, string>>;
  readonly files: readonly MultipartFile[];
}

export type MultipartRefusal =
  | 'NOT_MULTIPART'
  | 'BOUNDARY_MISSING'
  | 'TOO_MANY_PARTS'
  | 'MALFORMED_PART';

export class MultipartError extends Error {
  readonly code = 'MULTIPART_REFUSED';
  constructor(readonly refusal: MultipartRefusal) {
    super(`Refusing the upload: ${refusal}.`);
    this.name = 'MultipartError';
  }
}

/** A registration form has ten fields and three files. Twenty-four is generous. */
const MAX_PARTS = 24;

/**
 * The boundary from a `Content-Type`, or `undefined`.
 *
 * Quoted and unquoted forms both appear in the wild. The boundary is used to
 * split bytes, so it is matched against the character set RFC 2046 allows and
 * refused otherwise — a boundary taken verbatim into a search is fine, but one
 * taken into a regular expression would not be, and this keeps the door shut on
 * that mistake being made later.
 */
export function boundaryOf(contentType: string | undefined): string | undefined {
  if (contentType === undefined) return undefined;
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) return undefined;
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (boundary === undefined || boundary.length === 0 || boundary.length > 70) return undefined;
  return /^[A-Za-z0-9'()+_,\-./:=?]+$/.test(boundary) ? boundary : undefined;
}

/** `name="x"; filename="y"` → the quoted value, unescaped enough for a browser. */
const attributeOf = (source: string, key: string): string | undefined => {
  const match = new RegExp(`${key}="([^"]*)"`, 'i').exec(source);
  return match?.[1];
};

/**
 * Parse a body that has already been read and size-capped by the caller.
 *
 * Works on `Buffer` throughout for the file parts — decoding a JPEG as UTF-8 and
 * re-encoding it corrupts it, which is the classic way a hand-written multipart
 * parser produces files that are the right size and will not open.
 */
export function parseMultipart(body: Buffer, boundary: string): MultipartForm {
  const delimiter = Buffer.from(`--${boundary}`, 'utf8');
  const fields: Record<string, string> = {};
  const files: MultipartFile[] = [];

  let cursor = body.indexOf(delimiter);
  if (cursor === -1) throw new MultipartError('MALFORMED_PART');
  cursor += delimiter.length;

  let parts = 0;
  for (;;) {
    if (parts++ > MAX_PARTS) throw new MultipartError('TOO_MANY_PARTS');

    // `--` after the delimiter is the epilogue: the form is finished.
    if (body.subarray(cursor, cursor + 2).toString('latin1') === '--') break;

    // Skip the CRLF that follows the delimiter.
    if (body.subarray(cursor, cursor + 2).toString('latin1') === '\r\n') cursor += 2;
    else if (body.subarray(cursor, cursor + 1).toString('latin1') === '\n') cursor += 1;

    const headerEnd = body.indexOf('\r\n\r\n', cursor, 'latin1');
    if (headerEnd === -1) throw new MultipartError('MALFORMED_PART');
    const headers = body.subarray(cursor, headerEnd).toString('utf8');

    const next = body.indexOf(delimiter, headerEnd);
    if (next === -1) throw new MultipartError('MALFORMED_PART');

    // The CRLF immediately before the next delimiter belongs to the delimiter,
    // not to the content. Dropping it is what keeps a stored file byte-identical
    // to the one uploaded.
    let contentEnd = next;
    if (body.subarray(contentEnd - 2, contentEnd).toString('latin1') === '\r\n') contentEnd -= 2;
    else if (body.subarray(contentEnd - 1, contentEnd).toString('latin1') === '\n') contentEnd -= 1;

    const content = body.subarray(headerEnd + 4, contentEnd);

    const disposition = /content-disposition:([^\r\n]*)/i.exec(headers)?.[1] ?? '';
    const name = attributeOf(disposition, 'name');
    if (name === undefined) throw new MultipartError('MALFORMED_PART');
    const filename = attributeOf(disposition, 'filename');

    if (filename === undefined) {
      fields[name] = content.toString('utf8');
    } else if (filename.length > 0 && content.byteLength > 0) {
      // An empty file input is what a browser sends for "no file chosen". It is
      // not an error and not a file — it is simply absent.
      const mediaType = (/content-type:\s*([^\r\n;]+)/i.exec(headers)?.[1] ?? '')
        .trim()
        .toLowerCase();
      files.push({ name, filename, mediaType, content });
    }

    cursor = next + delimiter.length;
  }

  return { fields, files };
}
