/**
 * Runs on AI POS pages. Syncs localStorage auth (authToken, companyData, userData)
 * into chrome.storage so the extension popup/background can auto-authenticate.
 */
(function () {
  const STORAGE_KEY = "wa_pos_auth_cache";

  function readAuthFromLocalStorage() {
    const pick = function () {
      for (let i = 0; i < arguments.length; i += 1) {
        const v = localStorage.getItem(arguments[i]);
        if (v != null && String(v).trim()) return String(v).trim();
      }
      return "";
    };

    const token = pick(
      "authToken",
      "pos_auth_token",
      "token",
      "accessToken",
      "access_token",
    );
    if (!token) {
      return { token: "", companyId: "", companyName: "", origin: "" };
    }

    let companyId = pick("pos_company_id", "companyId", "company_id");
    let companyName = pick(
      "pos_company_name",
      "companyName",
      "company_name",
      "userName",
    );

    try {
      const company = JSON.parse(localStorage.getItem("companyData") || "{}");
      if (!companyId) companyId = String(company._id || company.id || "").trim();
      if (!companyName) {
        companyName = String(
          company.name || company.company_name || company.companyName || "",
        ).trim();
      }
    } catch (_) {}

    try {
      const user = JSON.parse(localStorage.getItem("userData") || "{}");
      if (!companyName) {
        companyName = String(
          user.name || user.full_name || user.email || "",
        ).trim();
      }
      if (!companyId) {
        const nested =
          user.company && typeof user.company === "object" ?
            user.company._id || user.company.id
          : "";
        companyId = String(
          user.company_id || user.companyId || nested || "",
        ).trim();
      }
    } catch (_) {}

    return {
      token,
      companyId,
      companyName,
      origin: location.origin,
      updatedAt: Date.now(),
    };
  }

  function syncAuth() {
    const auth = readAuthFromLocalStorage();
    if (!auth.token) return;
    try {
      chrome.runtime.sendMessage({ type: "wa-pos-auth-sync", auth }, () => {
        void chrome.runtime.lastError;
      });
    } catch (_) {}
    try {
      chrome.storage.local.set({ [STORAGE_KEY]: auth }, () => {
        void chrome.runtime.lastError;
      });
    } catch (_) {}
  }

  syncAuth();
  setInterval(syncAuth, 3000);

  window.addEventListener("storage", (event) => {
    if (
      !event.key ||
      event.key === "authToken" ||
      event.key === "companyData" ||
      event.key === "userData" ||
      event.key === "userName"
    ) {
      syncAuth();
    }
  });
})();
