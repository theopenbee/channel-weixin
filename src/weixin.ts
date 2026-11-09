import { createHash, randomBytes } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import { ConfigError, type Attachment, type AttachmentType, type ChannelContext, type ChannelDefinition, type SendRequest } from "@theopenbee/channel-sdk";

import { CdnFileTooLargeError, DEFAULT_BASE_URL, DEFAULT_CDN_BASE_URL, STALE_TOKEN, WeixinApi, WeixinApiError } from "./api.js";
import { aesEcbPaddedSize, decryptAesEcb, encryptAesEcb, hexKeyToBase64, parseAesKey } from "./crypto.js";
import {
  chunkText,
  encodeRaw,
  errorText,
  messageId,
  outboundKind,
  sanitizeFileName,
  sendTarget,
  shouldHandle,
  sleep,
  sniffExtension,
  textParts,
  type SendTarget,
} from "./helpers.js";
import { silkToWav } from "./silk.js";
import { ItemType, MessageState, MessageType, TypingStatus, UploadMediaType, type CdnMedia, type MessageItem, type WeixinMessage } from "./types.js";

export const DEFAULT_MAX_MEDIA_SIZE = 100 * 1024 * 1024;

const CURSOR_FILE = "sync.json";
const TICKET_TTL_MS = 24 * 60 * 60 * 1000;
const TICKET_BACKOFF_MAX_MS = 60 * 60 * 1000;
const UPLOAD_URL_ATTEMPTS = 3;
const DOWNLOAD_ATTEMPTS = 3;

export interface WeixinConfig {
  token: string;
  baseUrl: string;
  cdnBaseUrl: string;
  routeTag?: number;
  maxMediaSize: number;
}

export interface Timings {
  retryDelayMs: number;
  slowRetryDelayMs: number;
  stalePauseMs: number;
  uploadRetryDelayMs: number;
  downloadRetryDelayMs: number;
}

const DEFAULT_TIMINGS: Timings = {
  retryDelayMs: 5_000,
  slowRetryDelayMs: 30_000,
  stalePauseMs: 60 * 60 * 1000,
  uploadRetryDelayMs: 2_000,
  downloadRetryDelayMs: 500,
};

function stringValue(raw: Record<string, unknown>, key: string, fallback = ""): string {
  const value = raw[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function intValue(raw: Record<string, unknown>, key: string, fallback = 0): number {
  const value = raw[key];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

export function readConfig(raw: Record<string, unknown>): WeixinConfig {
  const token = stringValue(raw, "token");
  if (!token) throw new ConfigError("token is required; log in with the QR code on the plugin page or run openbee plugin configure weixin");
  const routeTag = intValue(raw, "route_tag");
  return {
    token,
    baseUrl: stringValue(raw, "base_url", DEFAULT_BASE_URL),
    cdnBaseUrl: stringValue(raw, "cdn_base_url", DEFAULT_CDN_BASE_URL),
    ...(routeTag ? { routeTag } : {}),
    maxMediaSize: intValue(raw, "max_media_size", DEFAULT_MAX_MEDIA_SIZE),
  };
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

async function loadCursor(dataDir: string, token: string): Promise<string> {
  try {
    const saved = JSON.parse(await readFile(join(dataDir, CURSOR_FILE), "utf8"));
    if (saved?.token_hash === tokenHash(token) && typeof saved.get_updates_buf === "string") return saved.get_updates_buf;
  } catch {}
  return "";
}

async function saveCursor(dataDir: string, token: string, cursor: string): Promise<void> {
  const path = join(dataDir, CURSOR_FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ token_hash: tokenHash(token), get_updates_buf: cursor }), { mode: 0o600 });
  await rename(tmp, path);
}

function retryable(err: unknown): boolean {
  if (!(err instanceof WeixinApiError)) return true;
  if (err.code !== undefined) return false;
  return err.status === undefined || err.status >= 500;
}

function checkAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("send cancelled");
}

interface TicketState {
  ticket?: string;
  fetchedAt?: number;
  backoffMs?: number;
  retryAt?: number;
}

export function createWeixinChannel(timings: Partial<Timings> = {}): ChannelDefinition {
  const t = { ...DEFAULT_TIMINGS, ...timings };
  let cfg: WeixinConfig;
  let api: WeixinApi | undefined;
  const background = new AbortController();
  const tickets = new Map<string, TicketState>();

  const typingTicket = async (userId: string, contextToken: string): Promise<string | undefined> => {
    const state = tickets.get(userId) ?? {};
    const now = Date.now();
    if (state.ticket && state.fetchedAt && now - state.fetchedAt < TICKET_TTL_MS) return state.ticket;
    if (state.retryAt && now < state.retryAt) return undefined;
    try {
      const resp = await api!.getConfig(userId, contextToken, background.signal);
      if (resp.ret || !resp.typing_ticket) throw new Error(`getconfig ret=${resp.ret ?? 0}`);
      tickets.set(userId, { ticket: resp.typing_ticket, fetchedAt: now });
      return resp.typing_ticket;
    } catch (err) {
      const backoffMs = Math.min(state.backoffMs ? state.backoffMs * 2 : 2_000, TICKET_BACKOFF_MAX_MS);
      tickets.set(userId, { ...state, backoffMs, retryAt: now + backoffMs });
      throw err;
    }
  };

  const startTyping = async (ctx: ChannelContext, msg: WeixinMessage): Promise<void> => {
    const userId = msg.from_user_id!;
    try {
      const ticket = await typingTicket(userId, msg.context_token ?? "");
      if (ticket) await api!.sendTyping(userId, ticket, TypingStatus.TYPING, background.signal);
    } catch (err) {
      if (!background.signal.aborted) ctx.log.debug("typing indicator failed", { error: errorText(err) });
    }
  };

  const fetchFromCdn = async (ctx: ChannelContext, media: CdnMedia): Promise<Buffer> => {
    let wait = t.downloadRetryDelayMs;
    for (let attempt = 1; ; attempt++) {
      try {
        return await api!.downloadFromCdn(media, cfg.maxMediaSize, background.signal);
      } catch (err) {
        if (background.signal.aborted || attempt >= DOWNLOAD_ATTEMPTS || err instanceof CdnFileTooLargeError || !retryable(err)) throw err;
        ctx.log.warn("download media failed, retrying", { error: errorText(err) });
      }
      await sleep(wait, background.signal);
      wait *= 2;
    }
  };

  const download = async (ctx: ChannelContext, media: CdnMedia | undefined, aesKey: string | undefined): Promise<Buffer | undefined> => {
    if (!media || (!media.encrypt_query_param && !media.full_url)) return undefined;
    if (!aesKey) {
      ctx.log.warn("media has no aes key");
      return undefined;
    }
    try {
      const encrypted = await fetchFromCdn(ctx, media);
      return decryptAesEcb(encrypted, parseAesKey(aesKey));
    } catch (err) {
      if (!background.signal.aborted) ctx.log.error("download media failed", { error: errorText(err) });
      return undefined;
    }
  };

  const save = async (ctx: ChannelContext, type: AttachmentType, data: Buffer, ext: string, name?: string): Promise<Attachment> => {
    try {
      const path = await ctx.saveMedia(data, ext);
      return name ? { type, path, name } : { type, path };
    } catch (err) {
      ctx.log.error("save media failed", { error: errorText(err) });
      return name ? { type, path: "", name } : { type, path: "" };
    }
  };

  const attachment = async (ctx: ChannelContext, item: MessageItem): Promise<Attachment | undefined> => {
    switch (item.type) {
      case ItemType.IMAGE: {
        const image = item.image_item;
        if (!image) return undefined;
        let key = image.media?.aes_key;
        if (image.aeskey) {
          try {
            key = hexKeyToBase64(image.aeskey);
          } catch (err) {
            ctx.log.warn("invalid image aeskey", { error: errorText(err) });
          }
        }
        const data = await download(ctx, image.media, key);
        if (!data) return { type: "image", path: "" };
        return save(ctx, "image", data, sniffExtension(data) || ".jpg");
      }
      case ItemType.VOICE: {
        const voice = item.voice_item;
        if (!voice) return undefined;
        const data = await download(ctx, voice.media, voice.media?.aes_key);
        if (!data) return { type: "audio", path: "", name: "voice.silk" };
        try {
          return await save(ctx, "audio", await silkToWav(data, voice.sample_rate), ".wav", "voice.wav");
        } catch (err) {
          ctx.log.warn("SILK to WAV transcoding failed, keeping the SILK file", { error: errorText(err) });
          return save(ctx, "audio", data, ".silk", "voice.silk");
        }
      }
      case ItemType.FILE: {
        const file = item.file_item;
        if (!file) return undefined;
        const name = sanitizeFileName(file.file_name ?? "") || "file";
        const data = await download(ctx, file.media, file.media?.aes_key);
        if (!data) return { type: "document", path: "", name };
        return save(ctx, "document", data, extname(name) || sniffExtension(data), name);
      }
      case ItemType.VIDEO: {
        const video = item.video_item;
        if (!video) return undefined;
        const data = await download(ctx, video.media, video.media?.aes_key);
        if (!data) return { type: "video", path: "" };
        return save(ctx, "video", data, sniffExtension(data) || ".mp4");
      }
      case ItemType.TEXT:
        return undefined;
      default:
        ctx.log.warn("skipping unknown item type", { type: item.type });
        return undefined;
    }
  };

  const handleMessage = async (ctx: ChannelContext, msg: WeixinMessage): Promise<void> => {
    const items = msg.item_list ?? [];
    const text = textParts(items).join("\n");
    const attachments: Attachment[] = [];
    for (const item of items) {
      const a = await attachment(ctx, item);
      if (a) attachments.push(a);
    }
    if (!text && attachments.length === 0) return;
    const userId = msg.from_user_id!;
    ctx.dispatch({
      chat_id: userId,
      sender_id: userId,
      message_id: messageId(msg),
      ...(text ? { text } : {}),
      ...(attachments.length ? { attachments } : {}),
      raw: encodeRaw(msg),
      ...(typeof msg.create_time_ms === "number" && msg.create_time_ms > 0 ? { time: msg.create_time_ms } : {}),
    });
  };

  const poll = async (ctx: ChannelContext): Promise<void> => {
    const signal = background.signal;
    let cursor = await loadCursor(ctx.dataDir, cfg.token);
    let longPollMs: number | undefined;
    let failures = 0;
    const backoff = () => sleep(failures >= 3 ? t.slowRetryDelayMs : t.retryDelayMs, signal);
    while (!signal.aborted) {
      let resp;
      try {
        resp = await api!.getUpdates(cursor, longPollMs, signal);
      } catch (err) {
        if (signal.aborted) return;
        failures++;
        ctx.log.error("getupdates failed", { error: errorText(err), consecutive_failures: failures });
        await backoff();
        continue;
      }
      if (resp.ret === STALE_TOKEN || resp.errcode === STALE_TOKEN) {
        ctx.log.error("WeChat login expired; pausing for 60 minutes. Log in again with the QR code on the plugin page or run openbee plugin configure weixin.", {
          ret: resp.ret,
          errcode: resp.errcode,
        });
        await sleep(t.stalePauseMs, signal);
        continue;
      }
      if (resp.ret || resp.errcode) {
        failures++;
        ctx.log.warn("getupdates returned an error", { ret: resp.ret, errcode: resp.errcode, errmsg: resp.errmsg, consecutive_failures: failures });
        await backoff();
        continue;
      }
      failures = 0;
      if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0) longPollMs = resp.longpolling_timeout_ms;
      for (const msg of resp.msgs ?? []) {
        if (signal.aborted) return;
        if (!shouldHandle(msg)) continue;
        void startTyping(ctx, msg);
        try {
          await handleMessage(ctx, msg);
        } catch (err) {
          ctx.log.error("handle message failed", { error: errorText(err) });
        }
      }
      if (resp.get_updates_buf && resp.get_updates_buf !== cursor) {
        cursor = resp.get_updates_buf;
        try {
          await saveCursor(ctx.dataDir, cfg.token, cursor);
        } catch (err) {
          ctx.log.warn("could not save the sync cursor", { error: errorText(err) });
        }
      }
    }
  };

  const sendItem = async (target: SendTarget, item: MessageItem, signal: AbortSignal): Promise<string | undefined> => {
    checkAborted(signal);
    const resp = await api!.sendMessage(
      {
        from_user_id: "",
        to_user_id: target.toUserId,
        client_id: randomBytes(16).toString("hex"),
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: [item],
        ...(target.sessionId ? { session_id: target.sessionId } : {}),
        ...(target.contextToken ? { context_token: target.contextToken } : {}),
      },
      signal,
    );
    return resp.message_id ? String(resp.message_id) : undefined;
  };

  const sendMedia = async (target: SendTarget, media: { path: string; name: string }, signal: AbortSignal): Promise<string | undefined> => {
    const data = await readFile(media.path);
    if (data.length > cfg.maxMediaSize) throw new Error(`file too large: ${data.length} bytes (max ${cfg.maxMediaSize})`);
    const name = sanitizeFileName(media.name || basename(media.path)) || "file";
    const kind = outboundKind(data, name);
    const aesKey = randomBytes(16);
    const filekey = randomBytes(16).toString("hex");
    const ciphertextSize = aesEcbPaddedSize(data.length);
    const request = {
      filekey,
      media_type: kind === "image" ? UploadMediaType.IMAGE : kind === "video" ? UploadMediaType.VIDEO : UploadMediaType.FILE,
      to_user_id: target.toUserId,
      rawsize: data.length,
      rawfilemd5: createHash("md5").update(data).digest("hex"),
      filesize: ciphertextSize,
      no_need_thumb: true,
      aeskey: aesKey.toString("hex"),
    };
    let upload;
    for (let attempt = 1; ; attempt++) {
      checkAborted(signal);
      try {
        upload = await api!.getUploadUrl(request, signal);
        break;
      } catch (err) {
        if (signal.aborted || attempt >= UPLOAD_URL_ATTEMPTS || !retryable(err)) throw new Error(`getuploadurl: ${errorText(err)}`);
        await sleep(t.uploadRetryDelayMs, signal);
      }
    }
    checkAborted(signal);
    let param: string;
    try {
      param = await api!.uploadToCdn(upload, filekey, encryptAesEcb(data, aesKey), signal);
    } catch (err) {
      throw new Error(`cdn upload: ${errorText(err)}`);
    }
    const cdn: CdnMedia = {
      encrypt_query_param: param,
      aes_key: Buffer.from(aesKey.toString("hex"), "utf8").toString("base64"),
      encrypt_type: 1,
    };
    const item: MessageItem =
      kind === "image"
        ? { type: ItemType.IMAGE, image_item: { media: cdn, mid_size: ciphertextSize } }
        : kind === "video"
          ? { type: ItemType.VIDEO, video_item: { media: cdn, video_size: ciphertextSize } }
          : { type: ItemType.FILE, file_item: { media: cdn, file_name: name, len: String(data.length) } };
    return sendItem(target, item, signal);
  };

  return {
    start(ctx) {
      cfg = readConfig(ctx.config);
      api = new WeixinApi({ token: cfg.token, baseUrl: cfg.baseUrl, cdnBaseUrl: cfg.cdnBaseUrl, routeTag: cfg.routeTag });
      const loop = poll(ctx).catch((err) => {
        process.stderr.write(`fatal: ${errorText(err)}\n`);
        process.exit(1);
      });
      ctx.log.info("WeChat channel started", { base_url: cfg.baseUrl });
      return {
        stop: async () => {
          background.abort();
          await loop;
        },
      };
    },

    async send(msg: SendRequest, ctx, signal) {
      if (!api) throw new Error("weixin channel is not started");
      const target = sendTarget(msg);
      if (!target.toUserId) throw new Error(`weixin: no recipient for session ${JSON.stringify(msg.session_key)}`);
      if (!target.contextToken) ctx.log.warn("no context_token for this chat, WeChat may not deliver the message", { to_user_id: target.toUserId });
      let messageId: string | undefined;
      if (msg.content) {
        for (const chunk of chunkText(msg.content)) {
          messageId = (await sendItem(target, { type: ItemType.TEXT, text_item: { text: chunk } }, signal)) ?? messageId;
        }
      }
      if (msg.media) {
        checkAborted(signal);
        messageId = (await sendMedia(target, msg.media, signal)) ?? messageId;
      }
      return messageId ? { platform_message_id: messageId } : {};
    },
  };
}
