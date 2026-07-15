# NJWG Encampment — Cloudflare Worker backend

Replaces `apps-script/Code.gs`. Talks to the **same Google Sheet** via the
Sheets API v4 using a service account, instead of running inside Apps
Script. Exposes the identical `action=read/write/delete/login/
deviceLogin/listPositions` contract, so `js/api.js` needs no changes
beyond pointing `APPS_SCRIPT_URL` at this Worker's URL once you're ready
to cut over.

Keep `apps-script/Code.gs` deployed and live while you test this — they
can both point at the same Sheet at the same time with no conflict,
since each request is independent (no shared in-memory state).

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

Verify everything is set:

```
npx wrangler secret list
```

You should see all five names listed (values are never shown).

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
