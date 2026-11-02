import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encode } from "silk-wasm";

import { createWeixinChannel } from "../dist/weixin.js";
import { TOKEN, decrypt, startFakeWeixin } from "./fake-weixin.mjs";

const FAST = { retryDelayMs: 5, slowRetryDelayMs: 10, stalePauseMs: 30, uploadRetryDelayMs: 1, downloadRetryDelayMs: 1 };
const USER = "u1@im.wechat";
const RAW = `{"from_user_id":"${USER}","to_user_id":"bot@im.bot","session_id":"s1","context_token":"ctx-1"}`;

function waitList() {
  const items = [];
  const waiters = [];
  return {
    items,
    add(item) {
      items.push(item);
      for (const w of [...waiters]) {
        if (w.match(item)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(item);
        }
      }
    },
    waitFor(match, ms = 5000, label = "item") {
      const found = items.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
        waiters.push({ match, resolve: (v) => (clearTimeout(timer), resolve(v)) });
      });
    },
  };
}

function fakeContext(fake, config = {}, dirs = {}) {
  const dataDir = dirs.dataDir ?? mkdtempSync(join(tmpdir(), "wx-data-"));
  const mediaDir = dirs.mediaDir ?? mkdtempSync(join(tmpdir(), "wx-media-"));
  const inbound = waitList();
  const logs = waitList();
  let n = 0;
  const log = (level) => (message, fields) => logs.add({ level, message, fields });
  return {
    inbound,
    logs,
    ctx: {
      channelId: "weixin",
      config: { token: TOKEN, base_url: fake.url, cdn_base_url: fake.cdnUrl, ...config },
      botName: "OpenBee",
      language: "en",
      dataDir,
      mediaDir,
      openbeeVersion: "test",
      dispatch: (m) => inbound.add(m),
      migrateChat: () => {},
      saveMedia: async (data, ext) => {
        const path = join(mediaDir, `m${++n}${ext}`);
        writeFileSync(path, data);
        return path;
      },
      log: { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") },
    },
  };
}

async function started(t, { updates = [], handlers = {}, config = {}, dirs, timings = {} } = {}) {
  const fake = await startFakeWeixin({ updates, handlers });
  const env = fakeContext(fake, config, dirs);
  const channel = createWeixinChannel({ ...FAST, ...timings });
  const handle = await channel.start(env.ctx);
  t.after(async () => {
    await handle.stop();
    await fake.close();
  });
  return { fake, channel, handle, ...env };
}

function userMessage(over = {}) {
  return {
    seq: 5,
    message_id: 1,
    from_user_id: USER,
    to_user_id: "bot@im.bot",
    create_time_ms: 1700000000000,
    session_id: "s1",
    message_type: 1,
    message_state: 2,
    item_list: [{ type: 1, text_item: { text: "hello" } }],
    context_token: "ctx-1",
    ...over,
  };
}

const updates = (...msgs) => ({ ret: 0, msgs, get_updates_buf: `buf-${msgs.length}` });

function sendRequest(over = {}) {
  return {
    session_key: `weixin:${USER}:${USER}`,
    chat_id: USER,
    session_scope: USER,
    proactive: false,
    reply_to: { message_id: "5:1", raw: RAW },
    ...over,
  };
}

test("inbound text becomes an openbee message with the built-in session and raw", async (t) => {
  const update = `{"ret":0,"msgs":[{"seq":5,"message_id":9007199254740993123,"from_user_id":"${USER}","to_user_id":"bot@im.bot","create_time_ms":1700000000000,"session_id":"s1","message_type":1,"message_state":2,"item_list":[{"type":1,"text_item":{"text":"hello"}}],"context_token":"ctx-1"}],"get_updates_buf":"buf-1"}`;
  const { fake, inbound } = await started(t, { updates: [update] });
  const msg = await inbound.waitFor(() => true);
  assert.deepEqual(msg, {
    chat_id: USER,
    sender_id: USER,
    message_id: "5:9007199254740993123",
    text: "hello",
    raw: RAW,
    time: 1700000000000,
  });
  const getupdates = await fake.calls.waitFor((c) => c.path === "/ilink/bot/getupdates");
  assert.equal(getupdates.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(getupdates.headers.authorizationtype, "ilink_bot_token");
  assert.ok(getupdates.headers["x-wechat-uin"]);
  assert.equal(getupdates.body.get_updates_buf, "");
  assert.equal(getupdates.body.base_info.channel_version, "1.0.2");
  const typing = await fake.calls.waitFor((c) => c.path === "/ilink/bot/sendtyping");
  assert.deepEqual({ ...typing.body, base_info: undefined }, { ilink_user_id: USER, typing_ticket: "ticket-1", status: 1, base_info: undefined });
  const config = fake.calls.items.find((c) => c.path === "/ilink/bot/getconfig");
  assert.equal(config.body.ilink_user_id, USER);
  assert.equal(config.body.context_token, "ctx-1");
});

test("bot, unfinished, group and empty messages are ignored", async (t) => {
  const { inbound } = await started(t, {
    updates: [
      updates(
        userMessage({ message_id: 1, message_type: 2 }),
        userMessage({ message_id: 2, message_state: 1 }),
        userMessage({ message_id: 3, group_id: "g1" }),
        userMessage({ message_id: 4, item_list: [] }),
        userMessage({ message_id: 5, item_list: [{ type: 99 }] }),
        userMessage({ message_id: 6, item_list: [{ type: 1, text_item: { text: "kept" } }] }),
      ),
    ],
  });
  const msg = await inbound.waitFor(() => true);
  assert.equal(msg.message_id, "5:6");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(inbound.items.length, 1);
});

test("the sync cursor is saved and reused for the same token only", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "wx-data-"));
  const first = await started(t, { updates: [updates(userMessage())], dirs: { dataDir } });
  await first.inbound.waitFor(() => true);
  await first.fake.calls.waitFor((c) => c.path === "/ilink/bot/getupdates" && c.body.get_updates_buf === "buf-1");
  await first.handle.stop();
  assert.equal(JSON.parse(readFileSync(join(dataDir, "sync.json"), "utf8")).get_updates_buf, "buf-1");

  const second = await started(t, { dirs: { dataDir } });
  const call = await second.fake.calls.waitFor((c) => c.path === "/ilink/bot/getupdates");
  assert.equal(call.body.get_updates_buf, "buf-1");

  const other = await started(t, { dirs: { dataDir }, config: { token: "another-token" } });
  const otherCall = await other.fake.calls.waitFor((c) => c.path === "/ilink/bot/getupdates");
  assert.equal(otherCall.body.get_updates_buf, "");
});

test("pictures, files and videos are downloaded and decrypted", async (t) => {
  const fake = await startFakeWeixin();
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(40)]);
  const imageKey = fake.addFile("img-1", png);
  const pdf = Buffer.from("%PDF-1.7 report");
  const fileKey = fake.addFile("file-1", pdf);
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), randomBytes(20)]);
  const videoKey = fake.addFile("vid-1", mp4);
  const env = fakeContext(fake);
  const handle = await createWeixinChannel(FAST).start(env.ctx);
  t.after(async () => {
    await handle.stop();
    await fake.close();
  });
  fake.pushUpdate(
    updates(
      userMessage({
        item_list: [
          { type: 1, text_item: { text: "see attached" } },
          { type: 2, image_item: { aeskey: imageKey.toString("hex"), media: { encrypt_query_param: "img-1", aes_key: "ignored" } } },
          { type: 4, file_item: { file_name: "q3/report.pdf", media: { encrypt_query_param: "file-1", aes_key: Buffer.from(fileKey.toString("hex")).toString("base64") } } },
          { type: 5, video_item: { media: { full_url: `${fake.cdnUrl}/download?encrypted_query_param=vid-1`, aes_key: videoKey.toString("base64") } } },
        ],
      }),
    ),
  );
  const msg = await env.inbound.waitFor(() => true);
  assert.equal(msg.text, "see attached");
  const [image, file, video] = msg.attachments;
  assert.equal(image.type, "image");
  assert.ok(image.path.endsWith(".png"));
  assert.deepEqual(readFileSync(image.path), png);
  assert.equal(file.type, "document");
  assert.equal(file.name, "q3_report.pdf");
  assert.ok(file.path.endsWith(".pdf"));
  assert.deepEqual(readFileSync(file.path), pdf);
  assert.equal(video.type, "video");
  assert.ok(video.path.endsWith(".mp4"));
  assert.deepEqual(readFileSync(video.path), mp4);
});

test("voice messages are transcoded to WAV and keep the transcript", async (t) => {
  const fake = await startFakeWeixin();
  const pcm = Buffer.alloc(24000 * 2 * 0.2);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 10) * 8000), i * 2);
  const silk = Buffer.from((await encode(pcm, 24000)).data);
  const key = fake.addFile("voice-1", silk);
  const env = fakeContext(fake);
  const handle = await createWeixinChannel(FAST).start(env.ctx);
  t.after(async () => {
    await handle.stop();
    await fake.close();
  });
  fake.pushUpdate(updates(userMessage({ item_list: [{ type: 3, voice_item: { text: "what time is it", sample_rate: 24000, media: { encrypt_query_param: "voice-1", aes_key: key.toString("base64") } } }] })));
  const msg = await env.inbound.waitFor(() => true);
  assert.equal(msg.text, "what time is it");
  const [voice] = msg.attachments;
  assert.equal(voice.type, "audio");
  assert.equal(voice.name, "voice.wav");
  const wav = readFileSync(voice.path);
  assert.equal(wav.toString("latin1", 0, 4), "RIFF");
  assert.ok(wav.length > 44);
});

test("failed downloads keep a placeholder and do not stop the message", async (t) => {
  const { inbound, logs } = await started(t, {
    updates: [
      updates(
        userMessage({
          item_list: [
            { type: 2, image_item: { media: { encrypt_query_param: "missing", aes_key: randomBytes(16).toString("base64") } } },
            { type: 3, voice_item: { media: { encrypt_query_param: "missing" } } },
            { type: 4, file_item: { file_name: "a.txt", media: {} } },
          ],
        }),
      ),
    ],
  });
  const msg = await inbound.waitFor(() => true);
  assert.deepEqual(msg.attachments, [
    { type: "image", path: "" },
    { type: "audio", path: "", name: "voice.silk" },
    { type: "document", path: "", name: "a.txt" },
  ]);
  assert.ok(logs.items.some((l) => l.message === "download media failed"));
  assert.ok(logs.items.some((l) => l.message === "media has no aes key"));
});

test("an expired login pauses polling and errors back off", async (t) => {
  let n = 0;
  const { fake, logs } = await started(t, {
    handlers: {
      "/ilink/bot/getupdates": (req, res) => {
        n++;
        const body = n === 1 ? { ret: -14, errcode: -14, errmsg: "session timeout" } : n === 2 ? { ret: 0, errcode: -1 } : null;
        if (n === 3) {
          res.writeHead(502);
          res.end("bad gateway");
          return;
        }
        if (!body) return false;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      },
    },
  });
  await logs.waitFor((l) => l.level === "error" && /login expired/.test(l.message));
  await logs.waitFor((l) => l.message === "getupdates returned an error");
  await logs.waitFor((l) => l.message === "getupdates failed");
  await fake.calls.waitFor(() => fake.calls.items.filter((c) => c.path === "/ilink/bot/getupdates").length >= 4);
  const all = JSON.stringify(logs.items);
  assert.ok(!all.includes(TOKEN));
});

test("replies go to the origin user with its context token", async (t) => {
  const { fake, channel, ctx } = await started(t);
  const result = await channel.send(sendRequest({ content: "hi there" }), ctx, new AbortController().signal);
  assert.deepEqual(result, { platform_message_id: "9007199254740993123" });
  const call = await fake.calls.waitFor((c) => c.path === "/ilink/bot/sendmessage");
  const { msg } = call.body;
  assert.equal(msg.to_user_id, USER);
  assert.equal(msg.context_token, "ctx-1");
  assert.equal(msg.session_id, "s1");
  assert.equal(msg.message_type, 2);
  assert.equal(msg.message_state, 2);
  assert.match(msg.client_id, /^[0-9a-f]{32}$/);
  assert.deepEqual(msg.item_list, [{ type: 1, text_item: { text: "hi there" } }]);
});

test("long replies are split into several messages", async (t) => {
  const { fake, channel, ctx } = await started(t);
  const content = "a".repeat(3000) + "\n" + "b".repeat(3000);
  await channel.send(sendRequest({ content }), ctx, new AbortController().signal);
  const sent = fake.calls.items.filter((c) => c.path === "/ilink/bot/sendmessage").map((c) => c.body.msg.item_list[0].text_item.text);
  assert.deepEqual(sent, ["a".repeat(3000), "b".repeat(3000)]);
});

test("proactive sends go to the session user without a quoted message", async (t) => {
  const { fake, channel, ctx, logs } = await started(t);
  await channel.send(sendRequest({ proactive: true, reply_to: undefined, content: "scheduled result" }), ctx, new AbortController().signal);
  const call = await fake.calls.waitFor((c) => c.path === "/ilink/bot/sendmessage");
  assert.equal(call.body.msg.to_user_id, USER);
  assert.equal(call.body.msg.context_token, undefined);
  assert.ok(logs.items.some((l) => l.level === "warn" && /context_token/.test(l.message)));
});

test("pictures are uploaded encrypted and sent as image items", async (t) => {
  const { fake, channel, ctx } = await started(t);
  const dir = mkdtempSync(join(tmpdir(), "wx-out-"));
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(100)]);
  const path = join(dir, "chart.png");
  writeFileSync(path, png);
  await channel.send(sendRequest({ content: "chart below", media: { path, name: "chart.png" } }), ctx, new AbortController().signal);

  const upload = fake.calls.items.find((c) => c.path === "/ilink/bot/getuploadurl").body;
  assert.equal(upload.media_type, 1);
  assert.equal(upload.to_user_id, USER);
  assert.equal(upload.rawsize, png.length);
  assert.equal(upload.filesize, 112);
  assert.equal(upload.no_need_thumb, true);
  assert.match(upload.aeskey, /^[0-9a-f]{32}$/);
  assert.match(upload.filekey, /^[0-9a-f]{32}$/);
  const cdn = fake.calls.items.find((c) => c.path === "/cdn/upload");
  assert.equal(cdn.method, "POST");
  assert.equal(cdn.query.filekey, upload.filekey);
  assert.deepEqual(decrypt(cdn.raw, Buffer.from(upload.aeskey, "hex")), png);

  const sent = fake.calls.items.filter((c) => c.path === "/ilink/bot/sendmessage").map((c) => c.body.msg.item_list[0]);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], { type: 1, text_item: { text: "chart below" } });
  assert.equal(sent[1].type, 2);
  assert.equal(sent[1].image_item.media.encrypt_query_param, "dl-1");
  assert.equal(sent[1].image_item.media.aes_key, Buffer.from(upload.aeskey).toString("base64"));
  assert.equal(sent[1].image_item.media.encrypt_type, 1);
  assert.equal(sent[1].image_item.mid_size, 112);
});

test("other files are sent as file items, retrying failed upload URL requests", async (t) => {
  let attempts = 0;
  const { fake, channel, ctx } = await started(t, {
    handlers: {
      "/ilink/bot/getuploadurl": (req, res) => {
        if (++attempts > 1) return false;
        res.writeHead(500);
        res.end("oops");
      },
    },
  });
  const dir = mkdtempSync(join(tmpdir(), "wx-out-"));
  const path = join(dir, "notes.txt");
  writeFileSync(path, "meeting notes");
  await channel.send(sendRequest({ media: { path, name: "notes.txt" } }), ctx, new AbortController().signal);
  assert.equal(attempts, 2);
  const upload = fake.calls.items.filter((c) => c.path === "/ilink/bot/getuploadurl").at(-1).body;
  assert.equal(upload.media_type, 3);
  const item = fake.calls.items.find((c) => c.path === "/ilink/bot/sendmessage").body.msg.item_list[0];
  assert.equal(item.type, 4);
  assert.equal(item.file_item.file_name, "notes.txt");
  assert.equal(item.file_item.len, "13");
});

test("send errors are reported", async (t) => {
  const { channel, ctx } = await started(t, {
    config: { max_media_size: 10 },
    handlers: {
      "/ilink/bot/sendmessage": (req, res, call) => {
        if (call.body.msg.item_list[0].text_item?.text !== "fail") return false;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ret: -2, errmsg: "bad context" }));
      },
    },
  });
  const signal = new AbortController().signal;
  await assert.rejects(channel.send(sendRequest({ content: "fail" }), ctx, signal), /ret=-2 errmsg=bad context/);
  const dir = mkdtempSync(join(tmpdir(), "wx-out-"));
  const path = join(dir, "big.bin");
  writeFileSync(path, Buffer.alloc(11));
  await assert.rejects(channel.send(sendRequest({ media: { path, name: "big.bin" } }), ctx, signal), /file too large/);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(channel.send(sendRequest({ content: "x" }), ctx, aborted.signal), /cancelled/);
});

test("a rejected CDN upload is not retried", async (t) => {
  let uploads = 0;
  const { channel, ctx } = await started(t, {
    handlers: {
      "/cdn/upload": (req, res) => {
        uploads++;
        res.writeHead(400, { "x-error-message": "bad filekey" });
        res.end();
      },
    },
  });
  const dir = mkdtempSync(join(tmpdir(), "wx-out-"));
  const path = join(dir, "a.txt");
  writeFileSync(path, "x");
  await assert.rejects(channel.send(sendRequest({ media: { path, name: "a.txt" } }), ctx, new AbortController().signal), /bad filekey/);
  assert.equal(uploads, 1);
});

test("start rejects a missing token", async () => {
  await assert.rejects(async () => createWeixinChannel(FAST).start({ config: {} }), /token is required/);
});

const fileItem = (param, key) => ({ type: 4, file_item: { file_name: "a.txt", media: { encrypt_query_param: param, aes_key: key.toString("base64") } } });
const cdnCalls = (fake) => fake.calls.items.filter((c) => c.path === "/cdn/download").length;
const retryLogs = (logs) => logs.items.filter((l) => l.level === "warn" && l.message === "download media failed, retrying");
const dropConnection = (req, res) => {
  res.socket.destroy();
  return true;
};

test("a dropped CDN download is retried until the file arrives", async (t) => {
  let drops = 2;
  const { fake, inbound, logs } = await started(t, {
    handlers: { "/cdn/download": (req, res) => (drops-- > 0 ? dropConnection(req, res) : false) },
  });
  const key = fake.addFile("flaky", Buffer.from("payload"));
  fake.pushUpdate(updates(userMessage({ item_list: [fileItem("flaky", key)] })));
  const msg = await inbound.waitFor(() => true);
  assert.equal(readFileSync(msg.attachments[0].path, "utf8"), "payload");
  assert.equal(cdnCalls(fake), 3);
  assert.equal(retryLogs(logs).length, 2);
});

test("a CDN server error is retried", async (t) => {
  let failures = 1;
  const { fake, inbound } = await started(t, {
    handlers: {
      "/cdn/download": (req, res) => {
        if (failures-- <= 0) return false;
        res.writeHead(502);
        res.end();
        return true;
      },
    },
  });
  const key = fake.addFile("flaky", Buffer.from("payload"));
  fake.pushUpdate(updates(userMessage({ item_list: [fileItem("flaky", key)] })));
  const msg = await inbound.waitFor(() => true);
  assert.equal(readFileSync(msg.attachments[0].path, "utf8"), "payload");
  assert.equal(cdnCalls(fake), 2);
});

test("a CDN download that keeps failing stops after three attempts", async (t) => {
  const { fake, inbound } = await started(t, { handlers: { "/cdn/download": dropConnection } });
  fake.pushUpdate(updates(userMessage({ item_list: [fileItem("down", randomBytes(16))] })));
  const msg = await inbound.waitFor(() => true);
  assert.deepEqual(msg.attachments, [{ type: "document", path: "", name: "a.txt" }]);
  assert.equal(cdnCalls(fake), 3);
});

test("rejected and oversized CDN downloads are not retried", async (t) => {
  const { fake, inbound, logs } = await started(t, {
    config: { max_media_size: 8 },
    handlers: {
      "/cdn/download": (req, res, call) => {
        if (call.query.encrypted_query_param !== "declared") return false;
        res.writeHead(200, { "content-length": "32" });
        res.end(Buffer.alloc(32));
        return true;
      },
    },
  });
  const key = fake.addFile("streamed", Buffer.alloc(32));
  fake.pushUpdate(updates(userMessage({ item_list: [fileItem("missing", key), fileItem("streamed", key), fileItem("declared", key)] })));
  const msg = await inbound.waitFor(() => true);
  assert.deepEqual(msg.attachments.map((a) => a.path), ["", "", ""]);
  assert.equal(cdnCalls(fake), 3);
  assert.equal(retryLogs(logs).length, 0);
});

test("stopping the channel cancels a pending CDN retry", async (t) => {
  const { fake, handle, logs } = await started(t, { handlers: { "/cdn/download": dropConnection }, timings: { downloadRetryDelayMs: 60_000 } });
  fake.pushUpdate(updates(userMessage({ item_list: [fileItem("down", randomBytes(16))] })));
  await logs.waitFor((l) => l.message === "download media failed, retrying");
  await handle.stop();
  assert.equal(cdnCalls(fake), 1);
});
