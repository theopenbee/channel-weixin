import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the manifest ships a one-colour SVG icon", () => {
  assert.equal(JSON.parse(read("openbee.plugin.json")).icon, "icon.svg");
  assert.ok(JSON.parse(read("package.json")).files.includes("icon.svg"));
  const icon = read("icon.svg");
  assert.match(icon, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(icon, /currentColor/);
  assert.doesNotMatch(icon, /#[0-9a-f]{3,6}\b/i);
  assert.ok(icon.length <= 32 * 1024);
});
