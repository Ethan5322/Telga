/**
 * Reading a registration form that has photographs attached.
 *
 * This parser exists rather than being installed because `better-sqlite3` is the
 * project's only runtime dependency and this one would be parsing
 * attacker-controlled bytes on an administrative console. Writing it means
 * owning it, so the cases below are the ones a hand-written multipart parser
 * gets wrong:
 *
 *   - **binary survival** — decoding a JPEG as UTF-8 and re-encoding it produces
 *     a file of the right length that will not open, which no size check
 *     catches;
 *   - **the trailing CRLF** before a delimiter belongs to the delimiter, and
 *     keeping it corrupts every file by two bytes;
 *   - **an empty file input**, which a browser always sends and which is absence,
 *     not error;
 *   - **bounds**, because a parser without them is a way to exhaust memory.
 */

import { describe, expect, it } from 'vitest';
import { MultipartError, boundaryOf, parseMultipart } from '@telga/api';

const BOUNDARY = '----WebKitFormBoundaryX7mA9';

/** Build a body the way a browser does, from real bytes. */
function body(
  parts: readonly {
    name: string;
    value?: string;
    filename?: string;
    mediaType?: string;
    content?: Buffer;
  }[],
  boundary = BOUNDARY,
): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`, 'utf8'));
    if (part.filename === undefined) {
      chunks.push(
        Buffer.from(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n`, 'utf8'),
      );
      chunks.push(Buffer.from(part.value ?? '', 'utf8'));
    } else {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
            `Content-Type: ${part.mediaType ?? 'application/octet-stream'}\r\n\r\n`,
          'utf8',
        ),
      );
      chunks.push(part.content ?? Buffer.alloc(0));
    }
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return Buffer.concat(chunks);
}

/** Every byte value, so "binary survives" is not a claim about ASCII. */
const EVERY_BYTE = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

describe('the boundary', () => {
  it('is read from a browser content-type, quoted or not', () => {
    expect(boundaryOf(`multipart/form-data; boundary=${BOUNDARY}`)).toBe(BOUNDARY);
    expect(boundaryOf(`multipart/form-data; boundary="${BOUNDARY}"`)).toBe(BOUNDARY);
    expect(boundaryOf(`MULTIPART/FORM-DATA; BOUNDARY=${BOUNDARY}`)).toBe(BOUNDARY);
  });

  it('is absent for anything that is not a multipart form', () => {
    for (const header of [
      undefined,
      'application/x-www-form-urlencoded',
      'application/json',
      'multipart/form-data',
      'multipart/form-data; boundary=',
    ]) {
      expect(boundaryOf(header), String(header)).toBeUndefined();
    }
  });

  it('refuses a boundary with characters RFC 2046 does not allow', () => {
    // A boundary is used to split bytes. Refusing an exotic one keeps the door
    // shut on somebody later putting it into a regular expression.
    expect(boundaryOf('multipart/form-data; boundary=a(b)|c')).toBeUndefined();
    expect(boundaryOf(`multipart/form-data; boundary=${'x'.repeat(71)}`)).toBeUndefined();
  });
});

describe('a registration form with documents attached', () => {
  it('reads the text fields and the files together', () => {
    const form = parseMultipart(
      body([
        { name: 'legalName', value: 'Abebe Airtime Shop' },
        { name: 'tin', value: 'TIN-0012345678' },
        {
          name: 'photoIdFile',
          filename: 'passport.jpg',
          mediaType: 'image/jpeg',
          content: EVERY_BYTE,
        },
      ]),
      BOUNDARY,
    );

    expect(form.fields['legalName']).toBe('Abebe Airtime Shop');
    expect(form.fields['tin']).toBe('TIN-0012345678');
    expect(form.files).toHaveLength(1);
    expect(form.files[0]).toMatchObject({
      name: 'photoIdFile',
      filename: 'passport.jpg',
      mediaType: 'image/jpeg',
    });
  });

  it('returns a file byte for byte', () => {
    // The bug this exists to prevent: a file of exactly the right length that
    // will not open, because it was decoded as text on the way through.
    const form = parseMultipart(
      body([
        { name: 'a', filename: 'x.jpg', mediaType: 'image/jpeg', content: EVERY_BYTE },
      ]),
      BOUNDARY,
    );
    expect(form.files[0]?.content).toEqual(EVERY_BYTE);
    expect(form.files[0]?.content.byteLength).toBe(256);
  });

  it('does not keep the CRLF that belongs to the delimiter', () => {
    // Two bytes at the end of every file, invisible until somebody opens one.
    const content = Buffer.from('exactly-this', 'utf8');
    const form = parseMultipart(
      body([{ name: 'a', filename: 'x.pdf', mediaType: 'application/pdf', content }]),
      BOUNDARY,
    );
    expect(form.files[0]?.content).toEqual(content);
  });

  it('handles three files, which is what the form actually sends', () => {
    const form = parseMultipart(
      body([
        { name: 'ownerName', value: 'Abebe Bekele' },
        { name: 'licenceFile', filename: 'l.jpg', mediaType: 'image/jpeg', content: EVERY_BYTE },
        { name: 'tinFile', filename: 't.png', mediaType: 'image/png', content: EVERY_BYTE },
        { name: 'photoIdFile', filename: 'p.pdf', mediaType: 'application/pdf', content: EVERY_BYTE },
      ]),
      BOUNDARY,
    );
    expect(form.files.map((f) => f.name)).toEqual(['licenceFile', 'tinFile', 'photoIdFile']);
    expect(form.fields['ownerName']).toBe('Abebe Bekele');
  });

  it('treats an unchosen file input as absence, not error', () => {
    // Every browser sends this for "no file chosen": a part with an empty
    // filename and no content.
    const form = parseMultipart(
      body([
        { name: 'legalName', value: 'A Shop' },
        { name: 'licenceFile', filename: '', mediaType: 'application/octet-stream' },
      ]),
      BOUNDARY,
    );
    expect(form.files).toHaveLength(0);
    expect(form.fields['legalName']).toBe('A Shop');
  });

  it('keeps an empty text field as an empty string, which is a different thing', () => {
    const form = parseMultipart(body([{ name: 'email', value: '' }]), BOUNDARY);
    expect(form.fields['email']).toBe('');
    expect('email' in form.fields).toBe(true);
  });

  it('refuses a body whose content contains the boundary, rather than guessing', () => {
    // Written first as "parses it correctly", which was wrong: multipart has no
    // escaping, and the format's entire answer to this is that a sender must
    // choose a boundary the content does not contain. Browsers do — the
    // boundary is random precisely so it cannot collide.
    //
    // So the property worth holding is not that it parses, but that it does not
    // *silently mis-parse*. A crafted body ends in a refusal.
    //
    // This is not a vulnerability: a caller crafting their own request could
    // send whatever fields they liked directly, so injecting into their own body
    // gains them nothing. It is a correctness boundary, and it is a refusal.
    expect(() =>
      parseMultipart(
        body([{ name: 'address', value: `Bole Road, not --${BOUNDARY} really` }]),
        BOUNDARY,
      ),
    ).toThrow(MultipartError);
  });

  it('is untroubled by content that merely resembles a boundary', () => {
    // The realistic case: an address with dashes in it.
    const form = parseMultipart(
      body([{ name: 'address', value: 'Bole Road -- near the roundabout --- opposite the bank' }]),
      BOUNDARY,
    );
    expect(form.fields['address']).toBe('Bole Road -- near the roundabout --- opposite the bank');
  });
});

describe('what it refuses', () => {
  it('refuses a body with no delimiter in it at all', () => {
    expect(() => parseMultipart(Buffer.from('not a form', 'utf8'), BOUNDARY)).toThrow(
      MultipartError,
    );
  });

  it('refuses a part with no name', () => {
    const malformed = Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data\r\n\r\nvalue\r\n--${BOUNDARY}--\r\n`,
      'utf8',
    );
    expect(() => parseMultipart(malformed, BOUNDARY)).toThrow(MultipartError);
  });

  it('refuses a part whose headers never end', () => {
    const truncated = Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="a"`,
      'utf8',
    );
    expect(() => parseMultipart(truncated, BOUNDARY)).toThrow(MultipartError);
  });

  it('refuses more parts than a registration form could have', () => {
    // A parser without bounds is a way to exhaust memory from a socket.
    const many = Array.from({ length: 40 }, (_, i) => ({ name: `f${String(i)}`, value: 'x' }));
    expect(() => parseMultipart(body(many), BOUNDARY)).toThrow(MultipartError);
    try {
      parseMultipart(body(many), BOUNDARY);
    } catch (error) {
      expect((error as MultipartError).refusal).toBe('TOO_MANY_PARTS');
    }
  });
});
