import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const base = "http://127.0.0.1:8799";
const out = process.argv[2] ?? path.join(os.tmpdir(), "gigatool", "perm-events.log");
const seconds = Number(process.argv[3] ?? 180);

const storeFile = path.join(process.env.LOCALAPPDATA, "MultiTool-Mirror", "store.json");
const store = JSON.parse(fs.readFileSync(storeFile, "utf8"));
const devices = Array.isArray(store.devices) ? store.devices : [];
devices.sort((a, b) => String(a.lastSeen ?? "").localeCompare(String(b.lastSeen ?? "")));
const token = devices.at(-1)?.token;

if (!token) {
  console.error("нет токена устройства");
  process.exit(1);
}

fs.writeFileSync(out, "");
fs.appendFileSync(out, `# ${new Date().toISOString()} подписка на ${base}/api/events на ${seconds} с\n`);

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), seconds * 1000);

function record(type, payload) {
  const stamp = new Date().toISOString();
  fs.appendFileSync(out, `${stamp} ${type} ${JSON.stringify(payload).slice(0, 400)}\n`);
}

try {
  const response = await fetch(`${base}/api/events`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
    signal: controller.signal,
  });
  fs.appendFileSync(out, `# ответ ${response.status}\n`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (!data) continue;
      let parsed = null;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      const type = parsed.type ?? "unknown";
      record(type, parsed);
    }
  }
} catch (error) {
  fs.appendFileSync(out, `# остановлено: ${error?.name ?? "ошибка"} ${error?.message ?? error}\n`);
} finally {
  clearTimeout(timer);
  fs.appendFileSync(out, `# завершено ${new Date().toISOString()}\n`);
}
