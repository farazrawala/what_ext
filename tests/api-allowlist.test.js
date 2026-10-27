const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const POS_AUTH = fs.readFileSync(path.join(__dirname, "..", "posAuth.js"), "utf8");

const LIVE = {
  name: "live",
  label: "Live",
  posOrigin: "https://testv3.websitedemolynk.com",
  posUrl: "https://testv3.websitedemolynk.com/pos/",
  chatApiPath: "/pos_admin/api/chat",
  preferredHosts: ["https://testv3.websitedemolynk.com"],
  posTabMatch: ["https://testv3.websitedemolynk.com/*"],
};

const LOCAL = {
  name: "local",
  label: "Local",
  posOrigin: "http://localhost:8000",
  posUrl: "http://localhost:8000/",
  chatApiPath: "/api/chat",
  preferredHosts: [
    "http://localhost:8000",
    "http://127.0.0.1:8000",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
  ],
  alternates: { live: LIVE },
};

function loadPosAuth(env) {
  const sandbox = {
    console,
    URL,
    WA_ENV: env,
    self: {},
    window: {},
  };
  vm.createContext(sandbox);
  vm.runInContext(POS_AUTH, sandbox, { filename: "posAuth.js" });
  assert.equal(typeof sandbox.isAllowedPosApiUrl, "function");
  return sandbox;
}

test("live build allows only the live chat API", () => {
  const api = loadPosAuth(LIVE);
  assert.equal(
    api.isAllowedPosApiUrl(
      "https://testv3.websitedemolynk.com/pos_admin/api/chat/fetch-random?company_id=abc",
    ),
    true,
  );
  assert.equal(
    api.isAllowedPosApiUrl(
      "https://testv3.websitedemolynk.com/pos_admin/api/chat/create/:token",
    ),
    true,
  );
  assert.equal(
    api.isAllowedPosApiUrl("https://evil.example/api/chat/fetch-random"),
    false,
  );
  assert.equal(
    api.isAllowedPosApiUrl("http://localhost:8000/api/chat/fetch-random"),
    false,
  );
  assert.equal(
    api.isAllowedPosApiUrl("https://testv3.websitedemolynk.com/pos/"),
    false,
  );
  assert.equal(
    api.isAllowedPosApiUrl(
      "https://user:secret@testv3.websitedemolynk.com/pos_admin/api/chat/fetch-random",
    ),
    false,
  );
  assert.equal(
    api.isAllowedPosApiUrl(
      "https://testv3.websitedemolynk.com/pos_admin/api/chat/../../admin",
    ),
    false,
  );
});

test("local build may call localhost or the embedded live host", () => {
  const api = loadPosAuth(LOCAL);
  assert.equal(
    api.isAllowedPosApiUrl("http://localhost:8000/api/chat/mark-sent/abc"),
    true,
  );
  assert.equal(
    api.isAllowedPosApiUrl(
      "https://testv3.websitedemolynk.com/pos_admin/api/chat/mark-sent/abc",
    ),
    true,
  );
  assert.equal(api.isAllowedPosApiUrl("https://evil.example/api/chat/x"), false);
});

test("create URL still receives the token, and logs do not", () => {
  const api = loadPosAuth(LIVE);
  const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature";
  const template =
    "https://testv3.websitedemolynk.com/pos_admin/api/chat/create/:token";
  const url = api.buildReceivePostUrl(template, token);
  assert.ok(url.includes(encodeURIComponent(token)));
  assert.equal(api.isAllowedPosApiUrl(url), true);
  const redacted = api.redactSensitiveUrl(url);
  assert.equal(redacted.includes(token), false);
  assert.match(redacted, /\/create\/\[token\]/);
  const info = api.formatApiErrorInfo({ status: 401, url, error: "nope" });
  assert.equal(info.url.includes(token), false);
  assert.equal(info.tooltip.includes(token), false);
});

test("chat document id still prefers _id", () => {
  const api = loadPosAuth(LIVE);
  assert.equal(
    api.extractChatDocumentId({ _id: "abc123", message_id: "wa-1" }),
    "abc123",
  );
  assert.equal(api.extractChatDocumentId({ id: ":id" }), "");
  const item = api.normalizeChatQueueItem({
    _id: "abc123",
    message: "Hello",
    to_user_id: "923001234567",
  });
  assert.equal(item._id, "abc123");
  assert.equal(item.number, "923001234567");
  assert.equal(item.message, "Hello");
});
