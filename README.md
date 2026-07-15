# NJWG Encampment App

A responsive, installable (PWA) tool for encampment **staff** — schedule, roster, and future features — backed by a private Google Sheet with **no API key required**.

This app is **staff-only, and login is by position, not by person.** There are no individual accounts or CAP IDs used for login. Instead, at sign-in a user picks their **position** from a dropdown — a flight (e.g. `"Alpha Flight"`), a squadron (e.g. `"Squadron 1"`), the Cadet Command Team (`"CCT"`), or `"Administrator"` — and, for the two privileged positions (CCT, Administrator), enters a password. The `Roster` tab is a read-only display list of students for staff to view; it is never used for login.

## ⚠️ Read this first: security model for a public site

This site is meant to be hosted on **public** GitHub Pages, which means:
- Anyone can view page source and see `js/config.js`, including the Apps Script URL. That URL cannot be kept secret.
- Anyone can call that URL directly with curl/Postman, bypassing every page entirely.

Because of that, **no page in this app is the security boundary** — pages are just redirects for normal users. The real boundary is enforced **server-side, in `apps-script/Code.gs`**, in two layers:

**Layer 1 — Device gate (passphrase).** A single long passphrase, given out to staff at check-in, unlocks a *device* — not a position. Entering it correctly gets a signed **device token**, stored in `localStorage` so the device stays unlocked without asking again:
- On a **personal device**, the device token lasts the whole encampment (default ~2 weeks ceiling).
- On a **shared/desk device**, the device token lasts a few hours (default 8), so it doesn't stay unlocked for whoever sits down next.
- The passphrase itself is never sent in a form the backend "remembers" in plaintext — only a SHA-256 hash is stored server-side, and only that hash is ever compared.

**Layer 2 — Per-position session.** Once a device is unlocked, `index.html` fetches the current list of valid positions from the `StaffAccess` sheet tab (via a narrow, read-only `listPositions` endpoint that returns *only* position names — never `Pages` or `Password`) and shows them in a dropdown. The user picks one:
- **Ordinary flights/squadrons** — no password needed. Picking the position from the dropdown is enough, since the device gate is already the outer barrier.
- **`CCT` and `Administrator`** — each requires its own password, checked against that row's `Password` cell in `StaffAccess` (see **important tradeoff** below).

On success, the backend issues a signed **session token** carrying the position and its allowed `Pages`. Stored in `sessionStorage` (cleared on tab close), with an idle timeout (default 2 hours of inactivity) and a hard expiry at the next local midnight regardless of login time.

Every read/write requires **both** tokens, and the backend verifies both tokens' signatures and expiry, server-side, on every single call.

Other protections layered on top:
- Each position sees only the nav pages listed in its own `StaffAccess` row (see **Per-page access control** below) — enforced both in the UI (`js/shell.js`) and, independently, if someone tries to reach a page's URL directly.
- Basic rate limiting slows down brute-force passphrase/password guessing and URL scraping.
- Every login attempt (device gate and per-position) is logged to a `LoginLog` tab, auto-created on first use, for after-action review.

### Writable sheets: Roster, Schedule, Announcements, BlackFlagStatus

Roster and Schedule are editable from the app (not just read-only). Writing to any of these four requires **both**:
- the normal view page id in that position's `Pages` column (`roster`, `schedule`, or `announcements` — the same id that controls nav visibility), **and**
- a separate **edit id**: `edit-roster`, `edit-schedule`, or `edit-announcements`.

Seeing a page no longer implies being able to edit it. A position with `Pages = "schedule"` can view Schedule but not touch it; a position with `Pages = "schedule,edit-schedule"` can view and edit it. The three edit ids are independent — mix and match freely, e.g. `Pages = "roster,edit-roster,schedule,inspections"` gives Roster edit rights but Schedule stays view-only for that position.

`UniformInspections`, `RoomInspections`, and `Notes` stay writable by any signed-in position — any position that can reach Inspections needs to be able to submit scorecards, and any position that can reach Notes needs to be able to jot one down; there's no `edit-inspections` or `edit-notes` id.

Roster deletes go through a new `delete` action in `Code.gs` (`handleDelete`), gated by the same edit-id check as writing to that sheet.

The Schedule/Roster edit buttons in the app itself only render for positions whose session actually carries the matching edit id — but that's a UI convenience only; `assertPageWriteAccess_` in `Code.gs` is what actually enforces this on every write, regardless of what the browser shows.

### ⚠️ Important tradeoff: CCT/Administrator passwords are stored as PLAINTEXT in the sheet

Unlike the device passphrase (hashed, never stored anywhere readable), the `CCT` and `Administrator` passwords live as **plain, unhashed text** directly in the `StaffAccess` tab's `Password` column, by deliberate choice, so they're simple to set and change — just type into the cell.

What this means in practice:
- **Anyone with view/edit access to the actual Google Sheet** (not the app — the underlying Sheet file in Google Drive) can read these passwords in the clear.
- `StaffAccess` is deliberately **excluded** from the app's generic read/write API (`ALLOWED_SHEETS` in `Code.gs`), so no page and no direct call to the public `/exec` endpoint can ever retrieve this sheet's contents — only the login flow touches it, server-side, and the only thing ever returned to a browser from it is the list of position names (never passwords).
- The security boundary for these two passwords is therefore **Google Sheet sharing permissions**, not anything in the app itself. Keep the Sheet's own share settings restricted to trusted staff, the same way you'd protect any spreadsheet containing secrets.
- If you'd prefer these hashed instead of plaintext (closer to how the device passphrase works), that's a straightforward follow-up change — ask if you want it.

**Other honest limitations — please read:**
- This is **not** multi-factor or identity-verified authentication, and it is **not per-person** — anyone who knows the device passphrase can act as any non-privileged position (a flight or squadron), and anyone who additionally knows the CCT or Administrator password can act as those. There is no way to tell *which individual* picked a given position; `LoginLog` only records which position was used and when, not who used it.
- A signed token, once issued, is trusted for its full lifetime even if copied elsewhere — there's no per-device cryptographic binding beyond the device gate itself.
- Being a PWA / installed app doesn't change any of this — an installed app makes the same calls to the same public endpoint as a browser tab.
- Keep sensitive columns (phone, address, DOB, emergency contacts) out of the sheets this app reads. The current `Roster`/`Schedule` columns intentionally avoid them.
- Page-level access control (who sees Schedule vs. other pages) is a UX/organizational feature, not a data-security feature — see **Per-page access control** below.

## How the pieces fit together

```
njwg-encampment/
├── index.html              # Position picker + password (for CCT/Administrator) — Layer 2
├── gate.html                # Device passphrase gate — Layer 1, reached first
├── manifest.json           # PWA manifest
├── service-worker.js       # PWA offline caching
├── css/
│   ├── tokens.css          # Universal design tokens (colors, type, spacing)
│   └── app.css             # Universal layout, nav, components — used everywhere
├── js/
│   ├── config.js           # ⚠️ EDIT THIS — Apps Script URL + app constants
│   ├── api.js               # Universal API client (talks to Apps Script, attaches both tokens)
│   ├── auth.js              # Device gate + per-position session logic (two layers)
│   └── shell.js             # Universal header/nav/duty-strip renderer + idle timeout + page access guard
├── pages/
│   ├── schedule.html        # Feature page (position must have "schedule" in its Pages list)
│   └── roster.html          # Feature page (always visible to any signed-in position)
├── apps-script/
│   └── Code.gs              # Reference copy of the backend (real copy lives IN the Sheet)
└── icons/                   # App icons/favicons — generated from the NJ Wing patch:
    ├── icon-192.png          #   used as the nav-rail crest image too, not just PWA install
    ├── icon-512.png
    ├── icon-512-maskable.png #   extra safe-zone padding so Android's crop doesn't clip it
    ├── apple-touch-icon.png
    └── favicon.ico
```

Every page follows the same pattern: load `config.js` → `api.js` → `auth.js` → `shell.js`, then call `Shell.init({ activePage: '...' })`. `Shell.init` transparently enforces the device gate, the per-position session, AND (for every page except Roster) whether this position is allowed to see this specific page — and also renders the sync indicator, wires document-wide tooltips, and sets up the header's hard-refresh button (see **Performance model** below).

## Part 1 — Connect the app to your Google Sheet (no API key)

### Step 1 — Prep the Sheet
Create tabs named exactly:
- **StaffAccess** — columns: `Position, Pages, Password`.
  - `Position` — the exact dropdown label, e.g. `Alpha Flight`, `Bravo Flight`, `Squadron 1`, `Squadron 2`, `CCT`, `Administrator`. Each row is one dropdown option — add or remove a row to add or remove an option, no code changes needed.
  - `Pages` — comma-separated list of page ids this position can see, e.g. `schedule`. Matches `NAV_ITEMS` ids in `js/config.js`. **Roster is always visible to every signed-in position and does not need to be listed here.** To grant EDIT access (not just view) to Roster, Schedule, or Announcements, additionally include `edit-roster`, `edit-schedule`, or `edit-announcements` — e.g. `Pages = "schedule,edit-schedule,roster"` can view Schedule+Roster and edit Schedule only.
  - `Password` — **plaintext**. Leave blank for ordinary flights/squadrons. Fill in a real password for the `CCT` and `Administrator` rows specifically (matched case-insensitively) — those two positions cannot sign in without it. This entire sheet is never exposed through the app's generic read API — see the security tradeoff section above — but is visible to anyone with Sheet access, so restrict Sheet sharing accordingly.
- **Roster** — columns: `CapId, Name, Rank, Flight`. Purely a display list of students for staff to browse — **never used for login**.
- **Schedule** — columns: `Day, Time, Activity, Location, Flight`

### Step 2 — Add the Apps Script
1. In the Sheet: **Extensions → Apps Script**.
2. Delete the placeholder code, paste in the contents of [`apps-script/Code.gs`](./apps-script/Code.gs).
3. Save (⌘S / Ctrl+S).

### Step 3 — Generate the signing secret (one time)
1. Select **`setupSecret`** in the function dropdown, click **Run**, authorize when asked.
2. Check the log — it should confirm the secret was generated and stored. **Never share it or commit it anywhere.**
3. Don't run `setupSecret` again unless you intend to invalidate every active token.

### Step 4 — Set the device passphrase (one time per encampment cycle)
1. Find `setPassphrase()`, temporarily set `PASSPHRASE` to your real passphrase (6+ random words is plenty).
2. Select `setPassphrase` in the function dropdown, click **Run**.
3. Check the log, then **delete the plaintext from the function and save** — only the hash persists in Script Properties.
4. Give the real passphrase to staff verbally or on a printed check-in card — never put it in GitHub.

### Step 5 — Set the CCT and Administrator passwords
Directly in the Sheet, in the `StaffAccess` tab, type the real password into the `Password` cell for the `CCT` row and, separately, for the `Administrator` row. No script step needed — these are read straight from the sheet at login time. Leave every other row's `Password` cell blank.

### Step 6 — Deploy as a Web App
1. **Deploy → New deployment → Web app**.
2. **Execute as:** Me, **Who has access:** Anyone.
3. **Deploy**, authorize, then copy the `/exec` URL.

### Step 7 — Point the app at it
Open `js/config.js` and paste the URL into `APPS_SCRIPT_URL`.

**Important:** any time you edit `Code.gs` inside the Sheet, go to **Deploy → Manage deployments → Edit (pencil) → New version** for changes to go live.

## Part 2 — Publish on GitHub Pages

1. Push this folder to a GitHub repo.
2. Repo **Settings → Pages → Source**: deploy from the `main` branch, root folder.
3. Your app will be live at `https://<username>.github.io/<repo>/`.

## Part 3 — Service worker (already wired in)

Already registered at the bottom of every page via `window.APP_BASE_PATH`. Nothing to add.

## Adding a new feature page

1. Copy `pages/schedule.html` → `pages/your-page.html`, update its `Shell.init({ activePage: "your-page" })` call.
2. Add the tab to `ALLOWED_SHEETS` in `Code.gs` if it needs its own data source (then redeploy).
3. Add an entry to `NAV_ITEMS` in `js/config.js`.
4. Add the new page's path to `APP_SHELL` in `service-worker.js`.
5. Add the page's id to the relevant positions' `Pages` cell in `StaffAccess`.

## Adding or removing a position (flight, squadron, etc.)

Just add or remove a row in `StaffAccess` — no code changes needed. If the new position is named exactly `CCT` or `Administrator` (case-insensitive), it automatically requires its `Password` cell to be filled in and checked at login; any other name is a no-password option.

You can also do this from inside the app — see the Administrator page below — instead of editing the sheet by hand.

## Administrator page (in-app staff management + login log)

The **Admin** page (`pages/admin.html`) lets a privileged position manage `StaffAccess` and review login activity without opening the Google Sheet:

- **Staff Access** — add, edit, or delete positions; grant/revoke each position's pages with checkboxes; set flights; set, keep, or clear a position's password. Passwords are **never sent to the browser** — the page only shows whether one is set, and on edit you either type a new one or leave the field blank to keep the current one.
- **Login Activity** — the `LoginLog` sheet (every device unlock and position sign-in, success or failure), newest first, with a "failures only" filter and CSV export. Nothing else in the app surfaces this.

**Access is gated by an `admin` page token**, enforced both client-side (the nav item and page) and independently server-side (every admin action re-checks that the session's `Pages` include `admin` — the client gate is only convenience). Guards prevent locking yourself out: you can't delete the position you're signed in as, and you can't remove the **last** position that has `admin`.

**Bootstrapping the first administrator** (one time): add `admin` to some position's `Pages` cell in the `StaffAccess` sheet directly (e.g. the `Administrator` row → `Pages` = `...,admin`), then sign in fresh as that position. From then on, everything else can be managed in-app.

## Writing data back to the Sheet

`Api.writeRow(sheetName, rowData, { matchColumn })` is wired up in `js/api.js`. Note: `StaffAccess` cannot be written (or read) through this API at all — see the security tradeoff section. Example, writing to an allowed sheet:

```js
await Api.writeRow("CheckIns", {
  Position: session.Position,
  Timestamp: new Date().toISOString(),
  Status: "Present"
}, { matchColumn: "Position" });
```

## Login (two layers, position-based)

**Layer 1 — `gate.html`.** Passphrase + device type → signed **device token** in `localStorage`.

**Layer 2 — `index.html`.** Calls `listPositions` (device token only) to populate the dropdown from `StaffAccess`. User picks a position; `CCT`/`Administrator` additionally require the matching `Password` cell's value. On success, a signed **session token** (position + pages) is stored in `sessionStorage`, with the usual idle timeout and midnight expiry.

Every `Api.getSheet(...)` / `Api.writeRow(...)` call attaches both tokens automatically. Rejected tokens redirect to the right gate via `js/api.js`.

## Per-page access control (positions only see what they're granted)

Each `StaffAccess` row's `Pages` column lists which nav pages that position can see — except Roster, which is always visible to everyone signed in. Enforced both in nav rendering (`js/shell.js`'s `getAllowedNavItems()`) and against direct URL access (`Shell.requirePageAccess`, called from every page's `Shell.init`). This is a UX/organizational guard, not a data-security boundary — see the tradeoffs above.

## Login attempt logging

Every attempt (device gate and per-position) is appended to `LoginLog` (`Timestamp, Type, Identifier, Success`). `Identifier` is the position attempted (e.g. `"CCT"`), not an individual — this system has no way to distinguish who used a shared position.

## Inspection history and trends

`UniformInspections` now stores **one row per (student, date)** instead of one row per student overall. Re-inspecting the same cadet on a **new** day appends a fresh row (preserving history); re-submitting on the **same** day updates that day's row in place. This is done via a composite match key (`matchColumns: ["StudentCapId", "Date"]` in `Api.writeRow`, matched server-side in `handleWrite`).

The Inspections page's **Trends** tab uses this history to show:
- Flight-vs-flight average total score, toggle between "each cadet's latest inspection" (a live snapshot) or "all inspections" (all-time average)
- Pass-rate-by-item across all flights, to spot which specific line items (haircut, gig line, etc.) are commonly failing

A cadet's inspection history (all past scorecards) is browsable from their row in the Uniform tab — clicking a past date reopens that day's scorecard for viewing or correction.

## Visual identity

The palette, icons, and favicons are derived directly from the NJ Wing patch (deep indigo field `#0d1250`, garnet-red New Jersey silhouette `#a8172c`, wing/border gold `#f0b429`, off-white ribbon). See `css/tokens.css` for the full token set — colors were sampled from the actual patch artwork, not guessed. `--navy-*` variable names from the old palette are kept as aliases pointing at the new `--indigo-*` scale so nothing silently breaks, but all current CSS uses the `--indigo-*` names directly.

Custom browser chrome replaces several native, unstylable browser UI elements app-wide:
- **Scrollbars** — thin gold-on-indigo/cream track, via `scrollbar-color` (Firefox) and `::-webkit-scrollbar-*` (Chrome/Safari/Edge), in `css/app.css`.
- **Confirmation dialogs** — `Shell.confirm({ title, message, confirmLabel, danger })` returns a `Promise<boolean>`, replacing `window.confirm()`, which can't be restyled and looks like OS chrome. Used anywhere a destructive action (removing a cadet, deleting a schedule item) needs confirmation.
- **Tooltips** — any element with `data-tooltip="..."` gets a themed hover/focus bubble (see `wireTooltips_` in `js/shell.js`) instead of the native `title=""` tooltip. `Shell.init()` wires the whole document automatically; call `Shell.wireTooltips(container)` after injecting new dynamic HTML (e.g. after a table re-renders) to pick up new `data-tooltip` elements.
- **Toasts and the sync indicator** — themed from the start, no native equivalent existed.

Icons/favicons live in `icons/`: `favicon.ico` (16/32/48 multi-res), `icon-192.png`, `icon-512.png`, `icon-512-maskable.png` (extra safe-zone padding so Android's circular/squircle crop never clips the shield), and `apple-touch-icon.png`. Regenerate all of these together if the patch art ever changes, so they stay visually consistent.

## Performance model: instant renders, background sync

The app now follows a **stale-while-revalidate** read pattern and **optimistic** writes, implemented in `js/api.js`, to avoid the old behavior of a visible loading spinner every time a page needed data:

- **Reads** — `Api.getSheetCached(sheetName, onFresh)` returns cached data **synchronously** if this page has fetched that sheet before this session, so a repeat view of Schedule/Roster/Inspections renders instantly instead of waiting on the network. A background refetch always happens regardless of whether cache existed; `onFresh(data)` fires if/when it resolves, so the page can quietly re-render only if something actually changed. The very first load of a sheet in a session still shows the loading spinner — there's nothing to show instantly yet.
- **Writes** — `Api.writeRow()`/`Api.deleteRow()` are optimistic **by default**: they return immediately once queued, without waiting for the server round-trip. Callers update their own in-memory rows and re-render right away, rather than re-fetching after `await`. Pass `{ optimistic: false }` if a caller genuinely needs to know the server's result before proceeding (rare — only use this if a permission error needs to be caught before the UI changes).
- **Sync status** — because writes no longer block, the header shows a small sync indicator (queued → "Saving…" → "Saved", or "Sync failed — tap Refresh" if the background write ultimately fails after one retry) via `Api.onSyncStatusChange()`. This was a deliberate choice over either silent background sync (a failure would surface too late) or blocking on every write (defeats the whole point) — the person always knows whether their last save actually landed.
- **Hard refresh** — every page's own "Refresh" button, and the header's global refresh button, both call `Shell.hardRefresh()`, which clears the entire read cache and re-runs that page's `load()` — guaranteeing a real, visible "fetch everything again," distinct from the automatic instant-cached-render every page does on normal navigation. Pages register their own reload logic via `Shell.registerRefresh(loadFn)` near the bottom of their script.

**One important interaction to know about:** because writes are optimistic, a page's own `load()` should never be called again immediately after a save/delete to "confirm" it — that would refetch from the server before the background write has necessarily landed, undoing the local optimistic update and showing stale data for a moment. Every page's save/delete handlers were rewritten to update their own in-memory array (`scheduleRows`, `allRows`, `inspectionsByStudent`, etc.) directly and re-render from that, rather than re-querying the sheet.

**Also important:** a background refresh callback (`onFresh`) never re-renders an in-progress, unsaved form (e.g. a uniform scorecard mid-scoring) — see `renderActiveView()`'s deliberate exclusion in `pages/inspections.html` — since silently replacing the screen with fresh server data would discard whatever the person hasn't saved yet.
