import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import dgram from "node:dgram";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REG_KEY = Symbol.for("multitool.mirror.registry");
const VERSION = "0.1.16";
const APK_PATH = process.env.MULTITOOL_MIRROR_APK || fileURLToPath(new URL("../android/app/build/outputs/apk/debug/app-debug.apk", import.meta.url));
const DEFAULT_PORT = Number(process.env.MULTITOOL_MIRROR_PORT || 8799);
const DISCOVERY_PORT = Number(process.env.MULTITOOL_MIRROR_DISCOVERY_PORT || 8798);
const MAX_BODY = 16 * 1024 * 1024;
const EVENT_LIMIT = 400;
const ALLOW_PUBLIC = process.env.MULTITOOL_MIRROR_ALLOW_PUBLIC === "1";
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const FORWARD_EVENTS = new Set([
  "message.updated",
  "message.removed",
  "message.part.updated",
  "message.part.removed",
  "permission.asked",
  "permission.replied",
  "question.asked",
  "question.replied",
  "question.rejected",
  "session.created",
  "session.updated",
  "session.deleted",
  "session.status",
  "session.idle",
  "session.error",
  "session.compacted",
  "todo.updated",
  "command.executed",
  "installation.updated",
]);

export const STORE_DIR = path.join(process.env.LOCALAPPDATA || os.homedir(), "MultiTool-Mirror");
const STORE_FILE = path.join(STORE_DIR, "store.json");
const STATUS_FILE = path.join(STORE_DIR, "status.json");

function nowIso() {
  return new Date().toISOString();
}

function readStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    if (!Array.isArray(raw.devices)) raw.devices = [];
    return raw;
  } catch {
    return { code: null, devices: [] };
  }
}

function writeStore(store) {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), "utf8");
  } catch {}
}

function randomCode() {
  let out = "";
  for (let i = 0; i < 8; i += 1) {
    out += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
    if (i === 3) out += "-";
  }
  return out;
}

function normalizeCode(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function token() {
  return crypto.randomBytes(32).toString("base64url");
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function localAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const [name, list] of Object.entries(nets)) {
    for (const net of list || []) {
      if (net.family !== "IPv4" || net.internal) continue;
      out.push({ name, address: net.address });
    }
  }
  const preferred = out.filter((item) => /^192\.168\./.test(item.address));
  const other = out.filter((item) => !/^192\.168\./.test(item.address));
  return [...preferred, ...other];
}

function isPrivateAddress(address) {
  const value = String(address || "").replace(/^::ffff:/, "");
  if (value === "::1" || value === "127.0.0.1") return true;
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
  if (parts[0] === 10) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  return false;
}

function trimDeep(value, limit = 20000, depth = 0) {
  if (depth > 8) return null;
  if (typeof value === "string") return value.length > limit ? `${value.slice(0, limit)}…` : value;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => trimDeep(item, limit, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = trimDeep(item, limit, depth + 1);
  return out;
}

function recordRequest(reg, entry) {
  reg.requests.push(entry);
  if (reg.requests.length > 30) reg.requests.splice(0, reg.requests.length - 30);
}

function registry() {
  let reg = globalThis[REG_KEY];
  if (!reg) {
    reg = {
      version: VERSION,
      starting: false,
      server: null,
      discovery: null,
      port: DEFAULT_PORT,
      startedAt: null,
      instances: new Map(),
      sessionOwner: new Map(),
      sessions: new Map(),
      permissions: new Map(),
      questions: new Map(),
      statuses: new Map(),
      requests: [],
      subscribers: new Set(),
      events: [],
      seq: 0,
      seen: new Map(),
      lastError: null,
    };
    globalThis[REG_KEY] = reg;
  }
  return reg;
}

function publish(reg, type, data, sessionID) {
  reg.seq += 1;
  const event = { seq: reg.seq, at: nowIso(), type, sessionID: sessionID ?? null, data: data ?? null };
  reg.events.push(event);
  if (reg.events.length > EVENT_LIMIT) reg.events.splice(0, reg.events.length - EVENT_LIMIT);
  const payload = `id: ${event.seq}\ndata: ${JSON.stringify(trimDeep(event))}\n\n`;
  for (const res of reg.subscribers) {
    try {
      res.write(payload);
    } catch {
      reg.subscribers.delete(res);
    }
  }
  return event;
}

function dedupe(reg, raw) {
  const key = `${raw?.type || "?"}:${JSON.stringify(raw?.properties ?? null)}`;
  const hash = crypto.createHash("sha1").update(key).digest("hex");
  const last = reg.seen.get(hash);
  const stamp = Date.now();
  if (last && stamp - last < 4000) return false;
  reg.seen.set(hash, stamp);
  if (reg.seen.size > 800) {
    for (const [oldHash, at] of reg.seen) {
      if (stamp - at > 30000) reg.seen.delete(oldHash);
    }
  }
  return true;
}

function statusSnapshot(reg, store) {
  return {
    version: reg.version,
    startedAt: reg.startedAt,
    port: reg.port,
    code: store.code,
    paired: store.devices.length,
    devices: store.devices.map((device) => ({ id: device.id, name: device.name, createdAt: device.createdAt, lastSeen: device.lastSeen })),
    instances: [...reg.instances.values()].map((item) => ({ directory: item.directory, project: item.project })),
    sessions: reg.sessions.size,
    questions: reg.questions.size,
    recent: reg.requests.slice(-12),
    urls: localAddresses().map((item) => `http://${item.address}:${reg.port}`),
    addresses: localAddresses(),
    lastError: reg.lastError,
  };
}

function writeStatus(reg, store) {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(STATUS_FILE, JSON.stringify(statusSnapshot(reg, store), null, 2), "utf8");
  } catch {}
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

function visibleMessages(items) {
  return items.map((item) => ({
    ...item,
    parts: (Array.isArray(item?.parts) ? item.parts : []).filter(
      (part) => part?.type === "text" && String(part.text ?? "").trim().length > 0
    ),
  }));
}

function currentCode(store) {
  if (!store.code) {
    store.code = randomCode();
    writeStore(store);
  }
  return store.code;
}

function deviceByToken(store, value) {
  if (!value) return null;
  return store.devices.find((device) => safeEqual(device.token, value)) || null;
}

function rawClientFor(reg, sessionID) {
  const instance = instanceFor(reg, sessionID);
  if (instance?.raw) return instance.raw;
  for (const item of reg.instances.values()) {
    if (item.raw) return item.raw;
  }
  return null;
}

async function pullEngineState(reg) {
  const raw = rawClientFor(reg, null);
  if (!raw) return;
  const pick = (response) => {
    const data = response?.data;
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.permissions)) return data.permissions;
    if (Array.isArray(data?.questions)) return data.questions;
    return [];
  };
  try {
    const response = await raw.get({ url: "/permission" });
    if (response?.error) {
      reg.lastError = `${nowIso()} pull permissions: статус ${response?.response?.status} ${JSON.stringify(response.error).slice(0, 200)}`;
    }
    for (const item of pick(response)) {
      const permission = normalizePermission(item);
      if (!permission || reg.permissions.has(permission.id)) continue;
      reg.permissions.set(permission.id, permission);
      publish(reg, "permission.updated", permission, permission.sessionID);
    }
  } catch (error) {
    reg.lastError = `${nowIso()} pull permissions: ${error?.message || error}`;
  }
  try {
    const response = await raw.get({ url: "/question" });
    if (response?.error) {
      reg.lastError = `${nowIso()} pull questions: статус ${response?.response?.status} ${JSON.stringify(response.error).slice(0, 200)}`;
    }
    for (const item of pick(response)) {
      if (!item?.id || reg.questions.has(item.id)) continue;
      reg.questions.set(item.id, item);
      publish(reg, "question.asked", item, item.sessionID ?? null);
    }
  } catch (error) {
    reg.lastError = `${nowIso()} pull questions: ${error?.message || error}`;
  }
}

function clientFor(reg, sessionID) {
  const ownerId = reg.sessionOwner.get(sessionID);
  if (ownerId && reg.instances.has(ownerId)) return reg.instances.get(ownerId).client;
  const first = reg.instances.values().next();
  return first.done ? null : first.value.client;
}

function instanceFor(reg, sessionID) {
  const ownerId = reg.sessionOwner.get(sessionID);
  if (ownerId && reg.instances.has(ownerId)) return reg.instances.get(ownerId);
  const first = reg.instances.values().next();
  return first.done ? null : first.value;
}

async function collectSessions(reg) {
  const list = [];
  for (const [id, instance] of reg.instances) {
    try {
      const result = await instance.client.session.list();
      const sessions = Array.isArray(result?.data) ? result.data : [];
      for (const session of sessions) {
        reg.sessionOwner.set(session.id, id);
        reg.sessions.set(session.id, session);
        list.push({
          id: session.id,
          title: session.title,
          parentID: session.parentID ?? null,
          directory: session.directory || instance.directory,
          projectID: session.projectID ?? null,
          time: session.time ?? null,
          share: session.share ?? null,
        });
      }
    } catch (error) {
      reg.lastError = `${nowIso()} session.list: ${error?.message || error}`;
    }
  }
  list.sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
  return list;
}

function purgePermissions(reg) {
  const limit = Date.now() - 3600000;
  for (const [id, item] of reg.permissions) {
    if ((item?.time?.created ?? 0) < limit) reg.permissions.delete(id);
  }
}

function normalizePermission(request) {
  if (!request || typeof request !== "object") return null;
  const id = request.id || request.requestID;
  if (!id) return null;
  const patterns = Array.isArray(request.patterns) ? request.patterns : [];
  const kind = request.permission || request.type || "action";
  const title = request.title || [kind, patterns[0]].filter(Boolean).join(": ") || "Действие";
  return {
    id,
    sessionID: request.sessionID ?? null,
    type: kind,
    title,
    pattern: request.pattern ?? (patterns.length === 1 ? patterns[0] : undefined),
    patterns,
    always: Array.isArray(request.always) ? request.always : [],
    messageID: request.messageID ?? request.tool?.messageID ?? null,
    callID: request.callID ?? request.tool?.callID ?? null,
    metadata: request.metadata ?? {},
    time: { created: request.time?.created ?? Date.now() },
    info: request,
  };
}

const STATUS_TOOL_LINES = {
  read: "Читаю",
  list: "Смотрю папку",
  glob: "Ищу файлы",
  grep: "Ищу в файлах",
  edit: "Правлю",
  write: "Пишу",
  apply_patch: "Правлю файлы",
  bash: "Выполняю команду",
  shell: "Выполняю команду",
  websearch: "Ищу в интернете",
  webfetch: "Открываю страницу",
  skill: "Загружаю навык",
  task: "Работает помощник",
  todowrite: "Планирую",
  todoupdate: "Обновляю план",
  todoread: "Смотрю план",
};

function shortText(value, limit = 40) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

function baseName(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  return text.split(/[\\/]/).filter(Boolean).pop() || "";
}

const STATUS_SILENT = new Set(["todowrite", "todoupdate"]);
const STATUS_PATCH_TOOLS = new Set(["apply_patch", "patch"]);
const STATUS_PATH_KEYS = new Set(["filePath", "path"]);
const STATUS_TARGET_KEYS = ["description", "filePath", "path", "name", "pattern", "url", "query", "patchText"];

function firstLine(value) {
  return String(value ?? "").split(/\r?\n/)[0].trim();
}

function partialString(raw, key) {
  const head = new RegExp(`"${key}"\\s*:\\s*"`).exec(raw);
  if (!head) return "";
  let out = "";
  for (let i = head.index + head[0].length; i < raw.length; i += 1) {
    const char = raw[i];
    if (char === '"' && raw[i - 1] !== "\\") break;
    out += char;
    if (out.length > 4000) break;
  }
  try {
    return JSON.parse(`"${out.replace(/\\+$/, "")}"`);
  } catch {
    return out.replace(/\\+$/, "");
  }
}

function statusTarget(tool, raw, input) {
  if (STATUS_PATCH_TOOLS.has(tool)) {
    const text = String(input?.patchText ?? raw ?? "");
    const head = /\*\*\* (?:Add|Update) File: ([^\n]+)/.exec(text.slice(0, 4096));
    return shortText(baseName(head?.[1]), 40);
  }
  const source = input ?? null;
  for (const key of STATUS_TARGET_KEYS) {
    const value = source?.[key] ?? (raw ? partialString(raw, key) : "");
    if (typeof value !== "string" || !value.trim()) continue;
    return shortText(STATUS_PATH_KEYS.has(key) ? baseName(value) : firstLine(value), 40);
  }
  return "";
}

const STATUS_KEYWORDS = [
  [/^skill(_|$)|_skill$/, "Загружаю навык"],
  [/^websearch|^web_search|search_web/, "Ищу в интернете"],
  [/^webfetch|fetch_url|^browser/, "Открываю страницу"],
  [/(?:^|_)image_generation(_|$)|generate_image|imagegen|text2image|gigachat_image/, "Генерирую изображение"],
  [/^computer_use/, "Работаю на компьютере"],
  [/^task(_|$)|^agent$/, "Работает помощник"],
  [/mail|mailbox|imap|smtp|_letter$/, "Читаю почту"],
  [/calendar/, "Смотрю календарь"],
  [/docx|word$|_word$/, "Собираю документ"],
  [/xlsx|sheet|excel/, "Собираю таблицу"],
  [/pptx|slide/, "Собираю презентацию"],
  [/\bpdf\b|_pdf$|pdf$/, "Собираю PDF"],
];


const STATUS_COMMANDS = new Set(["bash", "shell"]);
const STATUS_VERBS = { "New-Item": "Создаю", ni: "Создаю", "Copy-Item": "Копирую", cp: "Копирую", "Move-Item": "Перемещаю", mv: "Перемещаю", "Remove-Item": "Удаляю", rm: "Удаляю", del: "Удаляю" };
const STATUS_VERB_FLAGS = new Set(["-C", "-c", "--directory", "--git-dir", "-m", "--title", "--notes-file", "--repo", "-q", "--quiet", "--console", "--filter", "--include", "-Path", "-LiteralPath", "-Destination", "-Force"]);
const STATUS_BINARIES = new Set(["git", "gh", "npm", "npx", "node", "gradle", "pwsh", "powershell", "python", "python3", "pip", "dotnet", "curl", "winget", "java", "adb", "code"]);

// Фраза из самой команды: «Выполняю команду» перед ней только мешала.
function statusCommand(input, metadata) {
  const full = String(input?.command ?? "").trim();
  if (!full) return "Выполняю команду";
  const segments = full.split(/&&|\|\||;/).map((part) => part.trim()).filter(Boolean);
  const segment = (segments[0] ?? full).replace(/^["']?[^"']*\.(ps1|cmd|bat|sh)["']?\s*;\s*/i, "");
  if (/^(?:\$[\w:]+\s*=\s*)?@["']|<<-?\s*["']?\w/.test(segment)) return "Выполняю скрипт";
  // Запуск скрипта или файла (node x.mjs, pwsh -File x.ps1, "./x.cjs; …") — тоже не код в строке статуса.
  const runsScript = /(?:^|[\s;(&|])(?:node|pwsh|powershell|python3?|bash|sh)\b[^;|&]*\.\w{1,5}\b/i.test(full) || /^["']?[^\s"']*\.\w{1,5}["']?(?:\s|;|$)/.test(segment);
  if (runsScript && segments.length > 1) return "Выполняю скрипт";
  let words = segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  for (let i = 0; i < 3 && words.length; i += 1) {
    const word = words[0];
    if (/^-{1,2}[\w-]+$/.test(word)) { words = words.slice(STATUS_VERB_FLAGS.has(word) ? 2 : 1); continue; }
    if (!/^["']/.test(word) && (/[\\/]/.test(word) || STATUS_BINARIES.has(word.toLowerCase()))) { words = words.slice(1); continue; }
    break;
  }
  const head = words[0] ?? "";
  if (STATUS_VERBS[head]) {
    const file = words.find((word) => /\.[A-Za-z0-9]{1,5}$/.test(word.replace(/["']/g, "")));
    return shortText(`${STATUS_VERBS[head]} ${file ? baseName(file) : "файл"}`, 56);
  }
  const text = words.filter((word) => !/^-{1,2}[\w-]+$/.test(word)).join(" ").replace(/\s+/g, " ").trim();
  const title = typeof metadata?.title === "string" ? metadata.title.trim() : "";
  if (title) return shortText(title.charAt(0).toUpperCase() + title.slice(1), 48);
  if (!text) return "Выполняю команду";
  return shortText(text.charAt(0).toUpperCase() + text.slice(1), 48) + (segments.length > 1 ? "…" : "");
}

function statusFromPart(part) {
  if (!part || typeof part !== "object") return null;
  if (part.type === "tool") {
    if (STATUS_SILENT.has(part.tool)) return null;
    const state = part.state ?? {};
    const raw = state.raw ?? part.raw ?? "";
    if (state.status === "pending") {
      if (part.tool === "task") return null;
      const target = statusTarget(part.tool, raw, null);
      return shortText(target ? `Готовлю ${target}` : "Готовлю действие", 56);
    }
    if (state.status !== "running" && state.status !== "completed" && state.status !== "error") return null;
    const target = statusTarget(part.tool, raw, state.input);
    if (STATUS_COMMANDS.has(part.tool)) return shortText(statusCommand(state.input, state.metadata), 56);
    const known = STATUS_TOOL_LINES[part.tool] || STATUS_KEYWORDS.find(([re]) => re.test(part.tool))?.[1];
    const line = known || `Работаю: ${shortText(part.tool, 32)}`;
    return shortText([line, target].filter(Boolean).join(" "), 56);
  }
  if (part.type === "reasoning") return part.text ? "Думаю" : null;
  if (part.type === "text") return part.text ? "Пишу ответ" : null;
  if (part.type === "step-start") return "Думаю";
  if (part.type === "step-finish") return "Думаю";
  return null;
}


function setStatus(reg, sessionID, text) {
  if (!sessionID) return;
  const current = reg.statuses.get(sessionID) || null;
  const next = text || null;
  if (current === next) return;
  if (next) reg.statuses.set(sessionID, next);
  else reg.statuses.delete(sessionID);
  publish(reg, "mirror.status", { sessionID, text: next }, sessionID);
}

function handleEvent(reg, raw) {
  const type = raw?.type;
  if (!type || !FORWARD_EVENTS.has(type)) return;
  if (!dedupe(reg, raw)) return;
  const props = raw.properties ?? {};
  if (type === "message.part.updated") {
    const sessionID = props.part?.sessionID ?? props.sessionID ?? null;
    const phrase = statusFromPart(props.part);
    if (phrase) setStatus(reg, sessionID, phrase);
    else if (props.part?.type === "tool") setStatus(reg, sessionID, "Думаю");
  }
  if (type === "session.status") {
    const kind = props.status?.type;
    if (kind === "idle") setStatus(reg, props.sessionID, null);
    else if (kind === "retry") setStatus(reg, props.sessionID, `Повторяю (${props.status?.attempt ?? 1})`);
    else setStatus(reg, props.sessionID, "Думаю");
  }
  if (type === "session.idle") setStatus(reg, props.sessionID, null);
  if (type === "session.error") setStatus(reg, props.sessionID, null);
  if (type === "permission.asked" || type === "permission.updated") {
    const permission = normalizePermission(props);
    if (!permission) return;
    reg.permissions.set(permission.id, permission);
    setStatus(reg, permission.sessionID, "Жду разрешения");
    publish(reg, "permission.updated", permission, permission.sessionID);
    return;
  }
  if (type === "permission.replied") {
    const requestID = props.requestID || props.permissionID;
    if (requestID) reg.permissions.delete(requestID);
    setStatus(reg, props.sessionID, "Думаю");
    publish(
      reg,
      "permission.replied",
      { sessionID: props.sessionID ?? null, permissionID: requestID ?? null, response: props.reply ?? null, by: props.by ?? null },
      props.sessionID ?? null,
    );
    return;
  }
  if (type === "question.asked" && props.id) {
    reg.questions.set(props.id, props);
    setStatus(reg, props.sessionID, "Жду ответа");
  }
  if ((type === "question.replied" || type === "question.rejected") && props.requestID) {
    reg.questions.delete(props.requestID);
    setStatus(reg, props.sessionID, "Думаю");
  }
  if (type === "session.updated" && props.info?.id) {
    reg.sessions.set(props.info.id, props.info);
  }
  if (type === "session.deleted" && props.info?.id) {
    reg.sessions.delete(props.info.id);
  }
  const sessionID = props.sessionID ?? props.info?.sessionID ?? props.info?.id ?? props.part?.sessionID ?? null;
  publish(reg, type, props, sessionID);
}

function diagnosticsPage(reg, store) {
  const status = statusSnapshot(reg, store);
  const rows = status.devices
    .map((device) => `<li>${escapeHtml(device.name)} — ${escapeHtml(device.createdAt || "")}</li>`)
    .join("");
  const urls = status.urls.map((url) => `<li><code>${escapeHtml(url)}</code></li>`).join("");
  return `<!doctype html>
<html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MultiTool Mirror</title>
<style>
 body{font-family:system-ui,Segoe UI,sans-serif;margin:0;padding:24px;background:#101215;color:#e8eaed}
 h1{font-size:20px;margin:0 0 4px} h2{font-size:14px;text-transform:uppercase;letter-spacing:.08em;color:#9aa0a6;margin:24px 0 8px}
 code{background:#1b1e23;padding:2px 6px;border-radius:6px}
 .code{font-size:40px;letter-spacing:.12em;font-weight:700;background:#1b1e23;border:1px solid #2a2f37;border-radius:12px;padding:16px 20px;display:inline-block}
 ul{margin:8px 0;padding-left:20px} .muted{color:#9aa0a6;font-size:13px}
</style>
<h1>MultiTool Mirror</h1>
<div class="muted">версия ${escapeHtml(status.version)} · порт ${escapeHtml(String(status.port))}</div>
<h2>Код сопряжения</h2>
<div class="code">${escapeHtml(status.code || "————")}</div>
<h2>Адреса для телефона</h2><ul>${urls || "<li>нет локальных адресов</li>"}</ul>
<h2>Приложение для телефона</h2>
<div class="muted">Откройте на телефоне ссылку ниже и установите APK (разрешите установку из неизвестных источников):</div>
<ul>${status.urls.map((url) => `<li><a href="${escapeHtml(url)}/app/app-debug.apk">${escapeHtml(url)}/app/app-debug.apk</a></li>`).join("") || "<li>нет адресов</li>"}</ul>
<h2>Подключённые устройства</h2><ul>${rows || "<li>пока нет</li>"}</ul>
<h2>Чаты</h2>
<div class="muted">инстансов: ${status.instances.length} · известно чатов: ${status.sessions}</div>
${status.lastError ? `<h2>Последняя ошибка</h2><div class="muted">${escapeHtml(status.lastError)}</div>` : ""}
</html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

async function route(req, res, reg) {
  const store = readStore();
  const url = new URL(req.url || "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  const remote = req.socket.remoteAddress;
  if (url.pathname.startsWith("/api/")) {
    const started = nowIso();
    res.on("finish", () => {
      recordRequest(reg, {
        at: started,
        from: String(remote || "").replace(/^::ffff:/, ""),
        method: req.method,
        path: url.pathname,
        status: res.statusCode,
        note: res.mirrorNote ?? null,
      });
    });
  }
  if (!ALLOW_PUBLIC && !isPrivateAddress(remote)) {
    json(res, 403, { error: "только локальная сеть" });
    return;
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    const body = diagnosticsPage(reg, store);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
    return;
  }

  if (url.pathname === "/healthz") {
    json(res, 200, { ok: true, version: reg.version, instances: reg.instances.size });
    return;
  }

  if (url.pathname === "/app/app-debug.apk" || url.pathname === "/app") {
    let size = 0;
    try {
      size = fs.statSync(APK_PATH).size;
    } catch {
      json(res, 404, { error: "APK не собран", path: APK_PATH });
      return;
    }
    if (url.pathname === "/app") {
      res.writeHead(302, { location: "/app/app-debug.apk" });
      res.end();
      return;
    }
    res.writeHead(200, {
      "content-type": "application/vnd.android.package-archive",
      "content-length": size,
      "content-disposition": 'attachment; filename="MultiToolMirror.apk"',
      "cache-control": "no-store",
    });
    const file = fs.createReadStream(APK_PATH);
    file.on("error", () => res.end());
    file.pipe(res);
    return;
  }

  if (url.pathname === "/api/hello") {
    json(res, 200, {
      app: "MultiTool Mirror",
      version: reg.version,
      pc: os.hostname(),
      port: reg.port,
      paired: store.devices.length > 0,
      instances: reg.instances.size,
    });
    return;
  }

  if (url.pathname === "/api/pair" && req.method === "POST") {
    let body;
    try {
      body = await readBody(req);
    } catch (error) {
      json(res, 400, { error: error.message });
      return;
    }
    const expected = normalizeCode(currentCode(store));
    const given = normalizeCode(body?.code);
    if (!given || given !== expected) {
      json(res, 401, { error: "неверный код" });
      return;
    }
    const device = {
      id: crypto.randomUUID(),
      name: String(body?.name || "Телефон").slice(0, 60),
      token: token(),
      createdAt: nowIso(),
      lastSeen: nowIso(),
    };
    store.devices.push(device);
    store.code = randomCode();
    writeStore(store);
    writeStatus(reg, store);
    publish(reg, "mirror.paired", { device: { id: device.id, name: device.name } });
    json(res, 200, { token: device.token, deviceID: device.id, pc: os.hostname(), port: reg.port, version: reg.version, code: store.code });
    return;
  }

  const headerToken = (req.headers.authorization || "").replace(/^Bearer\s+/i, "") || req.headers["x-mirror-token"] || url.searchParams.get("token");
  const device = deviceByToken(store, headerToken);
  if (!device) {
    json(res, 401, { error: "нужен токен устройства" });
    return;
  }
  device.lastSeen = nowIso();
  writeStore(store);

  if (url.pathname === "/api/state" && req.method === "GET") {
    json(res, 200, statusSnapshot(reg, store));
    return;
  }

  if (url.pathname === "/api/code/rotate" && req.method === "POST") {
    store.code = randomCode();
    writeStore(store);
    writeStatus(reg, store);
    publish(reg, "mirror.code", { rotated: true });
    json(res, 200, { code: store.code });
    return;
  }

  if (url.pathname === "/api/devices" && req.method === "GET") {
    json(res, 200, { devices: statusSnapshot(reg, store).devices });
    return;
  }

  if (parts[0] === "api" && parts[1] === "devices" && parts[2] && req.method === "DELETE") {
    store.devices = store.devices.filter((item) => item.id !== parts[2]);
    writeStore(store);
    writeStatus(reg, store);
    publish(reg, "mirror.unpaired", { deviceID: parts[2] });
    json(res, 200, { ok: true });
    return;
  }

  if (url.pathname === "/api/busy" && req.method === "GET") {
    const sessionID = url.searchParams.get("session") || "";
    const owner = reg.sessionOwner.get(sessionID);
    const instance = owner && reg.instances.has(owner) ? reg.instances.get(owner) : null;
    if (!instance?.raw || !sessionID) {
      json(res, 200, { busy: null, status: reg.statuses.get(sessionID) || null });
      return;
    }
    try {
      const response = await instance.raw.get({ url: "/session/status", query: { directory: instance.directory } });
      const all = response?.data;
      const status = all && typeof all === "object" ? all[sessionID] : null;
      json(res, 200, { busy: status?.type === "busy" || status?.type === "retry", status: reg.statuses.get(sessionID) || null, engine: status?.type ?? "idle" });
    } catch (error) {
      reg.lastError = `${nowIso()} session status: ${error?.message || error}`;
      json(res, 503, { busy: null, status: reg.statuses.get(sessionID) || null });
    }
    return;
  }

  if (url.pathname === "/api/sessions" && req.method === "GET") {
    const sessions = await collectSessions(reg);
    json(res, 200, { sessions });
    return;
  }

  if (url.pathname === "/api/permissions" && req.method === "GET") {
    purgePermissions(reg);
    await pullEngineState(reg);
    json(res, 200, { permissions: [...reg.permissions.values()] });
    return;
  }

  if (url.pathname === "/api/questions" && req.method === "GET") {
    await pullEngineState(reg);
    json(res, 200, { questions: [...reg.questions.values()] });
    return;
  }

  if (parts[0] === "api" && parts[1] === "questions" && parts[2] && req.method === "POST") {
    const requestID = decodeURIComponent(parts[2]);
    const action = parts[3];
    if (action !== "reply" && action !== "reject") {
      json(res, 404, { error: "неизвестное действие", action });
      return;
    }
    let body;
    try {
      body = await readBody(req);
    } catch (error) {
      json(res, 400, { error: error.message });
      return;
    }
    const question = reg.questions.get(requestID);
    const raw = rawClientFor(reg, question?.sessionID ?? null);
    if (!raw) {
      json(res, 503, { error: "движок ещё не готов" });
      return;
    }
    const payload = action === "reply"
      ? { answers: Array.isArray(body?.answers) ? body.answers : [] }
      : { reason: String(body?.reason ?? "отклонено с телефона") };
    const response = await raw.post({
      url: `/question/{requestID}/${action}`,
      path: { requestID },
      headers: { "Content-Type": "application/json" },
      body: payload,
    });
    if (response?.error) {
      json(res, 502, { error: "движок отклонил ответ", detail: response.error });
      return;
    }
    if (action === "reject") reg.questions.delete(requestID);
    json(res, 200, { ok: true, data: response?.data ?? null });
    return;
  }

  if (url.pathname === "/api/events" && req.method === "GET") {
    const since = Number(url.searchParams.get("since") || req.headers["last-event-id"] || 0);
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 2000\n\n");
    res.write(`data: ${JSON.stringify({ seq: reg.seq, at: nowIso(), type: "mirror.ready", sessionID: null, data: { version: reg.version, pc: os.hostname() } })}\n\n`);
    for (const event of reg.events) {
      if (event.seq > since) res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    reg.subscribers.add(res);
    const keepalive = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        clearInterval(keepalive);
      }
    }, 20000);
    req.on("close", () => {
      clearInterval(keepalive);
      reg.subscribers.delete(res);
    });
    return;
  }

  if (parts[0] === "api" && parts[1] === "sessions" && parts[2]) {
    const sessionID = decodeURIComponent(parts[2]);
    const client = clientFor(reg, sessionID);
    if (!client) {
      json(res, 503, { error: "движок ещё не готов" });
      return;
    }
    const instance = instanceFor(reg, sessionID);
    const directory = instance?.directory;

    if (parts[3] === "messages" && parts.length === 4 && req.method === "GET") {
      const result = await client.session.messages({ path: { id: sessionID }, query: directory ? { directory } : undefined });
      json(res, 200, { messages: visibleMessages(result?.data ?? []) });
      return;
    }

    if (parts[3] === "messages" && parts.length === 4 && req.method === "POST") {
      let body;
      try {
        body = await readBody(req);
      } catch (error) {
        json(res, 400, { error: error.message });
        return;
      }
      const text = String(body?.text ?? "").trim();
      const incoming = Array.isArray(body?.parts)
        ? body.parts.filter((part) => part && typeof part === "object" && typeof part.type === "string")
        : [];
      const hasContent = Boolean(text) || incoming.some((part) =>
        part.type === "file" || (part.type === "text" && String(part.text ?? "").trim().length > 0));
      if (!hasContent) {
        json(res, 400, { error: "пустое сообщение" });
        return;
      }
      const parts2 = incoming.length ? incoming : [{ type: "text", text }];
      const result = await client.session.promptAsync({
        path: { id: sessionID },
        query: directory ? { directory } : undefined,
        body: { parts: parts2, agent: body?.agent, model: body?.model },
      });
      json(res, 200, { ok: true, status: result?.response?.status ?? 204 });
      return;
    }

    if (parts[3] === "abort" && req.method === "POST") {
      await client.session.abort({ path: { id: sessionID }, query: directory ? { directory } : undefined });
      json(res, 200, { ok: true });
      return;
    }

    if (parts[3] === "permission" && req.method === "POST") {
      let body;
      try {
        body = await readBody(req);
      } catch (error) {
        json(res, 400, { error: error.message });
        return;
      }
      const permissionID = String(body?.permissionID || "");
      const response = String(body?.response || "");
      if (!permissionID || !["once", "always", "reject"].includes(response)) {
        json(res, 400, { error: "нужны permissionID и response" });
        return;
      }
      const attempts = [];
      const raw = rawClientFor(reg, sessionID);
      if (raw) {
        attempts.push(() =>
          raw.post({
            url: "/permission/{requestID}/reply",
            path: { requestID: permissionID },
            headers: { "Content-Type": "application/json" },
            body: { reply: response },
          })
        );
      }
      attempts.push(() =>
        client.postSessionIdPermissionsPermissionId({
          path: { id: sessionID, permissionID },
          query: directory ? { directory } : undefined,
          body: { response },
        })
      );

      let status = null;
      let failure = null;
      for (const attempt of attempts) {
        try {
          const result = await attempt();
          const code = result?.response?.status ?? 200;
          const error = result?.error ?? null;
          if (!error && code < 400) {
            status = code;
            failure = null;
            break;
          }
          if (code === 404 || code === 405) {
            failure = null;
            continue;
          }
          failure = `статус ${code}: ${JSON.stringify(error).slice(0, 200)}`;
          break;
        } catch (error) {
          failure = error?.message || String(error);
        }
      }

      if (failure) {
        reg.lastError = `${nowIso()} permission ${permissionID}: ${failure}`;
        res.mirrorNote = `разрешение ${permissionID} → ошибка: ${failure}`;
        json(res, 502, { error: "движок не принял ответ на разрешение", detail: failure });
        return;
      }
      if (status === null) {
        res.mirrorNote = `разрешение ${permissionID} → движок не знает такой запрос`;
        json(res, 502, { error: "движок не знает такого запроса разрешения" });
        return;
      }
      reg.permissions.delete(permissionID);
      res.mirrorNote = `разрешение ${permissionID} → ${response}, движок ответил ${status}`;
      json(res, 200, { ok: true, status });
      return;
    }
  }

  json(res, 404, { error: "неизвестный маршрут", path: url.pathname });
}

function startDiscovery(reg) {
  try {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    socket.on("message", (message, rinfo) => {
      const text = message.toString("utf8").trim();
      if (!/^MULTITOOL-MIRROR/i.test(text)) return;
      const reply = Buffer.from(
        JSON.stringify({
          app: "MultiTool Mirror",
          version: reg.version,
          pc: os.hostname(),
          port: reg.port,
          http: `http://${rinfo.address}:${reg.port}`,
        }),
        "utf8",
      );
      socket.send(reply, 0, reply.length, rinfo.port, rinfo.address);
    });
    socket.on("error", (error) => {
      reg.lastError = `${nowIso()} discovery: ${error?.message || error}`;
    });
    socket.bind(DISCOVERY_PORT, () => {});
    reg.discovery = socket;
  } catch (error) {
    reg.lastError = `${nowIso()} discovery bind: ${error?.message || error}`;
  }
}

function startServer(reg, port) {
  const server = http.createServer((req, res) => {
    route(req, res, reg).catch((error) => {
      reg.lastError = `${nowIso()} route: ${error?.message || error}`;
      try {
        json(res, 500, { error: String(error?.message || error) });
      } catch {}
    });
  });
  server.on("error", (error) => {
    reg.lastError = `${nowIso()} listen: ${error?.message || error}`;
    reg.server = null;
    if (error?.code === "EADDRINUSE" && !reg.retryTimer) {
      reg.retryTimer = setTimeout(() => {
        reg.retryTimer = null;
        if (!reg.server) startServer(reg, port);
      }, 20000);
    }
  });
  server.listen(port, "0.0.0.0", () => {
    reg.server = server;
    reg.port = server.address().port;
    reg.startedAt = nowIso();
    writeStatus(reg, readStore());
  });
  return server;
}

function ensureServer(reg, port) {
  if (reg.server) return;
  if (reg.starting) return;
  reg.starting = true;
  try {
    const store = readStore();
    currentCode(store);
    startServer(reg, port || reg.port || DEFAULT_PORT);
    startDiscovery(reg);
    writeStatus(reg, store);
    if (!reg.pullTimer) {
      reg.pullTimer = setInterval(() => {
        pullEngineState(reg).catch(() => {});
      }, 5000);
      if (typeof reg.pullTimer.unref === "function") reg.pullTimer.unref();
      pullEngineState(reg).catch(() => {});
    }
  } finally {
    reg.starting = false;
  }
}

function registerInstance(reg, input, port) {
  const directory = input?.directory || process.cwd();
  const existing = reg.instances.get(directory);
  const instance = {
    id: directory,
    directory,
    project: input?.project?.name || input?.project?.worktree || "",
    client: input.client,
    raw: input?.client?._client ?? null,
    at: nowIso(),
  };
  reg.instances.set(directory, instance);
  ensureServer(reg, port);
  if (!existing) {
    writeStatus(reg, readStore());
    publish(reg, "mirror.instance", { directory, project: instance.project }, null);
  }
  return instance;
}

function hooksFor(reg) {
  return {
    event(input) {
      try {
        handleEvent(reg, input?.event);
      } catch (error) {
        reg.lastError = `${nowIso()} event: ${error?.message || error}`;
      }
    },
  };
}

export const MultiToolMirror = {
  id: "multitool-mirror",
  server: async (input, options) => {
    const reg = registry();
    try {
      const port = Number(options?.port || DEFAULT_PORT);
      reg.port = reg.port || port;
      registerInstance(reg, input, port);
    } catch (error) {
      reg.lastError = `${nowIso()} register: ${error?.message || error}`;
    }
    return hooksFor(reg);
  },
};

export default MultiToolMirror;
