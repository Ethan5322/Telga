import { readFileSync } from 'node:fs';
import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The allowed-host list, read from the one file that owns it.
 *
 * Read at config-evaluation time rather than duplicated here, so
 * `allowNavigation` and the connect screen's validation cannot drift apart.
 * `readFileSync` rather than a JSON import: this file is evaluated by
 * Capacitor's own TypeScript loader, whose module settings are not this
 * repository's, and a plain file read works the same under all of them.
 */
const shell = JSON.parse(readFileSync(`${__dirname}/shell.config.json`, 'utf8')) as {
  allowedHosts: string[];
};

/**
 * The Telga Android shell.
 *
 * ## What this is, stated plainly
 *
 * Telga's screens are rendered by the Telga server. This project does not
 * reimplement them, and it must not: a second implementation of a vending flow
 * is a second place for a duplicate sale to come from. What it does is package
 * the existing app as an installable Android application so it can be listed on
 * Google Play, and give it the one thing a browser tab does not have — a
 * launcher icon, its own task in the app switcher, and an update channel.
 *
 * The web app is untouched by this. `npm run training:serve` behaves exactly as
 * it did, and the PWA install route in [[Phone and POS Install]] still works.
 * This is additive.
 *
 * ## Why there is no `server.url` here
 *
 * The obvious way to build this is to point the WebView at a fixed address.
 * That is wrong for Telga's situation: the production address does not exist
 * yet, and during the pilot each deployment may differ. Baking one in would
 * mean a new APK, a new store review and a new rollout for every address
 * change, and an app that cannot be pointed anywhere is useless the moment the
 * address is wrong.
 *
 * So the shell ships `www/index.html`, which asks for the address once, keeps
 * it, and navigates. `allowNavigation` below is what permits that navigation to
 * leave the bundled asset and reach a Telga server.
 *
 * ## Why HTTPS only, and what that costs
 *
 * `androidScheme: 'https'` and no cleartext permission. A merchant PIN and a
 * session cookie travel over this connection, and a shop's wi-fi is not a
 * trusted network.
 *
 * The cost is real and should not be discovered later: **this app cannot talk
 * to a LAN server with a self-signed certificate.** The WebView will reject it,
 * and the correct response to that is a real certificate, not a trust
 * exception — an app that ignores certificate errors is an app with no
 * transport security at all. Self-signed LAN use stays on the PWA route, where
 * the browser at least shows the warning to a human who can judge it.
 *
 * ## What `allowNavigation` is doing
 *
 * Restricting where the WebView may go. Without it Capacitor keeps the app on
 * its own origin and opens everything else in the system browser, which would
 * put Telga's own screens outside the app. With `*` it would follow any link
 * anywhere, inside the app's chrome — so a single injected link would become a
 * convincing place to ask for a PIN.
 *
 * The list is therefore explicit. `*.telga.et` and `*.mulesoo.et` are the
 * intended production and staging domains and are **not yet registered** — they
 * are placeholders recorded as such in ASSUMPTIONS, not a claim that they
 * exist. Until they do, the app is pointed at whatever address MuleSoo gives a
 * merchant, and any address outside this list is refused by the connect screen
 * before it is ever saved.
 */
const config: CapacitorConfig = {
  appId: 'et.mulesoo.telga',
  appName: 'Telga',
  webDir: 'www',
  android: {
    // The shell holds no data of its own — everything lives on the server and
    // in the session cookie. Allowing a device backup to copy the WebView's
    // storage would copy a live session off the phone.
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
  },
  server: {
    androidScheme: 'https',
    allowNavigation: shell.allowedHosts,
  },
};

export default config;
