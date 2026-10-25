import { test } from "node:test";
import assert from "node:assert/strict";

import { parseApiJson } from "../dist/api.js";
import { aesEcbPaddedSize, decryptAesEcb, encryptAesEcb, hexKeyToBase64, parseAesKey } from "../dist/crypto.js";
import { chunkText, encodeRaw, messageId, outboundKind, parseRaw, sanitizeFileName, sendTarget, shouldHandle, sniffExtension, textParts } from "../dist/helpers.js";
import { pcmToWav } from "../dist/silk.js";

test("parseApiJson keeps uint64 ids exact", () => {
  const got = parseApiJson(`{"msgs":[{"seq":12,"message_id": 9007199254740993123,"item_list":[{"msg_id":18446744073709551615,"text_item":{"text":"\\"message_id\\": 1"}}],"create_time_ms":1700000000000}],"ret":0}`);
  assert.equal(got.msgs[0].message_id, "9007199254740993123");
  assert.equal(got.msgs[0].seq, "12");
  assert.equal(got.msgs[0].item_list[0].msg_id, "18446744073709551615");
  assert.equal(got.msgs[0].item_list[0].text_item.text, `"message_id": 1`);
  assert.equal(got.msgs[0].create_time_ms, 1700000000000);
  assert.equal(got.ret, 0);
});

test("messageId matches the built-in channel format", () => {
  assert.equal(messageId({ seq: "10", message_id: "42" }), "10:42");
  assert.equal(messageId({ seq: 3 }), "3:0");
  assert.equal(messageId({}), "0:0");
});

test("raw round-trips the reply context", () => {
  const raw = encodeRaw({ from_user_id: "u1@im.wechat", to_user_id: "bot@im.bot", session_id: "s1", context_token: "ctx", item_list: [] });
  assert.equal(raw, `{"from_user_id":"u1@im.wechat","to_user_id":"bot@im.bot","session_id":"s1","context_token":"ctx"}`);
  assert.deepEqual(parseRaw(raw), { from_user_id: "u1@im.wechat", to_user_id: "bot@im.bot", session_id: "s1", context_token: "ctx" });
  assert.equal(parseRaw("not json"), undefined);
  assert.equal(parseRaw("[1]"), undefined);
  assert.equal(parseRaw(undefined), undefined);
});

test("sendTarget uses the origin message, or the chat for proactive sends", () => {
  const raw = `{"from_user_id":"u1@im.wechat","to_user_id":"bot","session_id":"s9","context_token":"ctx-latest"}`;
  const base = { session_key: "weixin:u1@im.wechat:u1@im.wechat", chat_id: "u1@im.wechat", session_scope: "u1@im.wechat" };
  assert.deepEqual(sendTarget({ ...base, proactive: false, reply_to: { raw } }), { toUserId: "u1@im.wechat", sessionId: "s9", contextToken: "ctx-latest" });
  assert.deepEqual(sendTarget({ ...base, proactive: true, reply_to: { raw } }), { toUserId: "u1@im.wechat", sessionId: "s9", contextToken: "ctx-latest" });
  assert.deepEqual(sendTarget({ ...base, proactive: true }), { toUserId: "u1@im.wechat", sessionId: "", contextToken: "" });
  assert.deepEqual(sendTarget({ ...base, proactive: false, reply_to: { raw: "garbage" } }), { toUserId: "u1@im.wechat", sessionId: "", contextToken: "" });
});

test("shouldHandle keeps finished direct user messages only", () => {
  const msg = { message_type: 1, message_state: 2, from_user_id: "u1", item_list: [{ type: 1 }] };
  assert.equal(shouldHandle(msg), true);
  assert.equal(shouldHandle({ ...msg, message_type: 2 }), false);
  assert.equal(shouldHandle({ ...msg, message_state: 1 }), false);
  assert.equal(shouldHandle({ ...msg, group_id: "g1" }), false);
  assert.equal(shouldHandle({ ...msg, item_list: [] }), false);
  assert.equal(shouldHandle({ ...msg, from_user_id: "" }), false);
});

test("textParts collects text and voice transcripts", () => {
  assert.deepEqual(
    textParts([
      { type: 1, text_item: { text: "hello" } },
      { type: 3, voice_item: { text: "spoken words" } },
      { type: 2, image_item: {} },
      { type: 1, text_item: { text: "" } },
    ]),
    ["hello", "spoken words"],
  );
});

test("chunkText splits long text at newlines", () => {
  assert.deepEqual(chunkText("short", 10), ["short"]);
  assert.deepEqual(chunkText("aaaa\nbbbb\ncccc", 10), ["aaaa\nbbbb", "cccc"]);
  assert.deepEqual(chunkText("abcdefghijkl", 5), ["abcde", "fghij", "kl"]);
  assert.deepEqual(chunkText("😀".repeat(7), 3), ["😀😀😀", "😀😀😀", "😀"]);
  assert.equal(chunkText("x".repeat(9000)).length, 3);
});

test("outboundKind sniffs content before the file name", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom")]);
  assert.equal(outboundKind(png, "report.bin"), "image");
  assert.equal(outboundKind(mp4, "clip"), "video");
  assert.equal(outboundKind(Buffer.from("hello"), "photo.JPG"), "image");
  assert.equal(outboundKind(Buffer.from("hello"), "notes.txt"), "file");
  assert.equal(outboundKind(Buffer.from("%PDF-1.7"), "x.jpg"), "file");
  assert.equal(sniffExtension(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), ".jpg");
  assert.equal(sniffExtension(Buffer.from("GIF89a")), ".gif");
  assert.equal(sniffExtension(Buffer.from("plain")), "");
});

test("sanitizeFileName removes separators and control characters", () => {
  assert.equal(sanitizeFileName('a/b\\c:d"e\nf.txt'), "a_b_c_d_e_f.txt");
});

test("AES-128-ECB helpers match the WeChat CDN format", () => {
  const key = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  for (const size of [0, 1, 15, 16, 17, 31, 32]) {
    const data = Buffer.alloc(size, 7);
    const encrypted = encryptAesEcb(data, key);
    assert.equal(encrypted.length, aesEcbPaddedSize(size), `size ${size}`);
    if (size > 0) assert.deepEqual(decryptAesEcb(encrypted, key), data);
  }
  assert.deepEqual(parseAesKey(key.toString("base64")), key);
  assert.deepEqual(parseAesKey(Buffer.from(key.toString("hex")).toString("base64")), key);
  assert.throws(() => parseAesKey(Buffer.alloc(8).toString("base64")), /aes key length/);
  assert.equal(hexKeyToBase64("00112233445566778899aabbccddeeff"), key.toString("base64"));
  assert.throws(() => hexKeyToBase64("zz"), /hex/);
  assert.throws(() => decryptAesEcb(Buffer.alloc(0), key), /empty/);
});

test("pcmToWav writes a mono 16-bit header", () => {
  const wav = pcmToWav(Buffer.alloc(8), 24000);
  assert.equal(wav.length, 52);
  assert.equal(wav.toString("latin1", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(4), 44);
  assert.equal(wav.toString("latin1", 8, 12), "WAVE");
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.readUInt32LE(40), 8);
});
