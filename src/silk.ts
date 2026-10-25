import { decode } from "silk-wasm";

export const DEFAULT_SILK_SAMPLE_RATE = 24_000;

export function pcmToWav(pcm: Uint8Array, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, pcm]);
}

export async function silkToWav(silk: Uint8Array, sampleRate = DEFAULT_SILK_SAMPLE_RATE): Promise<Buffer> {
  const rate = sampleRate > 0 ? sampleRate : DEFAULT_SILK_SAMPLE_RATE;
  const result = await decode(silk, rate);
  if (result.data.byteLength === 0) throw new Error("silk decode produced no audio");
  return pcmToWav(result.data, rate);
}
