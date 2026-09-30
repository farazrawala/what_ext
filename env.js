/**
 * Live environment — AI POS on testv3
 * SPA: https://testv3.websitedemolynk.com/pos/
 * API: https://testv3.websitedemolynk.com/pos_admin/api/chat/...
 */
var WA_ENV = {
  name: "live",
  label: "Live",
  posOrigin: "https://testv3.websitedemolynk.com",
  posUrl: "https://testv3.websitedemolynk.com/pos/",
  /** Chat API path under posOrigin (no trailing slash). */
  chatApiPath: "/pos_admin/api/chat",
  preferredHosts: ["https://testv3.websitedemolynk.com"],
  /** chrome.tabs / content_scripts match patterns for POS pages. */
  posTabMatch: ["https://testv3.websitedemolynk.com/*"],
};

(function bindWaEnv(global) {
  if (!global) return;
  global.WA_ENV = WA_ENV;
})(typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : undefined);
