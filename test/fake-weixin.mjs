import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createServer } from "node:http";

export const TOKEN = "bot-token-secret-1";

export function encrypt(data, key) {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

export function decrypt(data, key) {
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

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

export async function startFakeWeixin({ updates = [], qrStatuses = [], handlers = {} } = {}) {
  const calls = waitList();
  const uploads = new Map();
  const files = new Map();
  const pendingUpdates = [...updates];
  const statuses = [...qrStatuses];
  let qrCount = 0;
  let base = "";
  let parked = [];

  const json = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, "http://localhost");
    let body;
    if ((req.headers["content-type"] ?? "").includes("json")) {
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {}
    }
    const call = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body, raw };
    calls.add(call);
    const custom = handlers[url.pathname];
    if (custom && (await custom(req, res, call)) !== false) return;

    switch (url.pathname) {
      case "/ilink/bot/getupdates": {
        const next = pendingUpdates.shift();
        if (next) return json(res, 200, next);
        parked.push(res);
        req.on("close", () => (parked = parked.filter((r) => r !== res)));
        return;
      }
      case "/ilink/bot/sendmessage":
        return json(res, 200, `{"ret":0,"message_id":9007199254740993123}`);
      case "/ilink/bot/getuploadurl": {
        const param = `up-${uploads.size + 1}`;
        uploads.set(param, body);
        return json(res, 200, { ret: 0, upload_param: param });
      }
      case "/ilink/bot/getconfig":
        return json(res, 200, { ret: 0, typing_ticket: "ticket-1" });
      case "/ilink/bot/sendtyping":
        return json(res, 200, { ret: 0 });
      case "/cdn/upload": {
        const param = url.searchParams.get("encrypted_query_param");
        const request = uploads.get(param);
        if (!request) return json(res, 400, { error: "unknown upload" });
        const download = `dl-${files.size + 1}`;
        files.set(download, { request, ciphertext: raw });
        res.writeHead(200, { "x-encrypted-param": download });
        return res.end();
      }
      case "/cdn/download": {
        const file = files.get(url.searchParams.get("encrypted_query_param"));
        if (!file) return json(res, 404, {});
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        return res.end(file.ciphertext);
      }
      case "/ilink/bot/get_bot_qrcode":
        qrCount++;
        return json(res, 200, { qrcode: `qr-${qrCount}`, qrcode_img_content: `https://liteapp.example/q/${qrCount}`, ret: 0 });
      case "/ilink/bot/get_qrcode_status": {
        const next = statuses.shift() ?? { status: "wait" };
        return json(res, 200, next);
      }
    }
    json(res, 404, { error: "not found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  return {
    url: base,
    cdnUrl: `${base}/cdn`,
    calls,
    files,
    pushUpdate(update) {
      const res = parked.shift();
      if (res) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(typeof update === "string" ? update : JSON.stringify(update));
      } else {
        pendingUpdates.push(update);
      }
    },
    addFile(param, plaintext, key = randomBytes(16)) {
      files.set(param, { ciphertext: encrypt(plaintext, key) });
      return key;
    },
    async close() {
      for (const res of parked) res.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
