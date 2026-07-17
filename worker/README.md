# NJWG Encampment — Cloudflare Worker backend

The live backend for the app. Talks to the Google Sheet via the Sheets
API v4 using a service account. Exposes the
`action=read/batchRead/write/delete/login/deviceLogin/listPositions`
contract that `js/api.js` calls; `js/config.js`'s `APPS_SCRIPT_URL` points
at this Worker's URL.

(This replaced an earlier Google Apps Script backend, which has since been
retired and removed from the repo. Nothing else points at Apps Script
anymore.)

## One-time setup

### 1. Install dependencies

```
cd worker
npm install
```

### 2. Create the KV namespace

This needs your Cloudflare account. Since interactive `wrangler login`
requires a browser tied to your account, use an **API Token** instead
(works from anywhere, including headless environments):

1. Go to https://dash.cloudflare.com/profile/api-tokens
2. **Create Token** → **Edit Cloudflare Workers** template → scope it to
   your account → **Continue to summary** → **Create Token**
3. Copy the token, then in your terminal:
   ```
   export CLOUDFLARE_API_TOKEN="paste-the-token-here"
   ```
   (Add this to your shell profile if you don't want to re-export it
   every session — or just re-export it each time you deploy.)

Now create the KV namespace:

```
npx wrangler kv namespace create NJWG_KV
```

This prints something like:

```
[[kv_namespaces]]
binding = "NJWG_KV"
id = "abcd1234..."
```

Copy that `id` value into `worker/wrangler.toml`, replacing
`REPLACE_WITH_KV_NAMESPACE_ID`.

### 3. Set secrets

Each of these is set once with `wrangler secret put <NAME>` — it'll
prompt you to paste the value (never printed back, never committed
anywhere).

**`GOOGLE_CLIENT_EMAIL`** — the `client_email` field from your service
account's downloaded JSON key.

```
npx wrangler secret put GOOGLE_CLIENT_EMAIL
```

**`GOOGLE_PRIVATE_KEY`** — the `private_key` field from the same JSON,
**including the literal `\n` characters** exactly as they appear in the
JSON file (don't convert them to real newlines).

```
npx wrangler secret put GOOGLE_PRIVATE_KEY
```

**`SPREADSHEET_ID`** — from your Sheet's URL:
`https://docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`

```
npx wrangler secret put SPREADSHEET_ID
```

**`SESSION_SECRET`** — any long random string, used to sign device/
session tokens. Generate one with:

```
node -e "console.log(require('crypto').randomUUID() + require('crypto').randomUUID())"
```

```
npx wrangler secret put SESSION_SECRET
```

**`PASSPHRASE_HASH`** — the SHA-256 hex hash of your device-gate
passphrase (never store the plaintext passphrase anywhere). Compute it
with:

```
node -e "const c=require('crypto');console.log(c.createHash('sha256').update(process.argv[1]).digest('hex'))" "YOUR_PASSPHRASE_HERE"
```

This can be a **different passphrase** than the one `Code.gs` uses today
— they're independent systems while you're testing. Paste the resulting
hex string:

```
npx wrangler secret put PASSPHRASE_HASH
```

**`VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT`** —
*optional*, only needed for Web Push (New Announcement / Black Flag
alerts delivered to staff devices even when the app is closed). If you
skip these, push is simply disabled: the app hides its "enable alerts"
button and everything else works unchanged.

Generate the keypair once (the standard VAPID format this Worker expects):

```
npx web-push generate-vapid-keys
```

Set all three — the public and private keys from that command, plus a
`mailto:` (or `https:`) subject that identifies you to the push service:

```
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT     # e.g. mailto:admin@yourunit.org
```

The **public** key is not secret (the browser needs it to subscribe, and
the Worker serves it via the `pushConfig` action) — but setting it as a
secret alongside the private key keeps the pair together. Rotating the
VAPID keys invalidates every existing device subscription; staff just
re-tap "enable alerts" once.

Verify everything is set:

```
npx wrangler secret list
```

You should see the five required names (and any optional VAPID ones)
listed — values are never shown.

### 4. Confirm the Sheet is shared with the service account

Double check: open the Sheet → **Share** → the service account's email
(the same one as `GOOGLE_CLIENT_EMAIL`) should be listed as **Editor**.
If you haven't done this yet, do it now — every request will fail with
a permissions error from Google otherwise.

## Deploy

```
npx wrangler deploy
```

This prints the Worker's URL, something like:

```
https://njwg-encampment-api.YOUR-SUBDOMAIN.workers.dev
```

That's the new "exec URL" equivalent — save it, you'll need it for
testing and for the eventual `js/config.js` cutover.

## Testing directly (before touching the frontend)

Replace `WORKER_URL` and `YOUR_PASSPHRASE` below:

```
# 1. Unlock the device
curl -s -X POST "WORKER_URL" \
  -H "Content-Type: text/plain" \
  -d '{"action":"deviceLogin","passphrase":"YOUR_PASSPHRASE","deviceType":"personal"}'
```

You should get back `{"ok":true,"deviceToken":"...","deviceType":"personal"}`.
Copy the `deviceToken` value for the next calls.

```
# 2. List positions (needs the device token from step 1)
curl -s "WORKER_URL?action=listPositions&deviceToken=PASTE_DEVICE_TOKEN"
```

```
# 3. Log in as a position (adjust "position" to one from step 2's list;
#    add "password" if it's CCT/Administrator)
curl -s -X POST "WORKER_URL" \
  -H "Content-Type: text/plain" \
  -d '{"action":"login","deviceToken":"PASTE_DEVICE_TOKEN","position":"Alpha"}'
```

Copy the returned `token` (session token) for the next call.

```
# 4. Read a sheet
curl -s "WORKER_URL?action=read&sheet=Roster&deviceToken=PASTE_DEVICE_TOKEN&token=PASTE_SESSION_TOKEN"
```

If that returns real roster rows, the whole chain — JWT signing, Google
token exchange, Sheets API read, your own auth/session layer — is
working end to end.

## Testing in the actual app (still without touching production)

Don't edit the real `js/config.js` yet. Instead, temporarily override
`APPS_SCRIPT_URL` from the browser console on any page of the site (this
only affects your current tab):

```js
window.APP_CONFIG.APPS_SCRIPT_URL = "WORKER_URL";
```

Then reload and it'll be picked up (note: `Api` reads `BASE_URL` once at
module load, so you actually need to either set this via a query-param/
localStorage override, or just temporarily edit `js/config.js` locally
and run the site off your own machine — see below — rather than the
live GitHub Pages deployment).

Easiest path: run the site locally pointed at the Worker:

```
# from the repo root
cd /home/user/njwg-encampment
python3 -m http.server 8080
```

Then temporarily change `APPS_SCRIPT_URL` in your **local, uncommitted**
copy of `js/config.js` to the Worker URL, and browse to
`http://localhost:8080/gate.html`. Exercise every page — Overview,
Schedule, Roster (add/edit/delete a test cadet), Inspections (submit a
scorecard), Announcements (post one, toggle black flag) — before
deciding this is ready.

**Don't commit that local `js/config.js` change** — revert it once
you're done testing, or wait until you're ready for the real cutover.

## Cutting over for real

Once you're confident:

1. Edit the real `js/config.js`: change `APPS_SCRIPT_URL` to the Worker
   URL.
2. Commit and push.
3. Keep the Apps Script deployment around for a while as a fallback —
   if something's wrong with the Worker, reverting `js/config.js` to the
   old `/exec` URL brings it back instantly.

## Ongoing maintenance

- **Logs:** `npx wrangler tail` streams live request logs while you
  exercise the app — useful for catching errors during testing.
- **Redeploy after code changes:** `npx wrangler deploy`.
- **Rotating the passphrase:** recompute `PASSPHRASE_HASH` (see above)
  and `npx wrangler secret put PASSPHRASE_HASH` again — this invalidates
  the passphrase but not existing device/session tokens (same behavior
  as `Code.gs`).
- **Rotating `SESSION_SECRET`:** invalidates every outstanding device
  and session token immediately — everyone has to unlock the device and
  log in again. Only do this if you suspect a token leaked.

## Abuse prevention

Beyond the per-token rate limit on authenticated calls (60/min), the
Worker has a few additional layers aimed specifically at unauthenticated
or otherwise cheap-to-hammer requests:

- **Per-IP auth lockout.** `deviceLogin` (the shared passphrase) and
  `login` (a position's password, e.g. CCT/Administrator) are guessable
  secrets reachable with no token at all. Each is now guarded per-IP
  (via Cloudflare's `CF-Connecting-IP` header, not spoofable by the
  client): a tight attempt-rate cap (10/min), plus an escalating lockout
  after 5 failures in a 10-minute window — 5 minutes locked out the
  first time, doubling on each repeat up to a 2-hour ceiling. A staff
  member who mistypes a password twice is unaffected; a script grinding
  through a wordlist gets slower, not faster, and can't burn through
  everyone else's shared login budget to do it (the previous limiter
  used a single counter shared by every caller, which one attacker could
  exhaust and lock legitimate staff out of signing in).
- **Request body size cap** (64KB) on every POST, checked before
  `JSON.parse` — rejects an oversized payload before paying to parse or
  process it.
- **Row-payload shape limits** on `write`/`delete`: at most 60 fields
  per row, 20,000 characters per field value (generous for any real
  rich-text Notes/Announcements body), and 10 match columns. Bounds how
  much a single request can cost regardless of how often it's allowed to
  run.

None of this weakens legitimate use — normal staff traffic never comes
close to any of these ceilings.

## Known differences from Code.gs

- **Rate limiting** is approximate (KV reads/writes aren't atomic under
  heavy concurrency) — same caveat the old CacheService-based limiter
  had, just noted explicitly in `worker/src/auth.js`. Not a concern at
  this app's scale.
- **StaffAccess** stays off-limits to the generic read/write actions,
  same boundary as before — only `login`/`listPositions` touch it.
- Composite-key update/append semantics for `UniformInspections` (same
  student, new day → new row; same day → update in place) are preserved
  exactly.
