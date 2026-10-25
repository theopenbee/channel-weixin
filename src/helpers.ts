import { extname } from "node:path";

import type { SendRequest } from "@theopenbee/channel-sdk";

import { ItemType, MessageState, MessageType, type MessageItem, type WeixinMessage, type WeixinRaw } from "./types.js";

export const TEXT_CHUNK_LIMIT = 4000;

export type OutboundKind = "image" | "video" | "file";

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function idString(value: unknown): string {
  if (typeof value === "string" && /^-?\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  return "0";
}

export function messageId(msg: WeixinMessage): string {
  return `${idString(msg.seq)}:${idString(msg.message_id)}`;
}

export function encodeRaw(msg: WeixinMessage): string {
  const raw: WeixinRaw = {
    from_user_id: str(msg.from_user_id),
    to_user_id: str(msg.to_user_id),
    session_id: str(msg.session_id),
    context_token: str(msg.context_token),
  };
  return JSON.stringify(raw);
}

export function parseRaw(raw: string | undefined): WeixinRaw | undefined {
  if (!raw) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const o = value as Record<string, unknown>;
  return {
    from_user_id: str(o.from_user_id),
    to_user_id: str(o.to_user_id),
    session_id: str(o.session_id),
    context_token: str(o.context_token),
  };
}

export interface SendTarget {
  toUserId: string;
  sessionId: string;
  contextToken: string;
}

export function sendTarget(msg: SendRequest): SendTarget {
  const raw = parseRaw(msg.reply_to?.raw);
  const toUserId = msg.proactive ? msg.chat_id : raw?.from_user_id || msg.chat_id;
  return { toUserId, sessionId: raw?.session_id ?? "", contextToken: raw?.context_token ?? "" };
}

export function shouldHandle(msg: WeixinMessage): boolean {
  if (msg.message_type !== MessageType.USER || msg.message_state !== MessageState.FINISH) return false;
  if (msg.group_id || !msg.from_user_id) return false;
  return Array.isArray(msg.item_list) && msg.item_list.length > 0;
}

export function textParts(items: MessageItem[]): string[] {
  const parts: string[] = [];
  for (const item of items) {
    if (item.type === ItemType.TEXT && item.text_item?.text) parts.push(item.text_item.text);
    if (item.type === ItemType.VOICE && item.voice_item?.text) parts.push(item.voice_item.text);
  }
  return parts;
}

export function sanitizeFileName(name: string): string {
  return name.replace(/[\x00-\x1f\x7f\r\n"\\/:]+/g, "_");
}

function startsWith(data: Uint8Array, bytes: number[], offset = 0): boolean {
  if (data.length < offset + bytes.length) return false;
  return bytes.every((b, i) => data[offset + i] === b);
}

function ascii(text: string): number[] {
  return [...text].map((c) => c.charCodeAt(0));
}

export function sniffExtension(data: Uint8Array): string {
  if (startsWith(data, [0xff, 0xd8, 0xff])) return ".jpg";
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47])) return ".png";
  if (startsWith(data, ascii("GIF8"))) return ".gif";
  if (startsWith(data, ascii("RIFF")) && startsWith(data, ascii("WEBP"), 8)) return ".webp";
  if (startsWith(data, ascii("RIFF")) && startsWith(data, ascii("AVI "), 8)) return ".avi";
  if (startsWith(data, ascii("BM"))) return ".bmp";
  if (startsWith(data, ascii("ftyp"), 4)) return startsWith(data, ascii("qt  "), 8) ? ".mov" : ".mp4";
  if (startsWith(data, [0x1a, 0x45, 0xdf, 0xa3])) return ".webm";
  if (startsWith(data, ascii("%PDF"))) return ".pdf";
  return "";
}

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm", ".avi"]);

export function outboundKind(data: Uint8Array, name: string): OutboundKind {
  const ext = sniffExtension(data) || extname(name).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  return "file";
}

export function chunkText(text: string, limit = TEXT_CHUNK_LIMIT): string[] {
  const chars = [...text];
  const chunks: string[] = [];
  let start = 0;
  while (chars.length - start > limit) {
    let end = start + limit;
    const newline = chars.lastIndexOf("\n", end - 1);
    if (newline > start) end = newline;
    chunks.push(chars.slice(start, end).join(""));
    start = chars[end] === "\n" ? end + 1 : end;
  }
  if (start < chars.length) chunks.push(chars.slice(start).join(""));
  return chunks;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
