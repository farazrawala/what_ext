/**
 * Local environment — POS / API on localhost:8000
 */
var WA_ENV = {
  name: "local",
  label: "Local",
  posOrigin: "http://localhost:8000",
  posUrl: "http://localhost:8000/",
  /** Chat API path under posOrigin (no trailing slash). */
  chatApiPath: "/api/chat",
  preferredHosts: [
    "http://localhost:8000",
    "http://127.0.0.1:8000",
  ],
  /** chrome.tabs / content_scripts match patterns for POS pages. */
  posTabMatch: [
    "http://localhost:8000/*",
    "http://127.0.0.1:8000/*",
  ],
};

(function bindWaEnv(global) {
  if (!global) return;
  global.WA_ENV = WA_ENV;
})(typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : undefined);
