/**
 * Web Push (VAPID + RFC 8291 "aes128gcm") for the Workers runtime.
 *
 * There's no Node `web-push` SDK in Workers, so this hand-rolls the two
 * standard pieces using Web Crypto:
 *
 *   1. VAPID (RFC 8292): an ES256 JWT signed with the application
 *      server's P-256 VAPID key, identifying us to the push service.
 *   2. Payload encryption (RFC 8291 over RFC 8188 aes128gcm): an
 *      ephemeral ECDH with the subscription's public key, HKDF to derive
 *      the content-encryption key + nonce, then AES-128-GCM.
 *
 * The VAPID keypair (env.VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY, the raw
 * base64url form emitted by `web-push generate-vapid-keys`) is the
 * server's long-lived identity. A SEPARATE ephemeral ECDH keypair is
 * generated per message for the encryption — don't conflate the two.
 *
 * encryptContent() accepts injectable salt/ephemeral keys purely so the
 * encryption can be verified against a reference decryptor in tests; in
 * production those are always randomly generated per message.
 */

// ---- base64url <-> bytes ---------------------------------------------------

function bytesToBase64Url(bytes) {
  let binary = "";
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/").padEnd(str.length + ((4 - (str.length % 4)) % 4), "=");
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function utf8(str) {
  return new TextEncoder().encode(str);
}

function concatBytes(...chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

// ---- HKDF (SHA-256), one extract+expand per call ---------------------------

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, { name: "HKDF" }, false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    key,
    length * 8
  );
  return new Uint8Array(bits);
}

// ---- RFC 8291 payload encryption (single aes128gcm record) -----------------

/**
 * Encrypts `plaintext` (Uint8Array) for a subscription's public key.
 *   uaPublic   — Uint8Array(65), the subscription p256dh (0x04||X||Y)
 *   authSecret — Uint8Array(16), the subscription auth secret
 * opts.salt / opts.serverKeys let a test pin them; both are random in
 * production. Returns the full aes128gcm body (header || ciphertext).
 */
export async function encryptContent(uaPublic, authSecret, plaintext, opts = {}) {
  const salt = opts.salt || crypto.getRandomValues(new Uint8Array(16));
  const serverKeys = opts.serverKeys || await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]
  );

  const serverPublic = new Uint8Array(await crypto.subtle.exportKey("raw", serverKeys.publicKey)); // 65 bytes

  const uaPublicKey = await crypto.subtle.importKey(
    "raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []
  );

  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: uaPublicKey }, serverKeys.privateKey, 256
  ));

  // RFC 8291 §3.4: derive the input keying material from the ECDH secret,
  // salted with the auth secret and bound to both public keys.
  const keyInfo = concatBytes(utf8("WebPush: info\0"), uaPublic, serverPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  // RFC 8188 §2.2: content-encryption key + nonce from the record salt.
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);

  // Single, final record: plaintext followed by the 0x02 last-record
  // delimiter, then AES-128-GCM (Web Crypto appends the 16-byte tag).
  const record = concatBytes(plaintext, new Uint8Array([0x02]));
  const cekKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, tagLength: 128 }, cekKey, record
  ));

  // RFC 8188 §2.1 header: salt(16) || rs(4, big-endian) || idlen(1) || keyid.
  const recordSize = 4096;
  const header = new Uint8Array(16 + 4 + 1 + serverPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, recordSize, false);
  header[20] = serverPublic.length; // 65
  header.set(serverPublic, 21);

  return concatBytes(header, ciphertext);
}

// ---- VAPID (RFC 8292) ------------------------------------------------------

async function importVapidPrivateKey(vapidPublicB64Url, vapidPrivateB64Url) {
  const pub = base64UrlToBytes(vapidPublicB64Url); // 65 bytes: 0x04 || X(32) || Y(32)
  const jwk = {
    kty: "EC",
    crv: "P-256",
    d: vapidPrivateB64Url,
    x: bytesToBase64Url(pub.slice(1, 33)),
    y: bytesToBase64Url(pub.slice(33, 65)),
    ext: true
  };
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

async function signVapidJwt(env, audience) {
  const header = { typ: "JWT", alg: "ES256" };
  const payload = {
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: env.VAPID_SUBJECT || "mailto:admin@example.com"
  };
  const unsigned = `${bytesToBase64Url(utf8(JSON.stringify(header)))}.${bytesToBase64Url(utf8(JSON.stringify(payload)))}`;
  const key = await importVapidPrivateKey(env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  // ECDSA over Web Crypto returns the raw r||s (64 bytes) JWS ES256 wants.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(unsigned)));
  return `${unsigned}.${bytesToBase64Url(sig)}`;
}

// ---- Send ------------------------------------------------------------------

/**
 * Sends one push message. subscription is the PushSubscription.toJSON()
 * shape ({ endpoint, keys: { p256dh, auth } }); payloadObj is any
 * JSON-serializable object the service worker will receive. Returns the
 * raw fetch Response so the caller can prune 404/410 (gone) subscriptions.
 */
export async function sendPush(env, subscription, payloadObj, { ttl = 2419200 } = {}) {
  const endpoint = subscription.endpoint;
  const audience = new URL(endpoint).origin;
  const jwt = await signVapidJwt(env, audience);

  const plaintext = utf8(JSON.stringify(payloadObj));
  const uaPublic = base64UrlToBytes(subscription.keys.p256dh);
  const authSecret = base64UrlToBytes(subscription.keys.auth);
  const body = await encryptContent(uaPublic, authSecret, plaintext);

  return fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(ttl)
    },
    body
  });
}
