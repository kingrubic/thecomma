import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { readFileSync } from "node:fs";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

function envValue(name) {
  const source = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const line = source.split(/\r?\n/).find((item) => item.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).trim().replace(/^['"]|['"]$/g, "") : "";
}

function hiddenQuestion(rl, prompt) {
  if (!stdin.isTTY || !stdout.isTTY) return rl.question(prompt);
  return new Promise((resolve) => {
    const onData = (chunk) => {
      const value = chunk.toString();
      if (value.includes("\n") || value.includes("\r")) {
        stdin.setRawMode(false);
        stdin.off("data", onData);
        stdout.write("\n");
        resolve(value.replace(/[\r\n]/g, ""));
      }
    };
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

const convexUrl = process.env.THECOMMA_CONVEX_URL || process.env.CONVEX_URL || envValue("CONVEX_URL") || "http://127.0.0.1:3240";
const convex = new ConvexHttpClient(convexUrl);
const rl = createInterface({ input: stdin, output: stdout });

try {
  const username = (process.env.THECOMMA_ADMIN_USERNAME || await rl.question("Tên đăng nhập [thecomma-editor]: ") || "thecomma-editor").trim().toLowerCase();
  const password = process.env.THECOMMA_ADMIN_PASSWORD || await hiddenQuestion(rl, "Mật khẩu (tối thiểu 8 ký tự, không hiển thị): ");
  const name = (process.env.THECOMMA_ADMIN_NAME || await rl.question("Tên hiển thị [The Comma Editor]: ") || "The Comma Editor").trim();
  if (!password || password.length < 8) throw new Error("Mật khẩu phải có ít nhất 8 ký tự.");
  const result = await convex.mutation(api.adminAuth.seedDefaultAdmin, { username, password, name });
  if (result.created) console.log(`Đã tạo tài khoản biên tập chung: ${result.username}`);
  else console.log(`Tài khoản đã tồn tại: ${result.username}; không ghi đè.`);
} catch (error) {
  console.error(error?.message || "Không thể tạo tài khoản.");
  process.exitCode = 1;
} finally {
  rl.close();
}
