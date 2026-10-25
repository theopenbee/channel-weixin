import { DEFAULT_BASE_URL, isTimeout, joinUrl } from "./api.js";
import { sleep } from "./helpers.js";

const BOT_TYPE = "3";
const STATUS_POLL_TIMEOUT_MS = 35_000;
const REQUEST_TIMEOUT_MS = 15_000;

export type Language = "en" | "zh";

const TEXT = {
  en: {
    scan: "Scan this QR code with WeChat:",
    link: "If the QR code does not show up, open this link instead:",
    waiting: "Waiting for the scan...",
    scanned: "Scanned. Confirm the login on your phone.",
    askCode: "Enter the number shown in WeChat on your phone: ",
    wrongCode: "The number does not match. Enter it again: ",
    blocked: "Too many wrong numbers. Getting a new QR code.",
    expired: (n: number, max: number) => `The QR code expired. Getting a new one (${n}/${max}).`,
    tooManyExpired: "The QR code expired too many times. Try again later.",
    alreadyBound: "This WeChat account is already connected and no new token was issued.",
    noToken: "WeChat confirmed the login but returned no token.",
    timeout: "Timed out waiting for the QR code login.",
    success: "WeChat login succeeded.",
  },
  zh: {
    scan: "请使用微信扫描以下二维码：",
    link: "二维码无法显示时，可以打开以下链接继续：",
    waiting: "等待扫码...",
    scanned: "已扫码，请在手机上确认登录。",
    askCode: "请输入手机微信上显示的数字：",
    wrongCode: "数字不匹配，请重新输入：",
    blocked: "输入错误次数过多，正在刷新二维码。",
    expired: (n: number, max: number) => `二维码已过期，正在刷新（${n}/${max}）。`,
    tooManyExpired: "二维码多次过期，请稍后重试。",
    alreadyBound: "该微信已连接过，未签发新的 token。",
    noToken: "微信已确认登录，但没有返回 token。",
    timeout: "等待扫码登录超时。",
    success: "微信登录成功。",
  },
};

export interface LoginIO {
  print(line: string): void;
  showQr(content: string): void;
  ask(prompt: string): Promise<string>;
}

export interface LoginOptions {
  language: Language;
  baseUrl?: string;
  timeoutMs?: number;
  maxQrCodes?: number;
  pollDelayMs?: number;
}

export interface LoginResult {
  token: string;
  baseUrl?: string;
  userId?: string;
  botId?: string;
}

interface QrCode {
  qrcode: string;
  qrcode_img_content: string;
}

interface QrStatus {
  status?: string;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}

async function getJson<T>(url: string, timeoutMs: number): Promise<T> {
  const res = await fetch(url, { headers: { "iLink-App-ClientVersion": "1" }, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${new URL(url).pathname} status ${res.status}`);
  return JSON.parse(text) as T;
}

export async function login(io: LoginIO, opts: LoginOptions): Promise<LoginResult> {
  const text = TEXT[opts.language];
  const base = opts.baseUrl ?? DEFAULT_BASE_URL;
  const maxQrCodes = opts.maxQrCodes ?? 3;
  const pollDelayMs = opts.pollDelayMs ?? 1_000;
  const deadline = Date.now() + (opts.timeoutMs ?? 8 * 60_000);

  const fetchQr = async (): Promise<QrCode> => {
    const qr = await getJson<QrCode>(`${joinUrl(base, "ilink/bot/get_bot_qrcode")}?bot_type=${BOT_TYPE}`, REQUEST_TIMEOUT_MS);
    if (!qr.qrcode || !qr.qrcode_img_content) throw new Error("get_bot_qrcode returned no QR code");
    io.print(text.scan);
    io.showQr(qr.qrcode_img_content);
    io.print(text.link);
    io.print(qr.qrcode_img_content);
    io.print(text.waiting);
    return qr;
  };

  let qr = await fetchQr();
  let qrCount = 1;
  let pollBase = base;
  let verifyCode: string | undefined;
  let scannedShown = false;

  const refresh = async (): Promise<void> => {
    qrCount++;
    if (qrCount > maxQrCodes) throw new Error(text.tooManyExpired);
    io.print(text.expired(qrCount, maxQrCodes));
    qr = await fetchQr();
    pollBase = base;
    verifyCode = undefined;
    scannedShown = false;
  };

  while (Date.now() < deadline) {
    let status: QrStatus;
    try {
      let url = `${joinUrl(pollBase, "ilink/bot/get_qrcode_status")}?qrcode=${encodeURIComponent(qr.qrcode)}`;
      if (verifyCode) url += `&verify_code=${encodeURIComponent(verifyCode)}`;
      status = await getJson<QrStatus>(url, STATUS_POLL_TIMEOUT_MS);
    } catch (err) {
      if (!isTimeout(err)) await sleep(pollDelayMs);
      continue;
    }
    switch (status.status) {
      case "confirmed":
        if (!status.bot_token) throw new Error(text.noToken);
        io.print(text.success);
        return {
          token: status.bot_token,
          ...(status.baseurl ? { baseUrl: status.baseurl } : {}),
          ...(status.ilink_user_id ? { userId: status.ilink_user_id } : {}),
          ...(status.ilink_bot_id ? { botId: status.ilink_bot_id } : {}),
        };
      case "scaned":
        verifyCode = undefined;
        if (!scannedShown) io.print(text.scanned);
        scannedShown = true;
        break;
      case "need_verifycode":
        verifyCode = (await io.ask(verifyCode ? text.wrongCode : text.askCode)).trim();
        continue;
      case "verify_code_blocked":
        io.print(text.blocked);
        await refresh();
        continue;
      case "expired":
        await refresh();
        continue;
      case "scaned_but_redirect":
        if (status.redirect_host) pollBase = `https://${status.redirect_host}`;
        break;
      case "binded_redirect":
        throw new Error(text.alreadyBound);
    }
    await sleep(pollDelayMs);
  }
  throw new Error(text.timeout);
}
