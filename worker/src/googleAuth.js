/**
 * Google service-account auth for Workers.
 *
 * There's no Node-style `googleapis` SDK available in the Workers
 * runtime, so this hand-rolls the standard service-account flow:
 *   1. Build a JWT claiming the Sheets scope, signed with the service
 *      account's RSA private key (RS256) via Web Crypto.
 *   2. Exchange that JWT for a short-lived OAuth access token at
 *      Google's token endpoint.
 *   3. Cache the access token in KV so every request doesn't re-sign
 *      and re-exchange a fresh JWT (Google tokens last ~1 hour).
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const KV_TOKEN_KEY = "googletoken";

// Refresh a bit before Google's stated 3600s expiry so a request never
// races an about-to-expire token.
const TOKEN_SAFETY_MARGIN_SECONDS = 300;

function base64UrlEncode(bytes) {
  let binary = "";
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlEncodeString(str) {
  return base64UrlEncode(new TextEncoder().encode(str));
}

/**
 * Converts a PEM-formatted PKCS#8 private key (the "private_key" field
 * straight out of the service account JSON, newlines included) into a
 * CryptoKey usable for RS256 signing.
 */
async function importPrivateKey(pem) {
  const pemContents = pem
    // The secret is typically pasted straight from the service account
    // JSON, where newlines are the literal two-character sequence "\n"
    // (backslash + n), not real line breaks — convert those to real
    // whitespace first so the next line's \s+ strip actually removes
    // them. Without this, a stray backslash stays in the base64 payload
    // and atob() throws "invalid base64-encoded data".
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const binaryDer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));

  return crypto.subtle.importKey(
    "pkcs8",
    binaryDer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

async function signJwt(clientEmail, privateKeyPem) {
  const nowSeconds = Math.floor(Date.now() / 1000);

  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: clientEmail,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + 3600
  };

  const unsigned = `${base64UrlEncodeString(JSON.stringify(header))}.${base64UrlEncodeString(JSON.stringify(claims))}`;

  const key = await importPrivateKey(privateKeyPem);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned)
  );

  return `${unsigned}.${base64UrlEncode(signature)}`;
}

async function fetchFreshAccessToken(env) {
  const assertion = await signJwt(env.GOOGLE_CLIENT_EMAIL, env.GOOGLE_PRIVATE_KEY);

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });

  const data = await response.json();
  if (!response.ok || !data.access_token) {
    throw new Error(`Google token exchange failed: ${data.error_description || data.error || response.status}`);
  }

  return { accessToken: data.access_token, expiresInSeconds: data.expires_in || 3600 };
}

// Isolate-local access-token cache, layered in front of the KV copy. A
// single request commonly makes several Sheets API calls — a write reads
// the header row, finds the matching row, then sets it (3+ calls) — and
// each sheetsFetch() would otherwise do its own KV read for the token.
// Caching it in the isolate collapses those to one, and also spares
// repeated requests landing on a warm isolate. KV stays the cross-isolate
// source of truth (and the authority on real expiry); this is only a front
// layer, mirroring the isolate-local caches already used in readCache.js
// (inFlightFetches) and auth.js (rate-limit counters).
let isolateToken = null; // { token, expiresAtMs }

/**
 * Returns a valid Google OAuth access token, reusing a cached one —
 * from the isolate first, then KV — so a normal read/write doesn't pay
 * for a fresh JWT sign + token exchange (or even a KV read) on every
 * single Sheets API call.
 */
export async function getAccessToken(env) {
  if (isolateToken && Date.now() < isolateToken.expiresAtMs) {
    return isolateToken.token;
  }

  const cached = await env.NJWG_KV.get(KV_TOKEN_KEY);
  if (cached) {
    // KV doesn't expose a key's remaining TTL, so hold a KV-sourced token
    // in the isolate only briefly — long enough to cover a burst of Sheets
    // calls in one request, short enough that KV (which DOES expire the
    // token near the ~1h mark) stays the authority on when it's really
    // gone. Serving it for up to this window is safe regardless, since a
    // token is only ever rotated once the old one is already within its
    // TOKEN_SAFETY_MARGIN_SECONDS and thus still valid for minutes more.
    isolateToken = { token: cached, expiresAtMs: Date.now() + 60 * 1000 };
    return cached;
  }

  const { accessToken, expiresInSeconds } = await fetchFreshAccessToken(env);
  const ttl = Math.max(60, expiresInSeconds - TOKEN_SAFETY_MARGIN_SECONDS);
  await env.NJWG_KV.put(KV_TOKEN_KEY, accessToken, { expirationTtl: ttl });
  isolateToken = { token: accessToken, expiresAtMs: Date.now() + ttl * 1000 };

  return accessToken;
}
