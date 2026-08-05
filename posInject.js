/**
 * Injected into an open AI POS tab (MAIN world via scripting).
 * Reads localStorage auth and syncs it to the extension.
 * Keep this file simple — build minifies only (no obfuscator).
 */
(function () {
  function pick() {
    for (var i = 0; i < arguments.length; i += 1) {
      var v = localStorage.getItem(arguments[i]);
      if (v != null && String(v).trim()) return String(v).trim();
    }
    return "";
  }

  var token = pick(
    "authToken",
    "pos_auth_token",
    "token",
    "accessToken",
    "access_token",
  );
  if (!token) return;

  var companyId = pick("pos_company_id", "companyId", "company_id");
  var companyName = pick(
    "pos_company_name",
    "companyName",
    "company_name",
    "userName",
  );

  try {
    var company = JSON.parse(localStorage.getItem("companyData") || "{}");
    if (!companyId) companyId = String(company._id || company.id || "").trim();
    if (!companyName) {
      companyName = String(
        company.name || company.company_name || company.companyName || "",
      ).trim();
    }
  } catch (e) {}

  try {
    var user = JSON.parse(localStorage.getItem("userData") || "{}");
    if (!companyName) {
      companyName = String(
        user.name || user.full_name || user.email || "",
      ).trim();
    }
    if (!companyId) {
      var nested =
        user.company && typeof user.company === "object"
          ? user.company._id || user.company.id
          : "";
      companyId = String(
        user.company_id || user.companyId || nested || "",
      ).trim();
    }
  } catch (e2) {}

  try {
    chrome.runtime.sendMessage({
      type: "wa-pos-auth-sync",
      auth: {
        token: token,
        companyId: companyId,
        companyName: companyName,
        origin: location.origin,
      },
    });
  } catch (e3) {}
})();
