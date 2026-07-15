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

/**
 * Returns a valid Google OAuth access token, reusing a cached one from
 * KV when possible so a normal read/write doesn't pay for a fresh
 * JWT sign + token exchange on every single request.
 */
export async function getAccessToken(env) {
  const cached = await env.NJWG_KV.get(KV_TOKEN_KEY);
  if (cached) return cached;

  const { accessToken, expiresInSeconds } = await fetchFreshAccessToken(env);
  const ttl = Math.max(60, expiresInSeconds - TOKEN_SAFETY_MARGIN_SECONDS);
  await env.NJWG_KV.put(KV_TOKEN_KEY, accessToken, { expirationTtl: ttl });

  return accessToken;
}
