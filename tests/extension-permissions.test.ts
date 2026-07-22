import assert from "node:assert/strict";
import { test } from "node:test";
import { proxyOriginPermissionPattern } from "../src/shared/extension-permissions.js";

test("proxy host permission pattern supports HTTPS and local HTTP proxies", () => {
  assert.equal(proxyOriginPermissionPattern("https://proxy.example.com/claude"), "https://proxy.example.com/*");
  assert.equal(proxyOriginPermissionPattern("http://localhost:8787/claude"), "http://localhost/*");
  assert.equal(proxyOriginPermissionPattern("http://127.0.0.1:8787/claude"), "http://127.0.0.1/*");
  assert.equal(proxyOriginPermissionPattern("http://proxy.example.com/claude"), null);
  assert.equal(proxyOriginPermissionPattern("not a url"), null);
});

