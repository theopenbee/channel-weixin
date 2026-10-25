import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { TOKEN, startFakeWeixin } from "./fake-weixin.mjs";

const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

function startPlugin() {
  const child = spawn(process.execPath, [entry], { stdio: ["pipe", "pipe", "pipe"] });
  const messages = [];
  const waiters = [];
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    messages.push(msg);
    for (const w of [...waiters]) {
      if (w.match(msg)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(msg);
      }
    }
  });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  let nextId = 1;
  return {
    child,
    exited,
    messages,
    stderr: () => stderr,
    waitFor(match, ms = 5000) {
      const found = messages.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out; stderr: ${stderr}`)), ms);
        waiters.push({ match, resolve: (m) => (clearTimeout(timer), resolve(m)) });
      });
    },
    request(method, params) {
      const id = nextId++;
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      return this.waitFor((m) => m.id === id, 15000);
    },
  };
}

function initParams(fake, config) {
  return {
    protocol_version: 1,
    openbee_version: "test",
    channel_id: "weixin",
    language: "zh",
    bot_name: "OpenBee",
    config,
    data_dir: mkdtempSync(join(tmpdir(), "wx-data-")),
    media_dir: mkdtempSync(join(tmpdir(), "wx-media-")),
  };
}

test("the plugin process speaks the openbee channel protocol", async (t) => {
  const fake = await startFakeWeixin();
  const p = startPlugin();
  t.after(async () => {
    p.child.stdin.end();
    await p.exited;
    await fake.close();
  });
  const init = await p.request("initialize", initParams(fake, { token: TOKEN, base_url: fake.url, cdn_base_url: fake.cdnUrl }));
  assert.deepEqual(init.result, { protocol_version: 1 });

  fake.pushUpdate({
    ret: 0,
    get_updates_buf: "b1",
    msgs: [{ seq: 1, message_id: 2, from_user_id: "u1@im.wechat", message_type: 1, message_state: 2, context_token: "c1", item_list: [{ type: 1, text_item: { text: "ping" } }] }],
  });
  const inbound = await p.waitFor((m) => m.method === "inbound");
  assert.equal(inbound.params.text, "ping");
  assert.equal(inbound.params.chat_id, "u1@im.wechat");

  const sent = await p.request("send", {
    session_key: "weixin:u1@im.wechat:u1@im.wechat",
    chat_id: "u1@im.wechat",
    session_scope: "u1@im.wechat",
    proactive: false,
    reply_to: { message_id: "1:2", raw: inbound.params.raw },
    content: "pong",
  });
  assert.deepEqual(sent.result, { platform_message_id: "9007199254740993123" });
  assert.ok(!p.stderr().includes(TOKEN));
  assert.ok(!JSON.stringify(p.messages).includes(TOKEN));

  const shutdown = await p.request("shutdown", {});
  assert.deepEqual(shutdown.result, {});
  assert.equal(await p.exited, 0);
});

test("a missing token is reported as a config error", async (t) => {
  const fake = await startFakeWeixin();
  const p = startPlugin();
  t.after(async () => {
    p.child.stdin.end();
    await p.exited;
    await fake.close();
  });
  const init = await p.request("initialize", initParams(fake, {}));
  assert.equal(init.error.code, -32001);
  assert.match(init.error.message, /token is required/);
});
