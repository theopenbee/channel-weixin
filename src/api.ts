import { randomBytes } from "node:crypto";

import type {
  CdnMedia,
  GetConfigResp,
  GetUpdatesResp,
  GetUploadUrlReq,
  GetUploadUrlResp,
  SendMessageResp,
  WeixinMessage,
} from "./types.js";

export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const DEFAULT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
export const STALE_TOKEN = -14;

const CHANNEL_VERSION = "1.0.2";
const DEFAULT_LONG_POLL_MS = 35_000;
const LONG_POLL_GRACE_MS = 5_000;
const API_TIMEOUT_MS = 15_000;
const LIGHT_TIMEOUT_MS = 10_000;
const CDN_TIMEOUT_MS = 120_000;
const CDN_UPLOAD_ATTEMPTS = 3;
const LOSSLESS_ID_FIELDS = new Set(["seq", "message_id", "msg_id", "svr_id"]);

export class WeixinApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: number,
  ) {
    super(message);
    this.name = "WeixinApiError";
  }
}

export class CdnFileTooLargeError extends WeixinApiError {}

export interface ApiOptions {
  token: string;
  baseUrl: string;
  cdnBaseUrl: string;
  routeTag?: number;
}

export function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
}

export function parseApiJson<T>(text: string): T {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '"') {
      out += text[i++];
      continue;
    }
    const start = i++;
    let escaped = false;
    while (i < text.length) {
      const c = text[i++];
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') break;
    }
    const token = text.slice(start, i);
    out += token;
    let j = i;
    while (/\s/.test(text[j] ?? "")) j++;
    if (text[j] !== ":") continue;
    let key: unknown;
    try {
      key = JSON.parse(token);
    } catch {
      continue;
    }
    if (typeof key !== "string" || !LOSSLESS_ID_FIELDS.has(key)) continue;
    out += text.slice(i, j + 1);
    j++;
    while (/\s/.test(text[j] ?? "")) out += text[j++];
    const numStart = j;
    if (text[j] === "-") j++;
    while (/\d/.test(text[j] ?? "")) j++;
    if (j > numStart && !(j === numStart + 1 && text[numStart] === "-")) {
      out += `"${text.slice(numStart, j)}"`;
      i = j;
    } else {
      i = numStart;
    }
  }
  return JSON.parse(out) as T;
}

function randomUin(): string {
  return Buffer.from(String(randomBytes(4).readUInt32LE(0)), "utf8").toString("base64");
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

export function isTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === "TimeoutError";
}

export class WeixinApi {
  constructor(private readonly opts: ApiOptions) {}

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      Authorization: `Bearer ${this.opts.token}`,
      "X-WECHAT-UIN": randomUin(),
    };
    if (this.opts.routeTag) headers.SKRouteTag = String(this.opts.routeTag);
    return headers;
  }

  private async post<T>(path: string, body: Record<string, unknown>, timeout: number, signal?: AbortSignal): Promise<T> {
    const res = await fetch(joinUrl(this.opts.baseUrl, path), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ ...body, base_info: { channel_version: CHANNEL_VERSION } }),
      signal: withTimeout(signal, timeout),
    });
    const text = await res.text();
    if (!res.ok) throw new WeixinApiError(`${path} status ${res.status}: ${text.slice(0, 200)}`, res.status);
    try {
      return parseApiJson<T>(text);
    } catch {
      throw new WeixinApiError(`${path} returned invalid JSON`, res.status);
    }
  }

  async getUpdates(cursor: string, longPollMs: number | undefined, signal?: AbortSignal): Promise<GetUpdatesResp> {
    const wait = longPollMs && longPollMs > 0 ? longPollMs : DEFAULT_LONG_POLL_MS;
    try {
      return await this.post<GetUpdatesResp>("ilink/bot/getupdates", { get_updates_buf: cursor }, wait + LONG_POLL_GRACE_MS, signal);
    } catch (err) {
      if (isTimeout(err)) return { ret: 0, msgs: [], get_updates_buf: cursor };
      throw err;
    }
  }

  async sendMessage(msg: WeixinMessage, signal?: AbortSignal): Promise<SendMessageResp> {
    const resp = await this.post<SendMessageResp>("ilink/bot/sendmessage", { msg }, API_TIMEOUT_MS, signal);
    if (resp.ret) throw new WeixinApiError(`sendmessage ret=${resp.ret} errmsg=${resp.errmsg ?? ""}`, undefined, resp.ret);
    return resp;
  }

  async getUploadUrl(req: GetUploadUrlReq, signal?: AbortSignal): Promise<GetUploadUrlResp> {
    const resp = await this.post<GetUploadUrlResp>("ilink/bot/getuploadurl", { ...req }, API_TIMEOUT_MS, signal);
    if (resp.ret) throw new WeixinApiError(`getuploadurl ret=${resp.ret} errmsg=${resp.errmsg ?? ""}`, undefined, resp.ret);
    return resp;
  }

  async getConfig(userId: string, contextToken: string, signal?: AbortSignal): Promise<GetConfigResp> {
    const body: Record<string, unknown> = { ilink_user_id: userId };
    if (contextToken) body.context_token = contextToken;
    return this.post<GetConfigResp>("ilink/bot/getconfig", body, LIGHT_TIMEOUT_MS, signal);
  }

  async sendTyping(userId: string, ticket: string, status: number, signal?: AbortSignal): Promise<void> {
    await this.post("ilink/bot/sendtyping", { ilink_user_id: userId, typing_ticket: ticket, status }, LIGHT_TIMEOUT_MS, signal);
  }

  async uploadToCdn(upload: GetUploadUrlResp, filekey: string, ciphertext: Uint8Array, signal?: AbortSignal): Promise<string> {
    const full = upload.upload_full_url?.trim();
    let url: string;
    if (full) {
      url = full;
    } else if (upload.upload_param) {
      url = `${joinUrl(this.opts.cdnBaseUrl, "upload")}?encrypted_query_param=${encodeURIComponent(upload.upload_param)}&filekey=${encodeURIComponent(filekey)}`;
    } else {
      throw new WeixinApiError("getuploadurl returned no upload URL");
    }
    let lastError: unknown;
    for (let attempt = 1; attempt <= CDN_UPLOAD_ATTEMPTS; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: new Uint8Array(ciphertext),
          signal: withTimeout(signal, CDN_TIMEOUT_MS),
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        lastError = err;
        continue;
      }
      const detail = res.headers.get("x-error-message") ?? `status ${res.status}`;
      await res.arrayBuffer().catch(() => undefined);
      if (res.status >= 400 && res.status < 500) throw new WeixinApiError(`cdn upload rejected: ${detail}`, res.status);
      if (res.status !== 200) {
        lastError = new WeixinApiError(`cdn upload failed: ${detail}`, res.status);
        continue;
      }
      const param = res.headers.get("x-encrypted-param");
      if (!param) throw new WeixinApiError("cdn upload response has no x-encrypted-param header", res.status);
      return param;
    }
    throw lastError instanceof Error ? lastError : new WeixinApiError("cdn upload failed");
  }

  async downloadFromCdn(media: CdnMedia, maxSize: number, signal?: AbortSignal): Promise<Buffer> {
    const full = media.full_url?.trim();
    let url: string;
    if (full) {
      url = full;
    } else if (media.encrypt_query_param) {
      url = `${joinUrl(this.opts.cdnBaseUrl, "download")}?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`;
    } else {
      throw new WeixinApiError("media has no download reference");
    }
    const res = await fetch(url, { signal: withTimeout(signal, CDN_TIMEOUT_MS) });
    if (res.status !== 200) {
      await res.arrayBuffer().catch(() => undefined);
      throw new WeixinApiError(`cdn download status ${res.status}`, res.status);
    }
    const declared = Number(res.headers.get("content-length") ?? "");
    if (declared > maxSize) {
      await res.body?.cancel();
      throw new CdnFileTooLargeError(`cdn file too large (${declared} bytes, max ${maxSize})`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    if (res.body) {
      for await (const chunk of res.body) {
        total += chunk.length;
        if (total > maxSize) throw new CdnFileTooLargeError(`cdn file too large (more than ${maxSize} bytes)`);
        chunks.push(Buffer.from(chunk));
      }
    }
    return Buffer.concat(chunks);
  }
}
