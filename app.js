// Azure TTS 中转边缘函数（阿里云 ESA）
// Agent -> ESA Function -> Azure Speech REST -> MP3 stream

import { env } from "alibaba:workers";

// ─── 常量 ────────────────────────────────────────────────────────────────────

const MAX_TEXT_CHARS = 200;
const MAX_BODY_BYTES = 8192;
const TTS_HEADER_TIMEOUT_MS = 9000;
const VOICES_TIMEOUT_MS = 8000;
const VOICES_KEY = "meta_voices_v1";
const LOG_MAX_BYTES = 1500000;
const LOG_WRITE_TIMEOUT_MS = 800;
const LOG_READ_TIMEOUT_MS = 3000;
const DEFAULT_OUTPUT_FORMAT = "audio-48khz-192kbitrate-mono-mp3";
const USER_AGENT = "esa-azure-tts/1.0";

const LANG_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;
const SPEAKER_RE = /^[A-Za-z]{2,3}-[A-Za-z0-9]{2,4}(?:-[A-Za-z0-9]+)+$/;
const LOCALE_RE = /^[A-Za-z]{2,3}-[A-Za-z0-9]{2,4}(?:-[A-Za-z0-9]{2,4})*$/;
const MP3_FORMAT_RE = /^audio-\d+khz-\d+kbitrate-mono-mp3$/;
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFFFE\uFFFF]/g;

const SPEED_PRESETS = {
  "x-slow": "-50%",
  "slow": "-25%",
  "normal": null,
  "fast": "+25%",
  "x-fast": "+50%",
};

const SPEED_PRESETS_PAYLOAD = Object.keys(SPEED_PRESETS).map(name => ({
  name,
  rate: SPEED_PRESETS[name] || "0%",
}));

// ─── 错误 ────────────────────────────────────────────────────────────────────

class HttpError extends Error {
  constructor(status, code, message, headers) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.headers = headers || {};
  }
}

function httpError(status, code, message, headers) {
  return new HttpError(status, code, message, headers);
}

// ─── 基础工具 ────────────────────────────────────────────────────────────────

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function errMessage(e) {
  if (!e) return "unknown";
  return e.message ? String(e.message) : String(e);
}

function sanitizeMessage(value) {
  return String(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function newRequestId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let out = "req_";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

function logInfo(event, fields) {
  try {
    console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...fields }));
  } catch {
    console.log(event);
  }
}

function logError(event, fields) {
  try {
    console.error(JSON.stringify({ event, ts: new Date().toISOString(), ...fields }));
  } catch {
    console.error(event);
  }
}

function normalizePath(pathname) {
  if (!pathname) return "/";
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

function localeFromSpeaker(speaker) {
  const parts = speaker.split("-");
  return parts.length >= 2 ? `${parts[0]}-${parts[1]}` : speaker;
}

function langFromLocale(locale) {
  return locale.split("-")[0].toLowerCase();
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildSsml({ speaker, locale, text, rate }) {
  const escapedText = escapeXml(text);
  const inner = rate
    ? `<prosody rate="${escapeXml(rate)}">${escapedText}</prosody>`
    : escapedText;
  return (
    "<speak version=\"1.0\" xmlns=\"http://www.w3.org/2001/10/synthesis\" " +
    `xml:lang="${escapeXml(locale)}"><voice name="${escapeXml(speaker)}">` +
    `${inner}</voice></speak>`
  );
}

// ─── 输入校验 ────────────────────────────────────────────────────────────────

function normalizeLang(input) {
  if (input == null) return null;
  if (typeof input !== "string") {
    throw httpError(400, "invalid_lang", "lang must be a string");
  }
  const lang = input.trim();
  if (lang === "") return null;
  if (!LANG_RE.test(lang)) {
    throw httpError(400, "invalid_lang", "lang must look like zh, zh-CN or fil-PH");
  }
  return lang;
}

function normalizeSpeaker(input) {
  if (typeof input !== "string") {
    throw httpError(400, "invalid_speaker", "speaker must be a string");
  }
  const speaker = input.trim();
  if (speaker === "" || speaker.length > 100 || !SPEAKER_RE.test(speaker)) {
    throw httpError(400, "invalid_speaker", "speaker must be a valid Azure voice ShortName");
  }
  return speaker;
}

function normalizeText(input) {
  if (typeof input !== "string") {
    throw httpError(400, "invalid_text", "text must be a string");
  }
  const text = input.replace(INVALID_XML_CHARS, "").trim();
  const chars = Array.from(text).length;
  if (chars === 0) {
    throw httpError(400, "invalid_text", "text must not be empty");
  }
  if (chars > MAX_TEXT_CHARS) {
    throw httpError(400, "text_too_long", `text must be at most ${MAX_TEXT_CHARS} characters`);
  }
  return { text, chars };
}

function normalizeSpeedNumber(n) {
  if (!Number.isFinite(n) || n < 0.5 || n > 2.0) {
    throw httpError(400, "invalid_speed", "speed must be between 0.5 and 2.0");
  }
  if (n === 1) return { name: "normal", rate: null };
  const pct = Math.round((n - 1) * 100);
  if (pct === 0) return { name: "normal", rate: null };
  return {
    name: String(n),
    rate: (pct > 0 ? "+" : "") + pct + "%",
  };
}

function normalizeSpeed(input) {
  if (input == null) return null;
  if (typeof input === "number") return normalizeSpeedNumber(input);
  if (typeof input !== "string") {
    throw httpError(400, "invalid_speed", "speed must be a preset name or a number");
  }
  const key = input.trim().toLowerCase();
  if (key === "") return null;
  if (Object.prototype.hasOwnProperty.call(SPEED_PRESETS, key)) {
    return { name: key, rate: SPEED_PRESETS[key] };
  }
  if (/^\d+(?:\.\d+)?$/.test(key)) {
    return normalizeSpeedNumber(Number(key));
  }
  throw httpError(400, "invalid_speed", "speed must be x-slow, slow, normal, fast, x-fast or 0.5-2.0");
}

function resolveSpeed(input) {
  if (input == null || input === "") return DEFAULT_SPEED_INFO;
  const speed = normalizeSpeed(input);
  return speed || DEFAULT_SPEED_INFO;
}

function validateLangForSpeaker(lang, locale) {
  if (!lang) return;
  const wanted = lang.toLowerCase();
  const actual = locale.toLowerCase();
  if (wanted.indexOf("-") === -1) {
    if (actual.split("-")[0] !== wanted) {
      throw httpError(400, "lang_mismatch", `speaker locale is ${locale}, which does not match lang ${lang}`);
    }
    return;
  }
  if (actual !== wanted && !actual.startsWith(wanted + "-")) {
    throw httpError(400, "lang_mismatch", `speaker locale is ${locale}, which does not match lang ${lang}`);
  }
}

// ─── HTTP 响应 ───────────────────────────────────────────────────────────────

function jsonResponse(status, payload, headers) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...(headers || {}),
    },
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": CORS_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Expose-Headers": "ETag, Retry-After, X-Request-Id, X-Azure-Request-Id, X-Voice, X-Lang, X-Speed, X-Chars, X-Cache, X-Output-Format",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function errorToResponse(err, reqId, withCors) {
  const headers = {};
  if (withCors) Object.assign(headers, corsHeaders());
  headers["X-Request-Id"] = reqId;

  if (err instanceof HttpError) {
    Object.assign(headers, err.headers || {});
    if (err.status === 401) headers["WWW-Authenticate"] = 'Bearer realm="tts"';
    return jsonResponse(err.status, {
      error: { code: err.code, message: err.message },
    }, headers);
  }

  logError("unhandled_error", {
    requestId: reqId,
    message: errMessage(err),
    stack: err && err.stack ? String(err.stack) : "",
  });
  return jsonResponse(500, {
    error: { code: "internal_error", message: "internal error" },
  }, headers);
}

function isNotModified(request, etag) {
  const value = request.headers.get("if-none-match");
  if (!value) return false;
  if (value.trim() === "*") return true;
  for (const part of value.split(",")) {
    if (part.trim() === etag) return true;
  }
  return false;
}

// ─── 上游请求 ────────────────────────────────────────────────────────────────

async function fetchWithTimeout(url, init, timeoutMs) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error("upstream timeout");
      err.code = "TIMEOUT";
      reject(err);
    }, timeoutMs);
  });

  const request = fetch(url, init);
  request.catch(() => {});

  try {
    return await Promise.race([request, timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} timeout`);
      err.code = "TIMEOUT";
      reject(err);
    }, timeoutMs);
  });

  promise.catch(() => {});

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function readErrorText(res) {
  try {
    const raw = await res.text();
    if (!raw) return "";
    let message = raw;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        if (parsed.error && typeof parsed.error === "object" && typeof parsed.error.message === "string") {
          message = parsed.error.message;
        } else if (typeof parsed.message === "string") {
          message = parsed.message;
        }
      }
    } catch {
      // 非 JSON 错误体，保留原文
    }
    return sanitizeMessage(message).slice(0, 300);
  } catch {
    return "";
  }
}

function mapAzureError(res, detail, azureRequestId, context) {
  const headers = {};
  if (azureRequestId) headers["X-Azure-Request-Id"] = azureRequestId;
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter) headers["Retry-After"] = retryAfter;

  const status = res.status;
  if (status === 429) {
    return httpError(429, "rate_limited", "Azure rate limit exceeded; retry later", headers);
  }
  if (status === 401 || status === 403) {
    return httpError(502, "upstream_auth_failed", "Azure authentication failed", headers);
  }
  if (status === 404) {
    return httpError(502, "upstream_not_found", "Azure endpoint returned 404; check AZURE_TTS_URL / AZURE_VOICES_URL", headers);
  }
  if (status === 400) {
    if (context === "tts") {
      return httpError(400, "azure_bad_request", detail || "Azure rejected the synthesis request", headers);
    }
    return httpError(502, "upstream_error", "Azure voices API rejected the request", headers);
  }
  if (status === 415) {
    return httpError(502, "upstream_error", "Azure rejected the request Content-Type", headers);
  }
  if (status === 503) {
    return httpError(503, "upstream_unavailable", "Azure is temporarily unavailable", headers);
  }
  if (status === 408 || status === 504) {
    return httpError(504, "upstream_timeout", "Azure did not respond in time", headers);
  }
  return httpError(502, "upstream_error", `Azure returned HTTP ${status}`, headers);
}

// ─── 鉴权 ────────────────────────────────────────────────────────────────────

function parseApiTokenList(value) {
  if (typeof value !== "string") return [];
  const tokens = [];
  for (const part of value.split(/[\s,]+/)) {
    const token = part.trim();
    if (token) tokens.push(token);
  }
  return tokens;
}

function timingSafeEqual(a, b) {
  const encoder = new TextEncoder();
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);

  for (let i = 0; i < len; i++) {
    const av = ab[i] === undefined ? 0 : ab[i];
    const bv = bb[i] === undefined ? 0 : bb[i];
    diff |= av ^ bv;
  }
  return diff === 0;
}

function authenticate(request) {
  const header = request.headers.get("authorization");
  if (!header) return false;

  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  if (!match) return false;

  const token = match[1].trim();
  if (token.length < 16) return false;

  let matched = false;
  for (const expected of API_TOKENS) {
    if (timingSafeEqual(token, expected)) matched = true;
  }
  return matched;
}

// ─── 配置 ────────────────────────────────────────────────────────────────────

function intEnv(value, fallback, min, max) {
  if (value == null || String(value).trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error("config: expected a numeric value");
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function parseHttpsUrl(value, name) {
  if (value == null || String(value).trim() === "") return null;
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    throw new Error(`config: invalid ${name}`);
  }
  if (url.protocol !== "https:") throw new Error(`config: ${name} must use https`);
  return url.toString();
}

function parseEndpointBase(value, region) {
  const raw = value == null || String(value).trim() === ""
    ? `https://${region}.tts.speech.microsoft.com`
    : String(value).trim().replace(/\/+$/, "");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("config: invalid AZURE_ENDPOINT");
  }
  if (url.protocol !== "https:") throw new Error("config: AZURE_ENDPOINT must use https");
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error("config: AZURE_ENDPOINT must be a base URL; use AZURE_TTS_URL / AZURE_VOICES_URL for full URLs");
  }
  if (url.search || url.hash) {
    throw new Error("config: AZURE_ENDPOINT must not include query or hash");
  }
  return `${url.protocol}//${url.host}`;
}

function defaultVoicesUrl(base) {
  const host = new URL(base).hostname.toLowerCase();
  if (host.includes(".tts.speech.") || host.startsWith("tts.speech.")) {
    return `${base}/cognitiveservices/voices/list`;
  }
  return `${base}/tts/cognitiveservices/voices/list`;
}

// 用户常把控制台里的 api.cognitive 域名当端点，TTS / voices 实际在 tts 子域
function speechBaseFromEndpoint(base) {
  const url = new URL(base);
  const match = /^([a-z0-9-]+)\.api\.cognitive\.(?:microsoft\.com|azure\.cn)$/i.exec(url.hostname);
  if (match) {
    const domain = url.hostname.toLowerCase().endsWith("azure.cn") ? "speech.azure.cn" : "speech.microsoft.com";
    return `https://${match[1].toLowerCase()}.tts.${domain}`;
  }
  return base;
}

const API_TOKENS = parseApiTokenList(env.API_TOKEN);
if (API_TOKENS.length === 0) {
  throw new Error("config: missing API_TOKEN");
}
for (const token of API_TOKENS) {
  if (token.length < 16) {
    throw new Error("config: each API_TOKEN must be at least 16 characters");
  }
}

const AZURE_SPEECH_KEY = typeof env.AZURE_SPEECH_KEY === "string" ? env.AZURE_SPEECH_KEY.trim() : "";
if (!AZURE_SPEECH_KEY) {
  throw new Error("config: missing AZURE_SPEECH_KEY");
}

const KV_NAMESPACE = (env.KV_NAMESPACE || "esa-azure-tts").trim();
if (!KV_NAMESPACE) {
  throw new Error("config: missing KV_NAMESPACE");
}

const AZURE_REGION = (env.AZURE_REGION || "eastasia").trim().toLowerCase();
if (!/^[a-z0-9]+$/.test(AZURE_REGION)) {
  throw new Error("config: invalid AZURE_REGION");
}

const AZURE_ENDPOINT = parseEndpointBase(env.AZURE_ENDPOINT, AZURE_REGION);
const SPEECH_BASE = speechBaseFromEndpoint(AZURE_ENDPOINT);
const AZURE_TTS_URL = parseHttpsUrl(env.AZURE_TTS_URL, "AZURE_TTS_URL") || `${SPEECH_BASE}/cognitiveservices/v1`;
const AZURE_VOICES_URL = parseHttpsUrl(env.AZURE_VOICES_URL, "AZURE_VOICES_URL") || defaultVoicesUrl(SPEECH_BASE);

const AZURE_OUTPUT_FORMAT = (env.AZURE_OUTPUT_FORMAT || DEFAULT_OUTPUT_FORMAT).trim();
if (!MP3_FORMAT_RE.test(AZURE_OUTPUT_FORMAT)) {
  throw new Error("config: AZURE_OUTPUT_FORMAT must be an MP3 format such as audio-48khz-192kbitrate-mono-mp3");
}

const VOICES_CACHE_TTL = intEnv(env.VOICES_CACHE_TTL, 86400, 60, 604800);
const DEFAULT_LANG = (normalizeLang(env.DEFAULT_LANG || "zh") || "zh").toLowerCase();
const DEFAULT_SPEED_INFO = normalizeSpeed(env.DEFAULT_SPEED || "normal") || normalizeSpeed("normal");
const DEFAULT_VOICE = env.DEFAULT_VOICE ? normalizeSpeaker(env.DEFAULT_VOICE) : "";
const CORS_ORIGIN = ((env.CORS_ORIGIN || "*").trim() || "*");
if (/[\r\n]/.test(CORS_ORIGIN)) {
  throw new Error("config: invalid CORS_ORIGIN");
}

// ─── 音色缓存 ────────────────────────────────────────────────────────────────

function normalizeCachedVoice(raw) {
  if (!raw || typeof raw !== "object") return null;
  const speaker = typeof raw.speaker === "string" ? raw.speaker : "";
  const locale = typeof raw.locale === "string" ? raw.locale : "";
  if (!speaker || speaker.length > 100 || !SPEAKER_RE.test(speaker)) return null;
  if (!locale || !LOCALE_RE.test(locale)) return null;

  return {
    speaker,
    name: typeof raw.name === "string" && raw.name ? raw.name : speaker,
    displayName: typeof raw.displayName === "string" && raw.displayName ? raw.displayName : speaker,
    gender: typeof raw.gender === "string" ? raw.gender : "",
    locale,
    localeName: typeof raw.localeName === "string" && raw.localeName ? raw.localeName : locale,
    lang: langFromLocale(locale),
  };
}

function isValidCache(data) {
  return !!data
    && data.v === 1
    && data.region === AZURE_REGION
    && data.endpoint === AZURE_ENDPOINT
    && data.voicesUrl === AZURE_VOICES_URL
    && typeof data.fetchedAt === "number"
    && data.fetchedAt > 0
    && data.fetchedAt <= Date.now() + 300000
    && Array.isArray(data.voices)
    && data.voices.length > 0;
}

async function readVoicesCache() {
  try {
    const kv = new EdgeKV({ namespace: KV_NAMESPACE });
    const data = await kv.get(VOICES_KEY, { type: "json" });
    if (!isValidCache(data)) return null;

    const voices = [];
    for (const raw of data.voices) {
      const voice = normalizeCachedVoice(raw);
      if (voice) voices.push(voice);
    }
    if (voices.length === 0) return null;

    return {
      v: 1,
      fetchedAt: data.fetchedAt,
      region: data.region,
      endpoint: data.endpoint,
      voicesUrl: data.voicesUrl,
      voices,
    };
  } catch (e) {
    logError("kv_read_failed", { key: VOICES_KEY, message: errMessage(e) });
    return null;
  }
}

async function writeVoicesCache(cache) {
  try {
    const kv = new EdgeKV({ namespace: KV_NAMESPACE });
    await kv.put(VOICES_KEY, JSON.stringify(cache));
    return true;
  } catch (e) {
    logError("kv_write_failed", { key: VOICES_KEY, message: errMessage(e) });
    return false;
  }
}

async function fetchVoices() {
  let res;
  try {
    res = await fetchWithTimeout(AZURE_VOICES_URL, {
      method: "GET",
      headers: {
        "Ocp-Apim-Subscription-Key": AZURE_SPEECH_KEY,
        "Accept": "application/json",
        "User-Agent": USER_AGENT,
      },
    }, VOICES_TIMEOUT_MS);
  } catch (e) {
    if (e && e.code === "TIMEOUT") {
      throw httpError(504, "upstream_timeout", "Azure voices API did not respond in time");
    }
    logError("azure_voices_fetch_failed", { message: errMessage(e) });
    throw httpError(502, "upstream_error", "failed to reach Azure voices API");
  }

  const azureRequestId = res.headers.get("x-requestid") || res.headers.get("x-request-id") || "";
  if (!res.ok) {
    const detail = await readErrorText(res);
    logError("azure_voices_error", { status: res.status, azureRequestId, detail });
    throw mapAzureError(res, detail, azureRequestId, "voices");
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw httpError(502, "upstream_error", "Azure voices API returned invalid JSON");
  }
  if (!Array.isArray(data)) {
    throw httpError(502, "upstream_error", "Azure voices API returned an unexpected payload");
  }

  const voices = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    if (item.VoiceType !== "Neural") continue;
    if (item.Status !== "GA") continue;

    const speaker = typeof item.ShortName === "string" ? item.ShortName : "";
    const locale = typeof item.Locale === "string" ? item.Locale : "";
    if (!speaker || speaker.length > 100) continue;
    if (!SPEAKER_RE.test(speaker) || !LOCALE_RE.test(locale)) continue;

    voices.push({
      speaker,
      name: typeof item.LocalName === "string" && item.LocalName
        ? item.LocalName
        : (typeof item.DisplayName === "string" && item.DisplayName ? item.DisplayName : speaker),
      displayName: typeof item.DisplayName === "string" && item.DisplayName ? item.DisplayName : speaker,
      gender: typeof item.Gender === "string" ? item.Gender : "",
      locale,
      localeName: typeof item.LocaleName === "string" && item.LocaleName ? item.LocaleName : locale,
      lang: langFromLocale(locale),
    });
  }

  if (voices.length === 0) {
    logError("azure_voices_empty", { azureRequestId });
    throw httpError(502, "upstream_error", "Azure returned no GA neural voices");
  }

  voices.sort((a, b) => compareStrings(a.locale, b.locale) || compareStrings(a.speaker, b.speaker));
  logInfo("azure_voices_fetched", { azureRequestId, count: voices.length });

  return {
    v: 1,
    fetchedAt: Date.now(),
    region: AZURE_REGION,
    endpoint: AZURE_ENDPOINT,
    voicesUrl: AZURE_VOICES_URL,
    voices,
  };
}

async function getVoices(reqId) {
  const cached = await readVoicesCache();
  if (cached && Date.now() - cached.fetchedAt < VOICES_CACHE_TTL * 1000) {
    return { cache: cached, state: "HIT" };
  }

  try {
    const fresh = await fetchVoices();
    await writeVoicesCache(fresh);
    return { cache: fresh, state: "MISS" };
  } catch (e) {
    if (cached) {
      logError("voices_refresh_failed_using_stale", { requestId: reqId, message: errMessage(e) });
      return { cache: cached, state: "STALE" };
    }
    throw e;
  }
}

// ─── 调用日志（尽力而为） ─────────────────────────────────────────────────────

function currentLogKey(now = Date.now()) {
  const d = new Date(now + 8 * 3600 * 1000);
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `log-${d.getUTCFullYear()}${month}`;
}

async function appendCallLog(speaker, chars, reqId) {
  const now = Date.now();
  const key = currentLogKey(now);
  try {
    await withTimeout((async () => {
      const kv = new EdgeKV({ namespace: KV_NAMESPACE });
      const existing = await kv.get(key, { type: "json" });
      if (existing != null && !Array.isArray(existing)) {
        throw new Error("log value is not an array");
      }
      const list = existing || [];
      list.push([now, speaker, chars]);
      const json = JSON.stringify(list);
      const bytes = new TextEncoder().encode(json).length;
      if (bytes > LOG_MAX_BYTES) {
        throw new Error(`log value would be ${bytes} bytes, over ${LOG_MAX_BYTES}`);
      }
      await kv.put(key, json);
    })(), LOG_WRITE_TIMEOUT_MS, "tts log write");
  } catch (e) {
    logError("tts_call_log_failed", { requestId: reqId, key, message: errMessage(e) });
  }
}

async function readCallLog() {
  const key = currentLogKey();
  const value = await withTimeout((async () => {
    const kv = new EdgeKV({ namespace: KV_NAMESPACE });
    return await kv.get(key, { type: "json" });
  })(), LOG_READ_TIMEOUT_MS, "log read");

  if (value == null) return { key, logs: [] };
  if (!Array.isArray(value)) {
    throw httpError(502, "log_corrupt", "current month log is not an array");
  }
  return { key, logs: value };
}

// ─── 音色响应 ────────────────────────────────────────────────────────────────

function collectLangs(voices) {
  const map = new Map();
  for (const voice of voices) {
    let entry = map.get(voice.lang);
    if (!entry) {
      entry = { code: voice.lang, locales: new Map(), speakerCount: 0 };
      map.set(voice.lang, entry);
    }
    entry.speakerCount++;
    if (!entry.locales.has(voice.locale)) {
      entry.locales.set(voice.locale, voice.localeName || voice.locale);
    }
  }

  const langs = [];
  for (const entry of map.values()) {
    const locales = [];
    for (const pair of entry.locales) {
      locales.push({ code: pair[0], name: pair[1] });
    }
    locales.sort((a, b) => compareStrings(a.code, b.code));
    langs.push({ code: entry.code, locales, speakerCount: entry.speakerCount });
  }
  langs.sort((a, b) => compareStrings(a.code, b.code));
  return langs;
}

function filterVoices(voices, langFilter) {
  if (!langFilter) return voices;
  const wanted = langFilter.toLowerCase();
  const hasRegion = wanted.indexOf("-") !== -1;
  return voices.filter(voice => {
    const locale = voice.locale.toLowerCase();
    if (hasRegion) return locale === wanted || locale.startsWith(wanted + "-");
    return voice.lang === wanted;
  });
}

function pickDefaultLang(langs, langFilter) {
  if (langs.length === 0) return null;
  const preferred = (langFilter || DEFAULT_LANG).toLowerCase();
  for (const entry of langs) {
    if (entry.code === preferred) return entry.code;
  }
  const base = preferred.split("-")[0];
  for (const entry of langs) {
    if (entry.code === base) return entry.code;
  }
  return langs[0].code;
}

function pickDefaultSpeaker(voices, langFilter) {
  if (voices.length === 0) return null;
  if (DEFAULT_VOICE) {
    for (const voice of voices) {
      if (voice.speaker === DEFAULT_VOICE) return voice.speaker;
    }
  }

  const preferred = (langFilter || DEFAULT_LANG).toLowerCase();
  for (const voice of voices) {
    if (voice.locale.toLowerCase() === preferred) return voice.speaker;
  }
  const base = preferred.split("-")[0];
  for (const voice of voices) {
    if (voice.lang === base) return voice.speaker;
  }
  return voices[0].speaker;
}

function buildVoicesPayload(cache, voices, langFilter, cacheState) {
  const langs = collectLangs(voices);
  return {
    region: AZURE_REGION,
    audio: {
      contentType: "audio/mpeg",
      format: AZURE_OUTPUT_FORMAT,
    },
    speeds: {
      presets: SPEED_PRESETS_PAYLOAD,
      numericRange: [0.5, 2.0],
      default: DEFAULT_SPEED_INFO.name,
    },
    langs,
    speakers: voices,
    defaults: {
      lang: pickDefaultLang(langs, langFilter),
      speaker: pickDefaultSpeaker(voices, langFilter),
      speed: DEFAULT_SPEED_INFO.name,
    },
    count: voices.length,
    limits: {
      maxTextChars: MAX_TEXT_CHARS,
    },
    cachedAt: new Date(cache.fetchedAt).toISOString(),
    stale: cacheState === "STALE",
  };
}

// ─── 路由处理 ────────────────────────────────────────────────────────────────

async function readJsonBody(request) {
  const lengthHeader = request.headers.get("content-length");
  if (lengthHeader) {
    const length = Number(lengthHeader);
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
      throw httpError(413, "body_too_large", `request body must be at most ${MAX_BODY_BYTES} bytes`);
    }
  }

  let raw;
  try {
    raw = await request.text();
  } catch {
    throw httpError(400, "invalid_body", "failed to read request body");
  }
  if (raw.length > MAX_BODY_BYTES) {
    throw httpError(413, "body_too_large", `request body must be at most ${MAX_BODY_BYTES} bytes`);
  }
  if (!raw) {
    throw httpError(400, "invalid_json", "request body is empty");
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw httpError(400, "invalid_json", "request body must be valid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw httpError(400, "invalid_json", "request body must be a JSON object");
  }
  return body;
}

async function handleGetTts(request, reqId) {
  const url = new URL(request.url);
  const langParam = url.searchParams.get("lang");
  const langFilter = langParam && langParam.trim() !== "" ? normalizeLang(langParam) : null;

  const { cache, state } = await getVoices(reqId);
  const allLangs = collectLangs(cache.voices);
  const voices = filterVoices(cache.voices, langFilter);

  if (voices.length === 0) {
    return jsonResponse(404, {
      error: {
        code: "unknown_lang",
        message: `no voices available for lang "${langFilter}"`,
        availableLangs: allLangs.map(entry => entry.code),
      },
    }, {
      "X-Request-Id": reqId,
      "X-Cache": state,
      ...corsHeaders(),
    });
  }

  const etag = `"v1-${cache.fetchedAt}-${langFilter ? langFilter.toLowerCase() : "all"}-${voices.length}-${AZURE_OUTPUT_FORMAT}"`;
  if (isNotModified(request, etag)) {
    return new Response(null, {
      status: 304,
      headers: {
        "ETag": etag,
        "Cache-Control": "private, max-age=300",
        "X-Request-Id": reqId,
        "X-Cache": state,
        ...corsHeaders(),
      },
    });
  }

  const payload = buildVoicesPayload(cache, voices, langFilter, state);
  logInfo("tts_voices", {
    requestId: reqId,
    cache: state,
    lang: langFilter || "all",
    count: voices.length,
  });

  return jsonResponse(200, payload, {
    "Cache-Control": "private, max-age=300",
    "ETag": etag,
    "X-Request-Id": reqId,
    "X-Cache": state,
    ...corsHeaders(),
  });
}

async function handlePostTts(request, reqId) {
  const body = await readJsonBody(request);
  const textInfo = normalizeText(body.text);

  const rawSpeaker = body.speaker;
  const speakerMissing = rawSpeaker == null
    || (typeof rawSpeaker === "string" && rawSpeaker.trim() === "");
  let speaker;
  if (speakerMissing) {
    if (!DEFAULT_VOICE) {
      throw httpError(400, "speaker_required", "speaker is required unless DEFAULT_VOICE is configured");
    }
    speaker = DEFAULT_VOICE;
  } else {
    speaker = normalizeSpeaker(rawSpeaker);
  }

  const lang = normalizeLang(body.lang == null ? null : body.lang);
  const locale = localeFromSpeaker(speaker);
  validateLangForSpeaker(lang, locale);

  const speed = resolveSpeed(body.speed);
  const ssml = buildSsml({
    speaker,
    locale,
    text: textInfo.text,
    rate: speed.rate,
  });

  const startedAt = Date.now();
  let upstream;
  try {
    upstream = await fetchWithTimeout(AZURE_TTS_URL, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": AZURE_SPEECH_KEY,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": AZURE_OUTPUT_FORMAT,
        "User-Agent": USER_AGENT,
      },
      body: ssml,
    }, TTS_HEADER_TIMEOUT_MS);
  } catch (e) {
    if (e && e.code === "TIMEOUT") {
      throw httpError(504, "upstream_timeout", "Azure TTS did not respond in time");
    }
    logError("azure_tts_fetch_failed", { requestId: reqId, message: errMessage(e) });
    throw httpError(502, "upstream_error", "failed to reach Azure TTS");
  }

  const azureRequestId = upstream.headers.get("x-requestid") || upstream.headers.get("x-request-id") || "";
  if (!upstream.ok) {
    const detail = await readErrorText(upstream);
    logError("azure_tts_error", {
      requestId: reqId,
      status: upstream.status,
      azureRequestId,
      chars: textInfo.chars,
      detail,
    });
    throw mapAzureError(upstream, detail, azureRequestId, "tts");
  }

  const contentType = (upstream.headers.get("content-type") || "").toLowerCase();
  if (contentType && !contentType.startsWith("audio/") && !contentType.startsWith("application/octet-stream")) {
    const detail = await readErrorText(upstream);
    logError("azure_tts_non_audio", {
      requestId: reqId,
      azureRequestId,
      contentType,
      detail,
    });
    throw httpError(502, "upstream_error", "Azure TTS returned a non-audio response");
  }
  if (!upstream.body) {
    throw httpError(502, "upstream_error", "Azure TTS returned an empty response");
  }

  const ttfbMs = Date.now() - startedAt;
  await appendCallLog(speaker, textInfo.chars, reqId);

  logInfo("tts_ok", {
    requestId: reqId,
    azureRequestId,
    speaker,
    locale,
    speed: speed.name,
    chars: textInfo.chars,
    ttfbMs,
  });

  const headers = {
    "Content-Type": "audio/mpeg",
    "Cache-Control": "no-store",
    "X-Request-Id": reqId,
    "X-Voice": speaker,
    "X-Lang": locale,
    "X-Speed": speed.name,
    "X-Chars": String(textInfo.chars),
    "X-Output-Format": AZURE_OUTPUT_FORMAT,
    ...corsHeaders(),
  };
  if (azureRequestId) headers["X-Azure-Request-Id"] = azureRequestId;

  return new Response(upstream.body, {
    status: 200,
    headers,
  });
}

function handleOptions(reqId) {
  return new Response(null, {
    status: 204,
    headers: {
      "X-Request-Id": reqId,
      ...corsHeaders(),
    },
  });
}

function handleHealth(request, reqId) {
  if (request.method !== "GET") {
    return jsonResponse(405, {
      error: { code: "method_not_allowed", message: "use GET" },
    }, {
      "Allow": "GET",
      "X-Request-Id": reqId,
    });
  }
  return jsonResponse(200, {
    ok: true,
    service: "esa-azure-tts",
    time: new Date().toISOString(),
  }, {
    "X-Request-Id": reqId,
  });
}

async function handleStatus(request, reqId) {
  if (request.method !== "GET") {
    return jsonResponse(405, {
      error: { code: "method_not_allowed", message: "use GET" },
    }, {
      "Allow": "GET",
      "X-Request-Id": reqId,
    });
  }

  if (!authenticate(request)) {
    return jsonResponse(401, {
      error: { code: "unauthorized", message: "invalid or missing bearer token" },
    }, {
      "WWW-Authenticate": 'Bearer realm="tts"',
      "X-Request-Id": reqId,
    });
  }

  try {
    const { key, logs } = await readCallLog();
    return jsonResponse(200, {
      month: key.slice(4),
      count: logs.length,
      logs,
    }, {
      "X-Request-Id": reqId,
    });
  } catch (e) {
    const timedOut = e && e.code === "TIMEOUT";
    const isHttp = e instanceof HttpError;
    const status = isHttp ? e.status : timedOut ? 504 : 502;
    const code = isHttp ? e.code : timedOut ? "log_timeout" : "log_unavailable";
    const message = isHttp
      ? e.message
      : timedOut
        ? "reading current month log timed out"
        : "failed to read current month log";
    logError("status_log_read_failed", { requestId: reqId, message: errMessage(e) });
    return jsonResponse(status, { error: { code, message } }, {
      "X-Request-Id": reqId,
    });
  }
}

// ─── 入口 ────────────────────────────────────────────────────────────────────

export default {
  async fetch(request) {
    const reqId = newRequestId();
    const url = new URL(request.url);
    const path = normalizePath(url.pathname);
    const isTts = path === "/tts";

    try {
      if (path === "/healthz") {
        return handleHealth(request, reqId);
      }
      if (path === "/status") {
        return handleStatus(request, reqId);
      }
      if (!isTts) {
        return jsonResponse(404, {
          error: { code: "not_found", message: "not found" },
        }, {
          "X-Request-Id": reqId,
        });
      }

      const method = request.method.toUpperCase();
      if (method === "OPTIONS") {
        return handleOptions(reqId);
      }
      if (method !== "GET" && method !== "POST") {
        return jsonResponse(405, {
          error: { code: "method_not_allowed", message: "use GET or POST" },
        }, {
          "Allow": "GET, POST, OPTIONS",
          "X-Request-Id": reqId,
          ...corsHeaders(),
        });
      }

      if (!authenticate(request)) {
        return jsonResponse(401, {
          error: { code: "unauthorized", message: "invalid or missing bearer token" },
        }, {
          "WWW-Authenticate": 'Bearer realm="tts"',
          "X-Request-Id": reqId,
          ...corsHeaders(),
        });
      }

      if (method === "GET") {
        return await handleGetTts(request, reqId);
      }
      return await handlePostTts(request, reqId);
    } catch (err) {
      return errorToResponse(err, reqId, isTts);
    }
  },
};


