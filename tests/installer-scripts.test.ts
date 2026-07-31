import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("installer surfaces staged progress and the Windows shell boundary", async () => {
  const [powershell, shell, readme] = await Promise.all([
    readFile("scripts/install.ps1", "utf8"),
    readFile("scripts/install.sh", "utf8"),
    readFile("README.md", "utf8")
  ]);

  assert.equal(powershell.charCodeAt(0), 0xFEFF, "Windows PowerShell installer must declare UTF-8 encoding");
  assert.match(powershell, /### \[\{0\}\/\{1\}\]/);
  assert.match(shell, /### \[%s\/%s\]/);
  assert.match(powershell, /SetEnvironmentVariable\("Path",/);
  assert.match(powershell, /yt2\.cmd/);
  assert.match(readme, /irm https:\/\/raw\.githubusercontent\.com\/qkrwndnjs1075\/yt2sheet\/main\/scripts\/install\.ps1 \| iex/);
  assert.match(readme, /yt2 "https:\/\/www\.youtube\.com\/watch\?v=VIDEO_ID"/);
  assert.match(readme, /wrap the entire URL in double quotes/);
});
