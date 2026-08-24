---
title: Local Certificate Handling
type: engineering
status: draft
owner: telga
created: 2026-08-21
updated: 2026-08-21
tags:
  - telga
  - engineering
  - security
  - transport
  - certificates
related:
  - "[[00 Home]]"
  - "[[Training HTTPS Deployment]]"
  - "[[TLS and Proxy Configuration]]"
  - "[[Security Model]]"
  - "[[Threat Model]]"
depends_on:
  - "[[Training HTTPS Deployment]]"
decision_status: accepted
---

# Local Certificate Handling

Where a certificate comes from, where its key lives, and what Telga refuses to
do with either.

> [!danger] Telga never generates a certificate or a key
> Not at startup, not on a missing file, not "just for training". A tool that
> quietly creates a key creates one somewhere — and somewhere becomes a
> repository, a backup, or an image. `TRAINING_HTTPS` requires explicit
> `--tls-cert` and `--tls-key` paths and refuses to start without them
> (`TLS_CERTIFICATE_REQUIRED` / `TLS_PRIVATE_KEY_REQUIRED`, exit 4).

## What is stored, and where

| Thing | Where | In the repository? |
|---|---|---|
| Certificate | A path you choose | **No** |
| Private key | A path you choose | **No** — `check-committed.mjs` refuses `.pem` and `.key` |
| Fingerprint | Printed at startup | It is a public value |

`scripts/check-committed.mjs` refuses to let `.pem`, `.key`, `credentials` or
`secrets.*` be tracked. That is not advice; it fails the build.

## Making one for the training machine

Any tool works. `mkcert` produces a certificate a local browser trusts, which
avoids the warning screen; `openssl` produces a plain self-signed one.

```bash
mkdir -p /etc/telga/tls && cd /etc/telga/tls

openssl req -x509 -newkey rsa:2048 -nodes -days 90 \
  -keyout key.pem -out cert.pem \
  -subj "/CN=telga-training.local" \
  -addext "subjectAltName=DNS:telga-training.local,DNS:localhost,IP:127.0.0.1"

chmod 600 key.pem
```

The SAN entries matter: a certificate without them is rejected by every current
browser regardless of its common name.

## What Telga checks at startup

| Check | Refusal |
|---|---|
| The certificate file is readable | `TLS_CERTIFICATE_UNREADABLE` |
| The key file is readable | `TLS_PRIVATE_KEY_UNREADABLE` |
| The certificate parses as X.509 | `TLS_CERTIFICATE_INVALID` |
| The key parses as a private key | `TLS_PRIVATE_KEY_INVALID` |
| **The key belongs to the certificate** | `TLS_CERTIFICATE_KEY_MISMATCH` |

The pair check compares **derived public keys as DER**, so neither input is
reported. Without it, a mismatched pair fails per-connection during the
handshake — at the worst possible moment, as an error a browser renders as an
unexplained failure.

Two further facts are **reported, not refused**:

- an expired or not-yet-valid certificate, printed as a warning;
- on POSIX, a key file readable by group or others. On Windows the POSIX mode
  bits are not meaningful, so the check reports nothing rather than becoming a
  portability bug dressed as a security one.

## What a message may contain

A **path**, and why the operation failed. Never contents.

```
Refused: The file at "/etc/telga/tls/key.pem" is not a readable private key
  [TLS_PRIVATE_KEY_INVALID]
```

There is a test for exactly this: a file containing
`-----BEGIN PRIVATE KEY-----\nSUPERSECRETVALUE\n...` produces a message naming
the file and **not** containing `SUPERSECRETVALUE`.

The startup banner prints subject, issuer, validity and the SHA-256
fingerprint — the fingerprint is a public value and is what an operator compares
to confirm they are looking at the right certificate.

## Self-signed is not trust

The banner says so, in the output, every time:

```
  A self-signed certificate is NOT production trust. Browsers will warn, and
  should. It encrypts the wire for the controlled training machine; it proves
  nothing about who is on the other end.
```

A self-signed certificate stops a passive listener reading a session token off
the wire. It does nothing about an active attacker who substitutes their own
certificate, because nothing distinguishes theirs from ours. That is why **A53
is reduced and not closed**.

## Certificates in the tests

The tests generate one **in memory**, from `node:crypto`, with a hand-written
minimal DER encoder in `tests/transport/certs.ts` and again in
`scripts/https-smoke.mjs`.

Why not a fixture file or `openssl`:

- A committed certificate means a committed **private key**, and
  `check-committed.mjs` refuses that — rightly.
- Shelling out to `openssl` makes the TLS tests depend on a binary present on
  this machine and not guaranteed on a runner. That is the kind of dependency
  that turns into a skipped test, and a skipped security test is worse than none
  because it looks like coverage.

So the certificate is built from a keypair, a hand-encoded X.509 body and a
signature over it. Nothing touches the disk unless a test writes it to a
temporary directory it then deletes. `node:crypto` can *parse* X.509 but not
create it, which is why the encoder exists.

## Rotation

Not automated. On a training machine:

1. Write the new pair beside the old.
2. Stop the POS — `SIGTERM`, which drains in-flight requests within the
   shutdown budget.
3. Start it pointing at the new paths.
4. Confirm the new fingerprint in the banner.

Sessions survive: they are server-side rows, unrelated to the certificate.

## Related

- [[Training HTTPS Deployment]]
- [[TLS and Proxy Configuration]]
- [[Security Model]]
- [[Threat Model]]

---
Back to [[00 Home]]
