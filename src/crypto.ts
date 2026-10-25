import { createCipheriv, createDecipheriv } from "node:crypto";

export function encryptAesEcb(plaintext: Uint8Array, key: Uint8Array): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export function decryptAesEcb(ciphertext: Uint8Array, key: Uint8Array): Buffer {
  if (ciphertext.length === 0) throw new Error("ciphertext is empty");
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function aesEcbPaddedSize(size: number): number {
  return (Math.floor(size / 16) + 1) * 16;
}

export function parseAesKey(base64Key: string): Buffer {
  const decoded = Buffer.from(base64Key, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32) {
    const hex = decoded.toString("latin1");
    if (/^[0-9a-fA-F]{32}$/.test(hex)) return Buffer.from(hex, "hex");
  }
  throw new Error(`unexpected aes key length ${decoded.length} (want 16 bytes or 32 hex chars)`);
}

export function hexKeyToBase64(hexKey: string): string {
  if (!/^[0-9a-fA-F]{32}$/.test(hexKey)) throw new Error("aeskey must be 32 hex chars");
  return Buffer.from(hexKey, "hex").toString("base64");
}
