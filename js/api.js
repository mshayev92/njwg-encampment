/* ============================================================
   NJWG CAP ENCAMPMENT — API CLIENT
   Talks to the Google Apps Script Web App deployed in front of
   the private Google Sheet. No API key is used or needed — the
   Apps Script runs "as me" (the sheet owner) under a public /exec
   URL.

   IMPORTANT — because the site is hosted publicly (GitHub Pages),
   that /exec URL is not secret: anyone can view source and see it,
   and anyone can call it directly. So neither a passphrase nor a
   position is trusted as ongoing authentication — each is exchanged
   ONCE for a signed, expiring token (device token / session token,
   see js/auth.js), and this client attaches BOTH tokens to every
   read/write. The Apps Script backend verifies both tokens'
   signatures and expiry server-side on every call — see
   apps-script/Code.gs.

   Every page loads config.js, then this file, before its own script.
   ============================================================ */

const Api = (() => {
  const BASE_URL = window.APP_CONFIG.APPS_SCRIPT_URL;

  function getSessionToken() {
    return (typeof Auth !== "undefined" && Auth.getToken) ? Auth.getToken() : null;
  }

  function getDeviceToken() {
    return (typeof Auth !== "undefined" && Auth.getDeviceToken) ? Auth.getDeviceToken() : null;
  }

  /**
   * Internal fetch wrapper.
   * GET requests use query params. POST requests send a JSON body as
   * text/plain (avoids CORS preflight against Apps Script Web Apps).
   *
   * requireDevice/requireSession control which tokens are attached and
   * required for this particular call:
   *   - deviceLogin:    neither (that's the call that ISSUES the device token)
   *   - listPositions:  device token only (device already unlocked, no position chosen yet)
   *   - login:          device token only (device already unlocked, no session yet)
   *   - read/write:     both device token and session token
   */
  async function request(action, { method = "GET", params = {}, body = null, requireDevice = true, requireSession = true } = {}) {
    if (!BASE_URL || BASE_URL.includes("PASTE_YOUR_DEPLOYMENT_ID_HERE")) {
      throw new Error(
        "Apps Script URL is not configured yet. Set APPS_SCRIPT_URL in js/config.js."
      );
    }

    const deviceToken = requireDevice ? getDeviceToken() : null;
    if (requireDevice && !deviceToken) {
      throw new Error("Device not unlocked. Please enter the passphrase again.");
    }

    const sessionToken = requireSession ? getSessionToken() : null;
    if (requireSession && !sessionToken) {
      throw new Error("Not signed in. Please sign in again.");
    }

    const tokenParams = {
      ...(deviceToken ? { deviceToken } : {}),
      ...(sessionToken ? { token: sessionToken } : {})
    };

    let url = `${BASE_URL}?action=${encodeURIComponent(action)}`;
    for (const [key, value] of Object.entries({ ...params, ...tokenParams })) {
      url += `&${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
    }

    const options = { method };

    if (method === "POST") {
      options.headers = { "Content-Type": "text/plain;charset=utf-8" };
      options.body = JSON.stringify({ action, ...body, ...tokenParams });
    }

    let response;
    try {
      response = await fetch(url, options);
    } catch (networkErr) {
      throw new Error("Network error reaching the server. Check your connection and try again.");
    }

    if (!response.ok) {
      throw new Error(`Server responded with status ${response.status}.`);
    }

    let data;
    try {
      data = await response.json();
    } catch (parseErr) {
      throw new Error("Server returned an unreadable response.");
    }

    if (data && data.ok === false) {
      const message = data.error || "Request failed.";
      handleAuthFailure_(message);
      throw new Error(message);
    }

    return data;
  }

  /**
   * If the backend rejected a device or session token, clear the
   * relevant local state and bounce to the right gate — device errors
   * go to the passphrase screen, session errors go to the position
   * picker — rather than leaving the user stuck on a silent failure.
   */
  function handleAuthFailure_(message) {
    if (typeof Auth === "undefined") return;

    const isDeviceError = /device|passphrase/i.test(message);
    const isSessionError = /session token|invalid token|malformed token/i.test(message) && !isDeviceError;

    if (isDeviceError) {
      Auth.clearDeviceAuth();
      Auth.clearSession();
      const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.href = `${window.APP_BASE_PATH}gate.html?returnTo=${returnTo}`;
    } else if (isSessionError) {
      Auth.clearSession();
      const returnTo = encodeURIComponent(window.location.pathname);
      window.location.href = `${window.APP_BASE_PATH}index.html?returnTo=${returnTo}`;
    }
  }

  return {
    /** Fetch all rows from a named sheet tab, e.g. Api.getSheet('Schedule') */
    getSheet(sheetName, extraParams = {}) {
      return request("read", { params: { sheet: sheetName, ...extraParams } });
    },

    /** Append or update a row. rowData is a plain object of column:value pairs. */
    writeRow(sheetName, rowData, { matchColumn = null } = {}) {
      return request("write", {
        method: "POST",
        body: { sheet: sheetName, row: rowData, matchColumn }
      });
    },

    /**
     * LAYER 1 — exchange the shared passphrase for a device token.
     * Requires neither existing token (this call issues the first one).
     */
    deviceLogin(passphrase, deviceType) {
      return request("deviceLogin", {
        method: "POST",
        body: { passphrase, deviceType },
        requireDevice: false,
        requireSession: false
      });
    },

    /**
     * Fetches the list of valid position names (e.g. "Alpha Flight",
     * "CCT") from StaffAccess, to populate the login dropdown. Requires
     * the device to already be unlocked but no session yet. Returns
     * only position names — never Role, Pages, or anything else.
     */
    listPositions() {
      return request("listPositions", {
        requireDevice: true,
        requireSession: false
      });
    },

    /**
     * LAYER 2 — exchange a chosen position (plus password, for
     * password-protected positions like CCT/Administrator) for a
     * per-position session token. Requires the device token (already
     * unlocked) but no session yet.
     */
    login(position, password) {
      return request("login", {
        method: "POST",
        body: { position, password },
        requireDevice: true,
        requireSession: false
      });
    }
  };
})();
