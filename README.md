# NJWG CAP Encampment App

A responsive, installable (PWA) tool for encampment **staff/cadre** — schedule, roster, and future features — backed by a private Google Sheet with **no API key required**.

This app is **staff-only**. Students are never issued logins; the `Roster` tab is a read-only display list of students for staff to view, not a source of authentication. Only CAP IDs listed in the `StaffAccess` tab can sign in at all.

## ⚠️ Read this first: security model for a public site

This site is meant to be hosted on **public** GitHub Pages, which means:
- Anyone can view page source and see `js/config.js`, including the Apps Script URL. That URL cannot be kept secret.
- Anyone can call that URL directly with curl/Postman, bypassing every page entirely.

Because of that, **no page in this app is the security boundary** — pages are just redirects for normal users. The real boundary is enforced **server-side, in `apps-script/Code.gs`**, in two layers:

**Layer 1 — Device gate (passphrase).** A single long passphrase, given out to staff at check-in, unlocks a *device* — not a person. Entering it correctly gets a signed **device token**, stored in `localStorage` so the device stays unlocked without asking again:
- On a **personal device**, the device token lasts the whole encampment (default ~2 weeks ceiling).
- On a **shared/desk device**, the device token lasts a few hours (default 8), so it doesn't stay unlocked for whoever sits down next.
- The passphrase itself is never sent in a form the backend "remembers" in plaintext — only a SHA-256 hash is stored server-side, and only that hash is ever compared.

**Layer 2 — Per-person session (CAP ID).** Once a device is unlocked, a CAP ID is used to look up the member in **`StaffAccess`** (not `Roster`) and issue a separate, signed **session token**, stored in `sessionStorage` (cleared on tab close) with its own idle timeout (default 2 hours of inactivity) and a hard expiry at the next local midnight regardless of login time. This is what identifies *who* is using the device right now, their role, and which pages they can see. A CAP ID that only exists in `Roster` (a student, not staff) cannot sign in — `Roster` is never consulted at login.

Every read/write requires **both** tokens, and the backend verifies both tokens' signatures and expiry, server-side, on every single call — a CAP ID or passphrase alone is never sufficient to get or change data once submitted once.

Other protections layered on top:
- Writes require a `Role` of `"Staff"` in the `StaffAccess` tab (configurable via `SHEET_PERMISSIONS` in `Code.gs`) — a staff member without that role can read but can't write.
- Each staff member sees only the nav pages listed in their own `StaffAccess` row (see **Per-page access control** below) — enforced both in the UI (`js/shell.js`) and, independently, if they try to reach a page's URL directly.
- Basic rate limiting slows down brute-force passphrase/CAP ID guessing and URL scraping.
- Every login attempt (device gate and per-person) is logged to a `LoginLog` tab, auto-created on first use, for after-action review.

**Honest limitations — please read:**
- This is **not** multi-factor or identity-verified authentication. The passphrase and CAP ID are both "something you know," not "something you are/have" — if either is learned by someone outside the intended group, they can get in the same way an authorized person would. Rate limiting slows guessing, it doesn't stop someone who already has a valid passphrase or CAP ID.
- A signed token, once issued, is trusted for its full lifetime even if copied elsewhere — there's no per-device cryptographic binding beyond the device gate itself.
- Being a PWA / installed app doesn't change any of this — an installed app makes the same calls to the same public endpoint as a browser tab. Installing it does not add OS-level secret storage or code-signing here.
- This setup is meaningfully better than "no auth" or "single-factor-forever," but it's not equivalent to real password/2FA-based accounts. If NJWG has a real requirement for strict PII protection (e.g. under a privacy policy or CAP regulation), have someone in your unit's IT/PII compliance chain review this before going live, and weigh whether roster PII belongs in a public-facing app at all versus a members-only system.
- Keep sensitive columns (phone, address, DOB, emergency contacts) out of the sheets this app reads. The current `Roster`/`Schedule`/`StaffAccess` columns intentionally avoid them. If you ever add one, use `redactColumnsForNonStaff` in `SHEET_PERMISSIONS` (`Code.gs`) to hide it from non-staff sessions rather than relying on the page not displaying it.
- Page-level access control (who sees Schedule vs. other pages) is a UX/organizational feature, not a data-security feature. All signed-in staff, regardless of their `Pages` list, are still bound by the same `SHEET_PERMISSIONS` read/write rules. If you need certain staff to be unable to *read* certain data (not just unable to see the nav link), that must be modeled in `SHEET_PERMISSIONS`/redaction, not in `Pages`.

## How the pieces fit together

```
njwg-encampment/
├── index.html              # Per-person CAP ID login — Layer 2 (staff only)
├── gate.html                # Device passphrase gate — Layer 1, reached first
├── manifest.json           # PWA manifest
├── service-worker.js       # PWA offline caching
├── css/
│   ├── tokens.css          # Universal design tokens (colors, type, spacing)
│   └── app.css             # Universal layout, nav, components — used everywhere
├── js/
│   ├── config.js           # ⚠️ EDIT THIS — Apps Script URL + app constants
│   ├── api.js               # Universal API client (talks to Apps Script, attaches both tokens)
│   ├── auth.js              # Device gate + per-person session logic (two layers)
│   └── shell.js             # Universal header/nav/duty-strip renderer + idle timeout + page access guard
├── pages/
│   ├── schedule.html        # Feature page (staff must have "schedule" in their Pages list)
│   └── roster.html          # Feature page (always visible to any signed-in staff member)
├── apps-script/
│   └── Code.gs              # Reference copy of the backend (real copy lives IN the Sheet)
└── icons/                   # PWA icons (add icon-192.png, icon-512.png, icon-512-maskable.png)
```

Every page follows the same pattern: load `config.js` → `api.js` → `auth.js` → `shell.js`, then call `Shell.init({ activePage: '...' })`. `Shell.init` transparently enforces the device gate, the per-person session, AND (for every page except Roster) whether this staff member is allowed to see this specific page — feature pages don't need to know about any of the three directly. To add a new feature page later, copy `pages/schedule.html` as a template and add an entry to `NAV_ITEMS` in `js/config.js`.

## Part 1 — Connect the app to your Google Sheet (no API key)

The trick: Google Apps Script lets you deploy a script **bound to your Sheet** as a public "Web App" URL. The script runs under your Google identity, so it can read/write the Sheet even though the Sheet itself stays private. The browser only ever talks to that `/exec` URL — never to the Sheet directly, and never with any stored credentials.

### Step 1 — Prep the Sheet
Create tabs named exactly:
- **StaffAccess** — columns: `CapId, Name, Rank, Role, Pages`. This is the **only** tab used for login/authentication.
  - `Role` — must contain `Staff` for anyone who should be able to write data (leave blank or use anything else, e.g. `Cadre`, for read-only access).
  - `Pages` — comma-separated list of page ids this person can see, e.g. `schedule` or `schedule,forms`. These ids must match the `id` values in `NAV_ITEMS` in `js/config.js`. **The Roster page is always visible to every signed-in staff member and does not need to be listed here.** A CAP ID with an empty `Pages` cell can sign in and view Roster, but no other page, until you add one.
  - A CAP ID **not present in this tab at all cannot sign in**, even if they're a student in `Roster`.
- **Roster** — columns: `CapId, Name, Rank, Flight`. Purely a display list of students for staff to browse — **never used for login or permission checks**.
- **Schedule** — columns: `Day, Time, Activity, Location, Flight`

(Add more columns or tabs any time — the backend reads whatever headers exist. Avoid adding sensitive PII columns like phone/address/DOB/emergency contacts to a sheet backing a public site — see security section above.)

### Step 2 — Add the Apps Script
1. In the Sheet: **Extensions → Apps Script**.
2. Delete the placeholder code, paste in the contents of [`apps-script/Code.gs`](./apps-script/Code.gs).
3. Save (⌘S / Ctrl+S).

### Step 3 — Generate the signing secret (one time)
1. In the Apps Script editor, use the function dropdown at the top to select **`setupSecret`**.
2. Click **Run**. You'll be asked to authorize the script — this is you granting it permission to manage its own private storage; approve it.
3. Check the execution log — it should say the secret was generated and stored. This secret lives in Script Properties, is private to the script, and is what signs every token (device and session). **Never share it or commit it anywhere.**
4. Do not run `setupSecret` again unless you intend to invalidate every active token (e.g. rotating the secret after a suspected leak) — it refuses to overwrite an existing secret to prevent accidental invalidation.

### Step 4 — Set the encampment passphrase (one time per encampment cycle)
1. In the Apps Script editor, find the `setPassphrase()` function.
2. Temporarily replace the placeholder string with your real passphrase — make it long (6+ random words is plenty, e.g. `"granite forty compass bridge lantern otter"`), since this is the one thing standing at the outer edge of the app.
3. Select `setPassphrase` in the function dropdown, click **Run**.
4. Check the log for confirmation, then **delete the plaintext from the function and save** — only its hash needs to persist, in Script Properties.
5. Give the real passphrase to staff verbally, on a printed check-in card, or another out-of-band channel — never put it in GitHub or leave it sitting in the script source.
6. To rotate it for a future encampment, just repeat these steps with a new value — it invalidates every device token issued under the old one.

### Step 5 — Deploy as a Web App
1. Click **Deploy → New deployment**.
2. Select type: **Web app**.
3. Settings:
   - **Execute as:** Me
   - **Who has access:** Anyone
4. Click **Deploy**, authorize the permissions prompt (this is you granting the script access to your own Sheet).
5. Copy the resulting URL — it ends in `/exec`.

### Step 6 — Point the app at it
Open `js/config.js` and paste the URL:
```js
APPS_SCRIPT_URL: "https://script.google.com/macros/s/AKfycb.../exec",
```

**Important:** any time you edit `Code.gs` inside the Sheet, you must go to **Deploy → Manage deployments → Edit (pencil) → New version** for the changes to actually go live. Editing the script alone does not update the live `/exec` endpoint.

## Part 2 — Publish on GitHub Pages

1. Push this folder to a GitHub repo.
2. Repo **Settings → Pages → Source**: deploy from the `main` branch, root folder.
3. Your app will be live at `https://<username>.github.io/<repo>/`.
4. Register the service worker for PWA installability — already wired in, just make sure `service-worker.js` is served from the site root (GitHub Pages does this automatically if it sits at the repo root, or the Pages root if using a project site — see note below).

> **Note on GitHub Pages project sites:** this app works out of the box whether it's hosted at a domain root or in a project subfolder like `username.github.io/repo-name/`. Every file link is relative, and `js/config.js` detects the site's actual base path at runtime (`window.APP_BASE_PATH`) so internal redirects and navigation resolve correctly either way. Nothing to configure here.

## Part 3 — Service worker (already wired in)

Every page already registers the service worker automatically, using the same `window.APP_BASE_PATH` runtime detection as everything else:

```html
<script>
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register(`${window.APP_BASE_PATH}service-worker.js`);
  }
</script>
```

Nothing to add here — this is just documenting what's already at the bottom of `index.html`, `gate.html`, `pages/schedule.html`, and `pages/roster.html`. If you add a new page (see below), copy this same snippet to the bottom of it.

## Adding a new feature page

1. Copy `pages/schedule.html` → `pages/your-page.html`, and update its `Shell.init({ activePage: "your-page" })` call to match.
2. Add a tab in the Sheet if it needs its own data source, and add it to `ALLOWED_SHEETS` in `Code.gs` (then redeploy).
3. Add an entry to `NAV_ITEMS` in `js/config.js` — the `id` you choose here is what staff will list in their `StaffAccess` `Pages` column to unlock it.
4. Add the new page's path to `APP_SHELL` in `service-worker.js` so it's cached offline.
5. Give the relevant staff access by adding your new page's id to their `Pages` cell in `StaffAccess` (comma-separated if they already have others).

## Writing data back to the Sheet

`Api.writeRow(sheetName, rowData, { matchColumn })` is already wired up in `js/api.js`. Example — submitting a check-in form:

```js
await Api.writeRow("CheckIns", {
  CapId: session.CapId,
  Timestamp: new Date().toISOString(),
  Status: "Present"
}, { matchColumn: "CapId" }); // updates existing row for that CAP ID instead of duplicating
```

## Login (two layers, staff-only)

**Layer 1 — `gate.html`.** Takes the shared encampment passphrase plus a "personal device / shared device" choice, sends both to the Apps Script backend, which checks the passphrase against a stored hash and, if correct, returns a signed **device token**. That token is stored in `localStorage` (persists across browser restarts) with a lifetime set by the device type choice — long for personal devices, short for shared ones. Once unlocked, a device stays unlocked until that token expires; no need to re-enter the passphrase on every visit.

**Layer 2 — `index.html`.** Reachable only once the device gate is unlocked (`Auth.requireDeviceGate()` redirects back to `gate.html` otherwise). Takes a CAP ID, sends it along with the device token, and the backend looks it up in **`StaffAccess`** — a CAP ID only present in `Roster` (a student) will be rejected with "CAP ID not found." On success, the backend returns a signed **session token** identifying the person, their role, and their allowed pages. Stored in `sessionStorage` (cleared on tab close), with an additional idle timeout (`IDLE_TIMEOUT_MINUTES` in `js/config.js`, default 2 hours) enforced client-side via `js/shell.js` and a hard expiry at the next local midnight enforced server-side regardless of idle activity.

Every `Api.getSheet(...)` / `Api.writeRow(...)` call automatically attaches **both** tokens. If either is rejected by the backend (expired, invalid, tampered with), `js/api.js` clears the relevant local state and redirects to the right gate — `gate.html` for a device-token problem, `index.html` for a session-token problem — rather than leaving the user looking at a silent failure.

If you later want stronger access control (real passwords, Google account login, 2FA), the two layers are intentionally separable: `handleDeviceLogin()` / `handleLogin()` in `Code.gs` and `Auth.unlockDevice()` / `Auth.login()` in `js/auth.js` can each be swapped independently without touching page-level code or the rest of the permission system.

## Per-page access control (staff only see what they're granted)

Each `StaffAccess` row has a `Pages` column — a comma-separated list of page ids (matching `NAV_ITEMS` ids in `js/config.js`) that staff member is allowed to see. **Roster is the one exception: it's always visible to any signed-in staff member and never needs to appear in `Pages`.**

This is enforced in two places:
1. **Nav rendering** — `js/shell.js`'s `getAllowedNavItems()` filters `NAV_ITEMS` down to only what the session's `Pages` (plus Roster) allow, so a staff member simply never sees a link to a page they can't use.
2. **Direct URL access** — every protected page calls `Shell.init({ activePage: '...' })`, which calls `Shell.requirePageAccess(activePage)` internally. If someone types a page's URL directly despite it being hidden from their nav, they're redirected to Roster with a toast explaining they don't have access, rather than silently loading the page.

This is a **client-side UX guard for organizing who uses which tools**, not a data-security boundary — see the limitations note above. The actual data-level security (who can read/write which sheet) is still governed entirely by `SHEET_PERMISSIONS` in `Code.gs`, independent of `Pages`.

## Login attempt logging

Every attempt at either layer — successful or not — is appended to a `LoginLog` tab in the Sheet (auto-created on first use, with columns `Timestamp, Type, Identifier, Success`). This doesn't prevent anything by itself, but it's the only way to notice after the fact if a passphrase or CAP ID is being probed or misused, so check it periodically during encampment.
