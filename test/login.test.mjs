import { test } from "node:test";
import assert from "node:assert/strict";

import { login } from "../dist/login.js";
import { startFakeWeixin } from "./fake-weixin.mjs";

function fakeIO(answers = []) {
  const lines = [];
  const qrs = [];
  const prompts = [];
  return {
    lines,
    qrs,
    prompts,
    print: (line) => lines.push(line),
    showQr: (content) => qrs.push(content),
    ask: async (prompt) => {
      prompts.push(prompt);
      return answers.shift() ?? "";
    },
  };
}

async function fake(t, qrStatuses) {
  const f = await startFakeWeixin({ qrStatuses });
  t.after(() => f.close());
  return f;
}

test("login returns the token after the scan is confirmed", async (t) => {
  const f = await fake(t, [
    { status: "wait" },
    { status: "scaned" },
    { status: "scaned" },
    { status: "confirmed", bot_token: "new-token", baseurl: "https://ilinkai.weixin.qq.com", ilink_user_id: "u1@im.wechat", ilink_bot_id: "b1@im.bot" },
  ]);
  const io = fakeIO();
  const result = await login(io, { language: "en", baseUrl: f.url, pollDelayMs: 1 });
  assert.deepEqual(result, { token: "new-token", baseUrl: "https://ilinkai.weixin.qq.com", userId: "u1@im.wechat", botId: "b1@im.bot" });
  assert.deepEqual(io.qrs, ["https://liteapp.example/q/1"]);
  assert.equal(io.lines.filter((l) => l.startsWith("Scanned")).length, 1);
  assert.ok(io.lines.includes("WeChat login succeeded."));
  const qrCall = f.calls.items.find((c) => c.path === "/ilink/bot/get_bot_qrcode");
  assert.equal(qrCall.query.bot_type, "3");
  const polls = f.calls.items.filter((c) => c.path === "/ilink/bot/get_qrcode_status");
  assert.equal(polls.length, 4);
  assert.ok(polls.every((c) => c.query.qrcode === "qr-1"));
});

test("login asks for the number shown on the phone", async (t) => {
  const f = await fake(t, [
    { status: "need_verifycode" },
    { status: "need_verifycode" },
    { status: "scaned" },
    { status: "confirmed", bot_token: "tok" },
  ]);
  const io = fakeIO(["11", " 42 "]);
  const result = await login(io, { language: "zh", baseUrl: f.url, pollDelayMs: 1 });
  assert.equal(result.token, "tok");
  assert.deepEqual(io.prompts, ["请输入手机微信上显示的数字：", "数字不匹配，请重新输入："]);
  const polls = f.calls.items.filter((c) => c.path === "/ilink/bot/get_qrcode_status");
  assert.deepEqual(
    polls.map((c) => c.query.verify_code),
    [undefined, "11", "42", undefined],
  );
});

test("login refreshes an expired QR code and gives up after the limit", async (t) => {
  const f = await fake(t, [{ status: "expired" }, { status: "confirmed", bot_token: "tok" }]);
  const io = fakeIO();
  assert.equal((await login(io, { language: "en", baseUrl: f.url, pollDelayMs: 1 })).token, "tok");
  assert.deepEqual(io.qrs, ["https://liteapp.example/q/1", "https://liteapp.example/q/2"]);
  const polls = f.calls.items.filter((c) => c.path === "/ilink/bot/get_qrcode_status");
  assert.deepEqual(
    polls.map((c) => c.query.qrcode),
    ["qr-1", "qr-2"],
  );

  const g = await fake(t, [{ status: "expired" }, { status: "expired" }, { status: "expired" }]);
  await assert.rejects(login(fakeIO(), { language: "en", baseUrl: g.url, pollDelayMs: 1 }), /expired too many times/);
});

test("login fails on blocked codes, missing tokens, bound accounts and timeouts", async (t) => {
  const blocked = await fake(t, [{ status: "verify_code_blocked" }, { status: "verify_code_blocked" }, { status: "verify_code_blocked" }]);
  await assert.rejects(login(fakeIO(), { language: "en", baseUrl: blocked.url, pollDelayMs: 1 }), /expired too many times/);

  const noToken = await fake(t, [{ status: "confirmed" }]);
  await assert.rejects(login(fakeIO(), { language: "en", baseUrl: noToken.url, pollDelayMs: 1 }), /no token/);

  const bound = await fake(t, [{ status: "binded_redirect" }]);
  await assert.rejects(login(fakeIO(), { language: "en", baseUrl: bound.url, pollDelayMs: 1 }), /already connected/);

  const waiting = await fake(t, []);
  await assert.rejects(login(fakeIO(), { language: "en", baseUrl: waiting.url, pollDelayMs: 5, timeoutMs: 50 }), /Timed out/);
});
