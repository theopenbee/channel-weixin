import { createInterface } from "node:readline/promises";

import qrcode from "qrcode-terminal";

import { errorText } from "./helpers.js";
import { login, type LoginIO } from "./login.js";

const language = process.env.OPENBEE_LANGUAGE === "zh" ? "zh" : "en";

const io: LoginIO = {
  print: (line) => process.stderr.write(line + "\n"),
  showQr: (content) => qrcode.generate(content, { small: true }, (out) => process.stderr.write(out + "\n")),
  ask: async (prompt) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      return await rl.question(prompt);
    } finally {
      rl.close();
    }
  },
};

try {
  const result = await login(io, { language });
  process.stdout.write(JSON.stringify({ token: result.token, ...(result.baseUrl ? { base_url: result.baseUrl } : {}) }) + "\n");
} catch (err) {
  process.stderr.write(errorText(err) + "\n");
  process.exitCode = 1;
}
