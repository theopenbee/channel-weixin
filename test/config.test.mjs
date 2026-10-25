import { test } from "node:test";
import assert from "node:assert/strict";

import { ConfigError } from "@theopenbee/channel-sdk";

import { readConfig } from "../dist/weixin.js";

test("readConfig applies defaults for empty values", () => {
  assert.deepEqual(readConfig({ token: " tok ", base_url: "", cdn_base_url: "", user_id: "legacy@im.wechat" }), {
    token: "tok",
    baseUrl: "https://ilinkai.weixin.qq.com",
    cdnBaseUrl: "https://novac2c.cdn.weixin.qq.com/c2c",
    maxMediaSize: 104857600,
  });
  const custom = readConfig({ token: "t", base_url: "http://proxy", cdn_base_url: "http://cdn", route_tag: 7, max_media_size: 1024 });
  assert.equal(custom.baseUrl, "http://proxy");
  assert.equal(custom.cdnBaseUrl, "http://cdn");
  assert.equal(custom.routeTag, 7);
  assert.equal(custom.maxMediaSize, 1024);
  assert.equal(readConfig({ token: "t", route_tag: 0 }).routeTag, undefined);
});

test("readConfig requires the token", () => {
  assert.throws(() => readConfig({}), (err) => err instanceof ConfigError && /token is required/.test(err.message));
  assert.throws(() => readConfig({ token: "  " }), ConfigError);
  assert.throws(() => readConfig({ token: 5 }), ConfigError);
});
