/**
 * Host half of dsh-chat-with-deepseek.
 *
 * Serves the shared web app (app/) and a small Messages proxy under
 * /dsh-deepseek-chat/api. The proxy uses the DeepSeek credentials already
 * configured in DSH (API key or account token); the key never reaches the
 * renderer and is never written by this plugin.
 */
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-chat-with-deepseek';
export const inject = ['webServer'];

const APP_DIR = fileURLToPath(new URL('../app/', import.meta.url));
const PLUGIN_DIR = fileURLToPath(new URL('..', import.meta.url));
const README_PATH = join(PLUGIN_DIR, 'README.md');
const DOCS_DIR = join(PLUGIN_DIR, 'docs');
const DEFAULT_PREFIX = '/dsh-deepseek-chat';
// Single source of truth: state/readme/selfcheck all report package.json, so a
// release bump can never leave the host advertising an older version again.
const PLUGIN_VERSION = (() => {
  try {
    const value = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8')).version;
    return typeof value === 'string' && value ? value : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
const DATA_ROOT = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-deepseek-chat');
const CONFIG_PATH = join(DATA_ROOT, 'config.json');
const SESSIONS_PATH = join(DATA_ROOT, 'sessions.json');
const SESSION_FILE_VERSION = 1;
const SESSION_BODY_LIMIT = 192_000_000;
// Chat bodies carry inline base64 images; the old 2MB default rejected two
// ordinary ~1.6MB photos. The per-image cap below is 11MB base64, so 64MB
// leaves room for a realistic batch without becoming an unbounded proxy.
const CHAT_BODY_LIMIT = 64_000_000;
const EXPORT_FETCH_MAX = 512 * 1024 * 1024;
const EXPORT_FETCH_TIMEOUT_MS = 120_000;
// Sessions and per-session messages are intentionally uncapped. A real v3
// export can be tens of MB of text, so the session body ceiling is physical,
// not a product limit.
const DEFAULT_CONFIG = {
  baseUrl: 'https://api.deepseek.com/anthropic',
  provider: '',
  model: 'deepseek-flash',
  maxTokens: 8192,
};
const API_KEY_REF = 'DEEPSEEK_API_KEY';
const DEFAULT_MAX_TOKENS = 8192;
const MODEL_CACHE_MS = 60_000;
let modelCache = { at: 0, models: [], defaultSelection: null };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

function isLoopbackHost(hostWithPort) {
  const host = String(hostWithPort || '').toLowerCase();
  if (!host) return false;
  const hostname = host.startsWith('[')
    ? host.slice(0, host.indexOf(']') + 1)
    : host.split(':')[0];
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}

/** Same-origin fence: loopback host, matching Origin when present, no cross-site fetch. */
function isTrusted(req) {
  if (!isLoopbackHost(req.headers.host)) return false;
  const origin = req.headers.origin;
  if (origin) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      return false;
    }
    if (parsed.host !== req.headers.host) return false;
  }
  if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return false;
  return true;
}

function send(res, status, type, body, extraHeaders = {}) {
  const headers = {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  };
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, value) {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(value));
}

async function readJsonBody(req, limit = 2_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function isPrivateIpv4(address) {
  const parts = String(address || '').split('.');
  if (parts.length !== 4) return false;
  const nums = parts.map((part) => Number(part));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = nums;
  return a === 0 || a === 10 || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224;
}

function isPrivateAddress(address) {
  const value = String(address || '').toLowerCase();
  if (!value) return true;
  if (value === '::1' || value === '::') return true;
  if (value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80:')) return true;
  if (value.startsWith('::ffff:')) return isPrivateIpv4(value.slice(7));
  return isPrivateIpv4(value);
}

async function validateExportUrl(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new Error('链接格式不正确');
  }
  if (url.protocol !== 'https:') throw new Error('只支持 https 导出链接');
  if (url.username || url.password) throw new Error('链接不能包含账号密码');
  const host = url.hostname.toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost')
    || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('不允许访问本机或内网地址');
  }
  let addresses;
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error('无法解析导出链接的域名');
  }
  if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error('不允许访问本机或内网地址');
  }
  return url;
}

// Proxy one DeepSeek export link to the renderer without buffering it. The
// URL carries a short-lived signature, so it is never logged or persisted.
async function streamExportArchive(value, res) {
  let current = await validateExportUrl(value);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXPORT_FETCH_TIMEOUT_MS);
  let disconnected = false;
  res.on('close', () => {
    disconnected = true;
    controller.abort();
  });
  try {
    for (let hop = 0; hop < 4; hop += 1) {
      const upstream = await fetch(current, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { accept: 'application/zip, application/octet-stream;q=0.9, */*;q=0.5' },
      });
      if (upstream.status >= 300 && upstream.status < 400) {
        const location = upstream.headers.get('location');
        if (!location) throw new Error('导出链接跳转缺少地址');
        current = await validateExportUrl(new URL(location, current).toString());
        continue;
      }
      if (!upstream.ok) {
        sendJson(res, 502, { error: 'fetch_failed', message: `下载失败（HTTP ${upstream.status}）` });
        return;
      }
      const type = String(upstream.headers.get('content-type') || '').toLowerCase();
      if (type.includes('text/html') || type.includes('application/json')) {
        sendJson(res, 502, { error: 'not_an_archive', message: '链接返回的不是导出 ZIP，请确认链接未过期' });
        return;
      }
      const declared = Number(upstream.headers.get('content-length') || 0);
      if (declared > EXPORT_FETCH_MAX) {
        sendJson(res, 413, { error: 'archive_too_large', message: '导出包超过 512MB' });
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/zip',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      let total = 0;
      for await (const chunk of upstream.body) {
        if (disconnected) return;
        total += chunk.length;
        if (total > EXPORT_FETCH_MAX) {
          controller.abort();
          res.destroy();
          return;
        }
        if (!res.write(chunk)) {
          await new Promise((resolve) => {
            res.once('drain', resolve);
            res.once('close', resolve);
          });
        }
      }
      res.end();
      return;
    }
    sendJson(res, 502, { error: 'too_many_redirects', message: '导出链接跳转过多' });
  } finally {
    clearTimeout(timer);
  }
}


async function readConfig() {
  try {
    const parsed = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

async function writeConfig(config) {
  await mkdir(DATA_ROOT, { recursive: true, mode: 0o700 });
  await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Session history lives next to config.json so it survives browser cache
 * clears and is shared by every DSH window. Shape is owned by the web app;
 * the host only keeps ids/titles/messages and caps sizes.
 */
function sanitizeSession(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.id !== 'string' || !value.id) return null;
  if (typeof value.title !== 'string') return null;
  const messages = Array.isArray(value.messages) ? value.messages : [];
  return {
    ...value,
    id: value.id.slice(0, 120),
    title: value.title.slice(0, 200),
    createdAt: Number(value.createdAt) || Date.now(),
    updatedAt: Number(value.updatedAt) || Number(value.createdAt) || Date.now(),
    pinned: value.pinned === true,
    messages: messages
      .filter((message) => message && (message.role === 'user' || message.role === 'assistant')),
  };
}

async function readSessions() {
  try {
    const parsed = JSON.parse(await readFile(SESSIONS_PATH, 'utf8'));
    const list = Array.isArray(parsed?.sessions)
      ? parsed.sessions
      : Array.isArray(parsed) ? parsed : [];
    return {
      version: SESSION_FILE_VERSION,
      savedAt: Number(parsed?.savedAt) || 0,
      sessions: list.map(sanitizeSession).filter(Boolean),
    };
  } catch {
    return { version: SESSION_FILE_VERSION, savedAt: 0, sessions: [] };
  }
}

async function writeSessions(payload) {
  await mkdir(DATA_ROOT, { recursive: true, mode: 0o700 });
  const sessions = (Array.isArray(payload?.sessions) ? payload.sessions : [])
    .map(sanitizeSession)
    .filter(Boolean);
  const value = {
    version: SESSION_FILE_VERSION,
    savedAt: Number(payload?.savedAt) || Date.now(),
    sessions,
  };
  const tmp = `${SESSIONS_PATH}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(tmp, SESSIONS_PATH);
  return value;
}

function validBaseUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return value.replace(/\/+$/, '');
    if (url.protocol === 'http:' && isLoopbackHost(url.host)) return value.replace(/\/+$/, '');
    return null;
  } catch {
    return null;
  }
}

/** Messages root: append /v1 unless the configured base already ends in it. */
function messagesEndpoint(baseUrl) {
  const base = baseUrl.replace(/\/+$/, '');
  return new URL(`${new URL(base).pathname.endsWith('/v1') ? base : `${base}/v1`}/messages`);
}

/**
 * Resolve the same credential DSH uses, without exposing it to the renderer.
 * API key routes win, then a signed-in DeepSeek account. Config values are a
 * last-resort development fallback only.
 */
async function resolveAuth(ctx, config) {
  const credentials = ctx?.get?.('credentials');
  if (credentials?.resolve) {
    const hit = await credentials.resolve(API_KEY_REF);
    if (hit?.value) return { source: 'api-key', key: hit.value, headers: { 'x-api-key': hit.value } };
  }
  const account = ctx?.get?.('deepseekAccount');
  if (account?.resolveToken) {
    try {
      const token = await account.resolveToken(config.baseUrl);
      if (token) return { source: 'account', headers: { 'x-dsh-auth-token': token } };
    } catch {
      /* Account storage failures fall through to the missing-credential error. */
    }
  }
  // The credentials service is authoritative, including absence; only a
  // composition without it may read the launch environment directly.
  if (!credentials) {
    const ambient = process.env[API_KEY_REF];
    if (ambient) return { source: 'env', key: ambient, headers: { 'x-api-key': ambient } };
  }
  return null;
}

async function listDshModels(ctx) {
  const now = Date.now();
  if (now - modelCache.at < MODEL_CACHE_MS) return modelCache;
  const groups = [];
  let defaultSelection = null;
  const llm = ctx?.get?.('llm');
  const controller = ctx?.get?.('sessionController');
  if (controller?.modelCatalog) {
    try {
      const catalog = await controller.modelCatalog();
      if (Array.isArray(catalog?.groups)) groups.push(...catalog.groups);
      if (catalog?.default) defaultSelection = catalog.default;
    } catch {
      /* fall through to the LLM registry */
    }
  }
  if (groups.length === 0) {
    if (llm?.listProviders && llm?.listModels) {
      for (const provider of llm.listProviders()) {
        try {
          groups.push({ id: provider.id, name: provider.name, models: await llm.listModels(provider.id) });
        } catch {
          /* A provider without credentials contributes no models. */
        }
      }
    }
  }
  const models = [];
  const seen = new Set();
  for (const group of groups) {
    if (!group?.id) continue;
    for (const model of Array.isArray(group.models) ? group.models : []) {
      if (!model?.id) continue;
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      let inputModalities = Array.isArray(model.inputModalities) ? model.inputModalities : null;
      // The session catalog omits capability fields on some routes; the LLM
      // registry's resolveModelInfo is the authoritative source.
      if (!inputModalities && llm?.resolveModelInfo) {
        try {
          const info = await llm.resolveModelInfo(group.id, model.id);
          if (Array.isArray(info?.inputModalities)) inputModalities = info.inputModalities;
        } catch { /* unknown capability stays unknown */ }
      }
      models.push({
        id: model.id,
        name: model.name || model.id,
        description: model.description || '',
        provider: group.id,
        providerName: group.name || group.id,
        ...model.reasoning !== undefined ? { reasoning: model.reasoning } : {},
        ...Number(model.contextWindow) > 0 ? { contextWindow: Number(model.contextWindow) } : {},
        ...Number(model.maxTokens) > 0 ? { maxTokens: Number(model.maxTokens) } : {},
        ...Array.isArray(inputModalities)
          ? { inputModalities: inputModalities.filter((item) => item === 'text' || item === 'image') }
          : {},
      });
    }
  }
  if (models.length === 0) {
    models.push(
      { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', description: '', provider: 'deepseek-official', providerName: 'DeepSeek' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', description: '', provider: 'deepseek-official', providerName: 'DeepSeek' },
    );
  }
  modelCache = { at: now, models, defaultSelection };
  return modelCache;
}
async function publicState(ctx) {
  const config = await readConfig();
  const auth = await resolveAuth(ctx, config).catch(() => null);
  const catalog = await listDshModels(ctx);
  const models = catalog.models;
  const configuredSelection = models.find((model) => model.id === config.model
    && (!config.provider || model.provider === config.provider));
  const fallbackSelection = models.find((model) => model.id === catalog.defaultSelection?.model
    && (!catalog.defaultSelection?.provider || model.provider === catalog.defaultSelection.provider))
    || models[0];
  const selection = configuredSelection || fallbackSelection;
  const officialReady = Boolean(auth?.key) && models.some((model) => model.id === 'deepseek-flash');
  const imageModels = models
    .filter((model) => Array.isArray(model.inputModalities) && model.inputModalities.includes('image'))
    .map((model) => ({
      id: model.id,
      name: model.name,
      provider: model.provider,
      providerName: model.providerName,
    }));
  return {
    ok: true,
    plugin: name,
    version: PLUGIN_VERSION,
    configured: models.length > 0 || auth !== null,
    authSource: auth?.source || null,
    officialReady,
    ttsReady: officialReady,
    asrReady: officialReady,
    imageModels,
    baseUrl: config.baseUrl,
    provider: selection?.provider || config.provider || '',
    model: selection?.id || config.model,
    models,
    searchSupported: Boolean(ctx?.get?.('web')?.search),
    fetchSupported: Boolean(ctx?.get?.('web')?.fetch),
  };
}

function cleanSource(source) {
  if (!source || typeof source !== 'object' || typeof source.url !== 'string') return null;
  let url;
  try {
    url = new URL(source.url);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const text = (value, max) => typeof value === 'string' && value.trim()
    ? value.trim().slice(0, max)
    : '';
  return {
    url: url.href,
    title: text(source.title, 300),
    snippet: text(source.snippet, 800),
    summary: text(source.summary, 1200),
    publishedAt: text(source.publishedAt, 80),
  };
}

/**
 * One tiny non-streaming call that turns the first exchange into a short
 * session title. Failures are non-fatal; the client keeps its 30-char title.
 */
async function resolveModelSelection(ctx) {
  const config = await readConfig();
  const catalog = await listDshModels(ctx);
  const models = catalog.models;
  return models.find((model) => model.id === config.model
    && (!config.provider || model.provider === config.provider))
    || models.find((model) => model.id === catalog.defaultSelection?.model)
    || models[0]
    || null;
}

/**
 * Summarize older turns into a compact background paragraph. The client
 * chooses the cut point and stores the result with the session; the host only
 * runs one small model call and never stores the summary itself.
 */
function utilityReasoning(selection) {
  const efforts = selection?.reasoning?.efforts?.map((item) => item.id);
  return Array.isArray(efforts) && efforts.includes('off') ? { reasoningEffort: 'off' } : {};
}

async function handleCompress(req, res, ctx) {
  const llm = ctx?.get?.('llm');
  if (!llm?.stream) {
    sendJson(res, 501, { error: 'llm_unavailable', message: '当前 DSH 组合没有 LLM 服务' });
    return;
  }
  const body = await readJsonBody(req, 1_000_000);
  const transcript = typeof body.text === 'string' ? body.text.trim().slice(0, 200_000) : '';
  if (!transcript) {
    sendJson(res, 400, { error: 'empty_text', message: '文本为空' });
    return;
  }
  const selection = await resolveModelSelection(ctx);
  if (!selection) {
    sendJson(res, 400, { error: 'missing_model', message: 'DSH 没有可用的模型' });
    return;
  }
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  let summary = '';
  try {
    for await (const chunk of llm.stream({
      provider: selection.provider,
      model: selection.id,
      messages: [{
        role: 'user',
        content: [{
          type: 'text',
          text: `请把下面这段较早的对话压缩成一段背景摘要，供后续对话继续使用。保留：用户身份与偏好、已确认的事实与数字、做出的决定、未完成的事项；省略寒暄、重复与无关细节。不要编造。直接输出摘要正文，不超过 800 字。

${transcript}`,
        }],
      }],
      maxTokens: 2000,
      system: '你是一个对话上下文压缩器，只输出摘要正文。',
      ...utilityReasoning(selection),
      signal: controller.signal,
    })) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') summary += chunk.text;
      if (summary.length > 20_000 || chunk?.type === 'finish') break;
    }
  } catch { /* aborted or provider error */ }
  summary = summary.trim();
  if (!summary) {
    sendJson(res, 502, { error: 'compress_failed', message: '上下文压缩失败' });
    return;
  }
  sendJson(res, 200, { ok: true, summary: summary.slice(0, 8000) });
}

async function handleTitle(req, res, ctx) {
  const llm = ctx?.get?.('llm');
  if (!llm?.stream) {
    sendJson(res, 501, { error: 'llm_unavailable', message: '当前 DSH 组合没有 LLM 服务' });
    return;
  }
  const body = await readJsonBody(req, 100_000);
  const text = typeof body.text === 'string' ? body.text.trim().slice(0, 4000) : '';
  if (!text) {
    sendJson(res, 400, { error: 'empty_text', message: '文本为空' });
    return;
  }
  const selection = await resolveModelSelection(ctx);
  if (!selection) {
    sendJson(res, 400, { error: 'missing_model', message: 'DSH 没有可用的模型' });
    return;
  }
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  let title = '';
  try {
    for await (const chunk of llm.stream({
      provider: selection.provider,
      model: selection.id,
      messages: [{
        role: 'user',
        content: [{
          type: 'text',
          text: `为下面的对话起一个简短标题（不超过 12 个汉字），只输出标题本身，不要引号、句号或解释：\n\n${text}`,
        }],
      }],
      maxTokens: 256,
      system: '你是一个标题生成器，只输出标题本身。',
      ...utilityReasoning(selection),
      signal: controller.signal,
    })) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') title += chunk.text;
      if (title.length > 200 || chunk?.type === 'finish') break;
    }
  } catch { /* aborted or provider error */ }
  title = title.replace(/["'“”‘’《》\n\r]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 24);
  if (!title) {
    sendJson(res, 502, { error: 'title_failed', message: '标题生成失败' });
    return;
  }
  sendJson(res, 200, { ok: true, title });
}

function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fast mode mirrors the app: one search, snippets only. Precise mode mirrors
 * DSH/Claude Code: search, then read the top pages and hand the model their
 * text. The host owns both because the renderer has no web service.
 */
/**
 * Read-aloud via DeepSeek's application API (POST /v1/tools/tts). The public
 * endpoint requires a platform API key; DSH account tokens are not accepted.
 */
/**
 * Vision delegation: describe/OCR images with an official image-capable model
 * so text-only chat models can still "see" attachments.
 */
async function handleVision(req, res, ctx) {
  const body = await readJsonBody(req, 20_000_000);
  const images = (Array.isArray(body.images) ? body.images : [])
    .slice(0, 8)
    .map((image) => {
      const mediaType = typeof image?.mediaType === 'string' ? image.mediaType : '';
      const data = typeof image?.data === 'string' ? image.data : '';
      if (!IMAGE_MEDIA_TYPES.has(mediaType) || !data || data.length > 11_000_000) return null;
      return { mediaType, data };
    })
    .filter(Boolean);
  if (!images.length) {
    sendJson(res, 400, { error: 'empty_images', message: '没有可识别的图片' });
    return;
  }
  const config = await readConfig();
  const auth = await resolveAuth(ctx, config).catch(() => null);
  if (!auth?.key) {
    sendJson(res, 401, { error: 'missing_official_key', message: '识图需要 DeepSeek 官方 API Key' });
    return;
  }
  const model = typeof body.model === 'string' && body.model.trim()
    ? body.model.trim().slice(0, 120)
    : 'deepseek-flash';
  const question = typeof body.question === 'string' ? body.question.trim().slice(0, 4000) : '';
  const content = [{
    type: 'text',
    text: `请仔细识别下面${images.length > 1 ? '这些' : '这张'}图片的内容；如果图片里有文字，请完整提取。用简洁中文输出，供另一个模型接着回答用户问题。${question ? `
用户问题：${question}` : ''}`,
  }];
  for (const image of images) {
    content.push({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } });
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  res.on('close', abort);
  try {
    const upstream = await fetch('https://api.deepseek.com/anthropic/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': auth.key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1500,
        stream: false,
        thinking: { type: 'disabled' },
        messages: [{ role: 'user', content }],
      }),
      signal: controller.signal,
    });
    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      sendJson(res, upstream.status === 401 || upstream.status === 402 ? upstream.status : 502, {
        error: 'vision_failed',
        message: detail.slice(0, 300) || `识图失败（HTTP ${upstream.status}）`,
      });
      return;
    }
    const data = await upstream.json();
    const text = Array.isArray(data?.content)
      ? data.content.filter((block) => block?.type === 'text').map((block) => block.text || '').join('')
      : '';
    if (!text.trim()) {
      sendJson(res, 502, { error: 'vision_failed', message: '识图模型没有返回文本' });
      return;
    }
    sendJson(res, 200, { ok: true, model, text: text.trim().slice(0, 12_000) });
  } catch (error) {
    if (!res.headersSent) {
      sendJson(res, 502, {
        error: 'vision_failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    res.off('close', abort);
  }
}

async function handleTts(req, res, ctx) {
  const body = await readJsonBody(req, 200_000);
  const text = typeof body.text === 'string' ? body.text.trim().slice(0, 9500) : '';
  if (!text) {
    sendJson(res, 400, { error: 'empty_text', message: '没有可朗读的文本' });
    return;
  }
  const config = await readConfig();
  const auth = await resolveAuth(ctx, config).catch(() => null);
  if (!auth?.key) {
    sendJson(res, 401, {
      error: 'missing_tts_key',
      message: '朗读需要 DeepSeek API Key（账号登录令牌不支持语音合成）',
    });
    return;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  res.on('close', abort);
  try {
    const upstream = await fetch('https://api.deepseek.com/v1/tools/tts', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${auth.key}`,
      },
      body: JSON.stringify({
        text,
        voice_id: body.voiceId === 'tide' ? 'tide' : 'stella',
        format: 'wav',
        filter_markdown: true,
      }),
      signal: controller.signal,
    });
    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      sendJson(res, upstream.status === 401 || upstream.status === 402 ? upstream.status : 502, {
        error: 'tts_failed',
        message: detail.slice(0, 300) || `语音合成失败（HTTP ${upstream.status}）`,
      });
      return;
    }
    const audio = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(200, {
      'content-type': 'audio/wav',
      'content-length': audio.length,
      'cache-control': 'no-store',
    });
    res.end(audio);
  } catch (error) {
    if (!res.headersSent) {
      sendJson(res, 502, {
        error: 'tts_failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    res.off('close', abort);
  }
}

async function handleAsr(req, res, ctx) {
  let body;
  try {
    body = await readJsonBody(req, 16_000_000);
  } catch {
    sendJson(res, 413, { error: 'body_too_large', message: '音频请求过大' });
    return;
  }
  const rawAudio = typeof body.audio === 'string' ? body.audio.replace(/^data:[^,]*,/, '') : '';
  if (!rawAudio) {
    sendJson(res, 400, { error: 'empty_audio', message: '没有可识别的音频' });
    return;
  }
  const buffer = Buffer.from(rawAudio, 'base64');
  if (!buffer.length) {
    sendJson(res, 400, { error: 'empty_audio', message: '音频为空' });
    return;
  }
  if (buffer.length > 8 * 1024 * 1024) {
    sendJson(res, 413, { error: 'audio_too_large', message: '单段音频超过 8MB' });
    return;
  }
  const config = await readConfig();
  const auth = await resolveAuth(ctx, config).catch(() => null);
  if (!auth?.key) {
    sendJson(res, 401, {
      error: 'missing_asr_key',
      message: '语音识别需要 DeepSeek API Key（账号登录令牌不支持语音识别）',
    });
    return;
  }
  const mediaType = body.mediaType === 'audio/ogg' ? 'audio/ogg' : 'audio/wav';
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(() => controller.abort(), 600_000);
  res.on('close', abort);
  try {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mediaType }), mediaType === 'audio/ogg' ? 'audio.ogg' : 'audio.wav');
    const upstream = await fetch('https://api.deepseek.com/v1/tools/asr', {
      method: 'POST',
      headers: { authorization: `Bearer ${auth.key}` },
      body: form,
      signal: controller.signal,
    });
    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      sendJson(res, upstream.status === 401 || upstream.status === 402 || upstream.status === 413 ? upstream.status : 502, {
        error: 'asr_failed',
        message: detail.slice(0, 400) || `语音识别失败（HTTP ${upstream.status}）`,
      });
      return;
    }
    const data = await upstream.json();
    const text = typeof data?.text === 'string' ? data.text.trim() : '';
    if (!text) {
      sendJson(res, 502, { error: 'asr_empty', message: '语音识别没有返回文本' });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      text: text.slice(0, 200_000),
      durationMs: Number(data?.duration_ms) || 0,
      requestId: typeof data?.request_id === 'string' ? data.request_id : '',
    });
  } catch (error) {
    if (!res.headersSent) {
      sendJson(res, 502, {
        error: 'asr_failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    clearTimeout(timer);
    res.off('close', abort);
  }
}

async function handleSearch(req, res, ctx) {
  const web = ctx?.get?.('web');
  if (!web?.search) {
    sendJson(res, 501, { error: 'search_unavailable', message: '当前 DSH 组合没有加载 web 搜索服务' });
    return;
  }
  const body = await readJsonBody(req);
  const query = typeof body.query === 'string' ? body.query.trim().slice(0, 500) : '';
  if (!query) {
    sendJson(res, 400, { error: 'empty_query', message: '搜索关键词为空' });
    return;
  }
  const requestedMode = body.mode === 'precise' ? 'precise' : 'fast';
  const canFetch = typeof web.fetch === 'function';
  const mode = requestedMode === 'precise' && canFetch ? 'precise' : 'fast';
  const controller = new AbortController();
  const abort = () => controller.abort();
  res.on('close', abort);
  try {
    const result = await web.search({ query, maxResults: mode === 'precise' ? 10 : 8 }, controller.signal);
    const sources = Array.isArray(result?.sources)
      ? result.sources.map(cleanSource).filter(Boolean).slice(0, 10)
      : [];
    let content = typeof result?.content === 'string' ? result.content.slice(0, 4000) : '';
    const pages = [];
    if (mode === 'precise') {
      let used = 0;
      for (const source of sources.slice(0, 4)) {
        if (controller.signal.aborted || used >= 60_000) break;
        try {
          const page = await web.fetch({ url: source.url }, controller.signal);
          if (!page || page.statusCode !== 200) continue;
          const raw = page.body?.content;
          if (typeof raw !== 'string' || !raw.trim()) continue;
          const text = page.body.kind === 'html' ? htmlToText(raw) : raw.replace(/\s+/g, ' ').trim();
          if (!text) continue;
          const excerpt = text.slice(0, 15_000);
          used += excerpt.length;
          pages.push({ url: page.url || source.url, title: source.title || '', chars: text.length });
          content += `\n\n【网页 ${pages.length}】${source.title || source.url}\n${source.url}\n${excerpt}`;
        } catch {
          if (controller.signal.aborted) break;
          /* a single unreadable page must not fail the whole search */
        }
      }
    }
    sendJson(res, 200, {
      ok: true,
      query,
      mode,
      requestedMode,
      fetchSupported: canFetch,
      content: content.slice(0, 70_000),
      sources,
      pages,
      truncated: result?.truncated === true,
    });
  } catch (error) {
    if (!res.headersSent) {
      sendJson(res, 502, {
        error: 'search_failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    res.off('close', abort);
  }
}

async function collectDshText(llm, selection, system, userText, maxTokens, signal) {
  let text = '';
  for await (const chunk of llm.stream({
    provider: selection.provider,
    model: selection.id,
    messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
    system,
    maxTokens,
    ...utilityReasoning(selection),
    signal,
  })) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
    if (text.length > 40_000 || chunk?.type === 'finish') break;
  }
  return text.trim();
}

/**
 * Web search sub-agent for non-official search providers. The configured
 * DSH model decides whether the question needs live pages, plans 1-3 queries,
 * then summarizes the host's ctx.web results into a brief for the chat model.
 */
async function handleSearchAgent(req, res, ctx) {
  const web = ctx?.get?.('web');
  const llm = ctx?.get?.('llm');
  if (!web?.search) {
    sendJson(res, 501, { error: 'search_unavailable', message: '当前 DSH 组合没有加载 web 搜索服务' });
    return;
  }
  if (!llm?.stream) {
    sendJson(res, 501, { error: 'llm_unavailable', message: '当前 DSH 组合没有 LLM 服务' });
    return;
  }
  const body = await readJsonBody(req, 200_000);
  const query = typeof body.query === 'string' ? body.query.trim().slice(0, 8000) : '';
  if (!query) {
    sendJson(res, 400, { error: 'empty_query', message: '搜索问题为空' });
    return;
  }
  const catalog = await listDshModels(ctx);
  const provider = typeof body.provider === 'string' ? body.provider.trim() : '';
  const model = typeof body.model === 'string' ? body.model.trim() : '';
  const selected = catalog.models.find((item) => item.id === model && (!provider || item.provider === provider))
    || catalog.models.find((item) => item.id === model);
  if (!selected) {
    sendJson(res, 400, { error: 'search_model_unavailable', message: '搜索子 Agent 模型不可用' });
    return;
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  res.on('close', abort);
  try {
    let plan = null;
    try {
      const planText = await collectDshText(
        llm,
        selected,
        '你是联网搜索子 Agent。判断用户问题是否需要查询实时网页或最新信息。需要则只输出 JSON：{"queries":["简洁检索词1","简洁检索词2"]}，1 到 3 条；不需要则只输出：{"no_search":true}。不要输出任何解释。',
        query,
        256,
        controller.signal,
      );
      plan = JSON.parse(planText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim());
    } catch {
      plan = null;
    }
    if (plan?.no_search === true) {
      sendJson(res, 200, { ok: true, used: false, queries: [], sources: [], brief: '' });
      return;
    }
    let queries = Array.isArray(plan?.queries)
      ? plan.queries
        .filter((item) => typeof item === 'string' && item.trim())
        .map((item) => item.trim().slice(0, 200))
        .slice(0, 3)
      : [];
    if (!queries.length) queries = [query.slice(0, 200)];

    const sources = [];
    let content = '';
    let pages = [];
    for (const searchQuery of queries) {
      if (controller.signal.aborted) break;
      try {
        const result = await web.search({ query: searchQuery, maxResults: 6 }, controller.signal);
        for (const raw of Array.isArray(result?.sources) ? result.sources : []) {
          const source = cleanSource(raw);
          if (source && !sources.some((item) => item.url === source.url)) sources.push(source);
        }
        if (typeof result?.content === 'string' && content.length < 40_000) {
          content += `\n\n【搜索：${searchQuery}】\n${result.content.slice(0, 8000)}`;
        }
      } catch {
        if (controller.signal.aborted) break;
        /* one failed query must not fail the agent */
      }
    }

    let pageText = '';
    if (typeof web.fetch === 'function') {
      for (const source of sources.slice(0, 2)) {
        if (controller.signal.aborted || pageText.length >= 24_000) break;
        try {
          const page = await web.fetch({ url: source.url }, controller.signal);
          if (!page || page.statusCode !== 200) continue;
          const raw = page.body?.content;
          if (typeof raw !== 'string' || !raw.trim()) continue;
          const text = page.body.kind === 'html' ? htmlToText(raw) : raw.replace(/\s+/g, ' ').trim();
          if (!text) continue;
          const excerpt = text.slice(0, 8000);
          pageText += `\n\n【网页】${source.title || source.url}\n${source.url}\n${excerpt}`;
          pages.push({ url: page.url || source.url, title: source.title || '', chars: text.length });
        } catch {
          if (controller.signal.aborted) break;
        }
      }
    }

    if (!sources.length && !content.trim()) {
      sendJson(res, 200, { ok: true, used: false, queries, sources: [], brief: '' });
      return;
    }

    const sourceLines = sources.slice(0, 10).map((source, index) => {
      const excerpt = source.summary || source.snippet || '';
      return `[${index + 1}] ${source.title || source.url}\n${source.url}${excerpt ? `\n${excerpt}` : ''}`;
    }).join('\n\n');
    const briefPrompt = `用户问题：${query}

检索词：${queries.join('、')}

搜索结果：
${content.slice(0, 50_000)}

网页正文：
${pageText.slice(0, 30_000)}

来源：
${sourceLines}

请写一段供另一个模型回答用户问题用的检索简报：保留关键事实、数字、时间与出处编号；不要编造；资料不足要明确说明。控制在 1500 字以内。`;
    let brief = '';
    try {
      brief = await collectDshText(
        llm,
        selected,
        '你是联网搜索子 Agent，负责把搜索结果整理成可靠的检索简报。',
        briefPrompt,
        1800,
        controller.signal,
      );
    } catch {
      if (controller.signal.aborted) throw new Error('aborted');
    }
    if (!brief) brief = content.slice(0, 6000);
    sendJson(res, 200, {
      ok: true,
      used: true,
      queries,
      sources: sources.slice(0, 10),
      brief: brief.slice(0, 8000),
      pages,
    });
  } catch (error) {
    if (!res.headersSent) {
      sendJson(res, 502, {
        error: 'search_agent_failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    res.off('close', abort);
  }
}

async function serveFile(req, res, filePath) {
  const info = await stat(filePath);
  if (!info.isFile()) {
    send(res, 404, 'text/plain; charset=utf-8', 'Not found');
    return;
  }
  const body = await readFile(filePath);
  const type = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': String(body.length),
  });
  if (req.method === 'HEAD') res.end();
  else res.end(body);
}

function normalizeEffort(value) {
  if (typeof value === 'string' && ['off', 'low', 'high', 'max'].includes(value)) return value;
  return 'high';
}


async function streamDshChat(req, res, ctx, config, llm, body) {
  const catalog = await listDshModels(ctx);
  const models = catalog.models;
  let provider = typeof body.provider === 'string' ? body.provider.trim() : config.provider;
  let model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : config.model;
  let selected = models.find((item) => item.id === model && (!provider || item.provider === provider));
  if (!selected) {
    selected = models.find((item) => item.id === model)
      || models.find((item) => item.id === catalog.defaultSelection?.model
        && (!catalog.defaultSelection?.provider || item.provider === catalog.defaultSelection.provider))
      || models[0];
  }
  if (selected) {
    provider = selected.provider;
    model = selected.id;
  }
  if (!provider || !model) {
    sendJson(res, 400, { error: 'missing_model', message: 'DSH 没有可用的模型' });
    return;
  }

  const messages = normalizeChatMessages(body.messages);
  if (!messages.length) {
    sendJson(res, 400, { error: 'empty_messages', message: '消息为空' });
    return;
  }
  // DSH's session message type references durable image attachments, not
  // inline Anthropic source blocks: save once and send {type:'image', attachment}.
  const attachmentsService = ctx?.get?.('attachments');
  const requestMessages = [];
  for (const item of buildContextMessages(messages, selected?.contextWindow)) {
    const blocks = [];
    const text = messageTextOf(item);
    if (text) blocks.push({ type: 'text', text: text.slice(0, 400_000) });
    for (const image of item.images || []) {
      if (attachmentsService?.saveImage) {
        try {
          const ref = await attachmentsService.saveImage({
            data: Buffer.from(image.data, 'base64'),
            mediaType: image.mediaType,
            name: image.name || 'image',
          });
          blocks.push({ type: 'image', attachment: ref });
          continue;
        } catch { /* storage rejected the image; degrade below */ }
      }
      blocks.push({ type: 'text', text: '[图片附件未能附加：当前组合没有可用的附件存储]' });
    }
    if (!blocks.length) continue;
    requestMessages.push(item.role === 'user'
      ? { role: 'user', content: blocks }
      : {
        role: 'assistant',
        id: randomUUID(),
        source: { kind: 'model', provider, model },
        content: blocks,
      });
  }

  const effort = normalizeEffort(body.effort);
  let reasoningEffort;
  const officialDeepSeek = /^deepseek-(official|account)$/.test(provider);
  const efforts = selected?.reasoning?.efforts?.map((item) => item.id);
  if (officialDeepSeek && Array.isArray(efforts) && efforts.length > 0 && efforts.includes(effort)) {
    reasoningEffort = effort;
  } else if (officialDeepSeek && Array.isArray(efforts) && efforts.length > 0 && efforts.includes(selected?.reasoning?.defaultEffort)) {
    reasoningEffort = selected.reasoning.defaultEffort;
  }

  const modelOutput = Number(selected?.maxTokens) > 0 ? Number(selected.maxTokens) : 0;
  const configuredOutput = Number(config.maxTokens) > 0 ? Number(config.maxTokens) : DEFAULT_MAX_TOKENS;
  const requestedOutput = Number.isSafeInteger(body.maxTokens) && body.maxTokens > 0
    ? body.maxTokens
    : 0;
  const outputLimit = Math.max(1, Math.min(
    requestedOutput || modelOutput || configuredOutput,
    200_000,
  ));

  const controller = new AbortController();
  const abort = () => controller.abort();
  res.on('close', abort);
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const emit = (event, data) => res.write(`event: ${event}
data: ${JSON.stringify(data)}

`);
  const started = new Set();
  const startBlock = (index, type) => {
    if (started.has(index)) return;
    started.add(index);
    emit('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: type === 'reasoning'
        ? { type: 'thinking', thinking: '' }
        : { type: 'text', text: '' },
    });
  };
  emit('message_start', { type: 'message_start', message: { model, usage: {} } });
  let errored = false;
  try {
    for await (const chunk of llm.stream({
      provider,
      model,
      messages: requestMessages,
      maxTokens: outputLimit,
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
      ...typeof body.system === 'string' && body.system.trim() ? { system: body.system.slice(0, 40_000) } : {},
      signal: controller.signal,
    })) {
      if (!chunk || typeof chunk.type !== 'string') continue;
      if (chunk.type === 'block-start' && (chunk.blockType === 'reasoning' || chunk.blockType === 'text')) {
        startBlock(chunk.index, chunk.blockType);
      } else if (chunk.type === 'reasoning-delta') {
        startBlock(chunk.index, 'reasoning');
        emit('content_block_delta', {
          type: 'content_block_delta',
          index: chunk.index,
          delta: { type: 'thinking_delta', thinking: chunk.text },
        });
      } else if (chunk.type === 'text-delta') {
        startBlock(chunk.index, 'text');
        emit('content_block_delta', {
          type: 'content_block_delta',
          index: chunk.index,
          delta: { type: 'text_delta', text: chunk.text },
        });
      } else if (chunk.type === 'finish') {
        if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') {
          errored = true;
          emit('error', {
            type: 'error',
            error: {
              type: 'chat_error',
              message: chunk.reason.kind === 'aborted'
                ? '已停止生成'
                : (chunk.reason.failure?.message || '模型调用失败'),
            },
          });
        }
        break;
      }
    }
  } catch (error) {
    errored = true;
    if (!res.writableEnded) {
      emit('error', {
        type: 'error',
        error: { type: 'chat_error', message: error instanceof Error ? error.message : String(error) },
      });
    }
  } finally {
    res.off('close', abort);
    if (!errored) emit('message_stop', { type: 'message_stop' });
    res.end();
  }
}

// Rough token estimate good enough for windowing: CJK ~1 token/char,
// everything else ~4 chars/token. No tokenizer dependency.
function estimateTokens(text) {
  let tokens = 0;
  for (const ch of String(text)) {
    tokens += ch.codePointAt(0) >= 0x2e80 ? 1 : 0.25;
  }
  return Math.ceil(tokens);
}

function truncateToTokens(text, budget) {
  if (estimateTokens(text) <= budget) return text;
  let used = 0;
  let out = '';
  for (const ch of String(text)) {
    used += ch.codePointAt(0) >= 0x2e80 ? 1 : 0.25;
    if (used > budget) break;
    out += ch;
  }
  return out;
}

const IMAGE_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/**
 * Normalize renderer messages: text, extracted attachment text and inline
 * images. Documents are text-extracted client-side; images only arrive from
 * models that declared image input.
 */
function normalizeChatMessages(list) {
  return (Array.isArray(list) ? list : [])
    .filter((item) => item && ['user', 'assistant'].includes(item.role))
    .map((item) => {
      const images = item.role === 'user' && Array.isArray(item.images)
        ? item.images.slice(0, 20).map((image) => {
          const mediaType = typeof image?.mediaType === 'string' ? image.mediaType : '';
          const data = typeof image?.data === 'string' ? image.data : '';
          if (!IMAGE_MEDIA_TYPES.has(mediaType) || !data || data.length > 11_000_000) return null;
          return { mediaType, data, name: typeof image?.name === 'string' ? image.name.slice(0, 200) : 'image' };
        }).filter(Boolean)
        : [];
      return {
        role: item.role,
        content: typeof item.content === 'string' ? item.content : '',
        attachmentText: item.role === 'user' && typeof item.attachmentText === 'string'
          ? item.attachmentText.slice(0, 400_000)
          : '',
        images,
      };
    })
    .filter((item) => item.content.trim() || item.attachmentText.trim() || item.images.length);
}

function messageTextOf(message) {
  return [message.content, message.attachmentText].filter((part) => part && part.trim()).join('\n\n');
}

function messageBlocks(message) {
  const blocks = [];
  const text = messageTextOf(message);
  if (text) blocks.push({ type: 'text', text: text.slice(0, 400_000) });
  for (const image of message.images || []) {
    blocks.push({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } });
  }
  return blocks;
}

/**
 * Use the model's declared context window when DSH exposes one (75% for
 * input, leaving room for output and system text). Models without metadata
 * keep the previous 80-message window. Nothing is deleted from disk.
 */
function buildContextMessages(messages, contextWindow) {
  const costOf = (message) => estimateTokens(messageTextOf(message))
    + (Array.isArray(message.images) ? message.images.length * 1500 : 0)
    + 8;
  const window = Number(contextWindow);
  if (!(window > 0)) {
    return messages.slice(-80).map((message) => ({
      ...message,
      content: message.content.slice(0, 120_000),
      attachmentText: (message.attachmentText || '').slice(0, 120_000),
    }));
  }
  const budget = Math.max(1024, Math.floor(window * 0.75));
  const picked = [];
  let used = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const cost = costOf(message);
    if (used + cost > budget) {
      if (picked.length === 0) {
        picked.push({
          ...message,
          content: truncateToTokens(messageTextOf(message), Math.max(256, budget - 16)),
          attachmentText: '',
        });
      }
      break;
    }
    picked.push(message);
    used += cost;
  }
  return picked.reverse();
}

async function handleChat(req, res, ctx) {
  const config = await readConfig();
  let body;
  try {
    body = await readJsonBody(req, CHAT_BODY_LIMIT);
  } catch {
    sendJson(res, 400, { error: 'invalid_body', message: '请求体无法解析或过大' });
    return;
  }
  const wantsSearch = body.search === true;
  const llm = ctx?.get?.('llm');
  if (llm?.stream && !wantsSearch) {
    await streamDshChat(req, res, ctx, config, llm, body);
    return;
  }
  const auth = await resolveAuth(ctx, config);
  if (!auth) {
    sendJson(res, 401, {
      error: 'missing_credential',
      message: 'DSH 里还没有可用的 DeepSeek 凭据，请先在 DSH 设置中配置 API Key 或登录账号',
    });
    return;
  }
  if (wantsSearch) {
    if (!auth.key) {
      sendJson(res, 401, {
        error: 'missing_official_key',
        message: '联网搜索需要 DeepSeek 平台 API Key（DSH 账号令牌不被官方搜索工具接受）',
      });
      return;
    }
    const searchModel = typeof body.model === 'string' && body.model.trim()
      ? body.model.trim()
      : config.model;
    if (searchModel !== 'deepseek-flash') {
      sendJson(res, 400, {
        error: 'search_model_unsupported',
        message: '联网搜索需要 DeepSeek-V4.1-Flash；可在设置里把搜索提供商改为 DSH 模型子 Agent',
      });
      return;
    }
  }

  const incoming = normalizeChatMessages(body.messages);
  const messages = buildContextMessages(incoming, null).map((item) => ({
    role: item.role,
    content: messageBlocks(item),
  }));
  if (!messages.length) {
    sendJson(res, 400, { error: 'empty_messages', message: '消息为空' });
    return;
  }

  const effort = normalizeEffort(body.effort);
  const maxTokens = Number.isSafeInteger(body.maxTokens) && body.maxTokens > 0
    ? Math.min(body.maxTokens, 32_000)
    : config.maxTokens || DEFAULT_MAX_TOKENS;
  const payload = {
    model: typeof body.model === 'string' && body.model.trim() ? body.model.trim() : config.model,
    stream: true,
    max_tokens: maxTokens,
    messages,
    thinking: { type: effort === 'off' ? 'disabled' : 'enabled' },
    ...effort === 'off' ? {} : { output_config: { effort } },
    ...typeof body.system === 'string' && body.system.trim() ? { system: body.system.slice(0, 40_000) } : {},
    ...wantsSearch ? {
      tools: [
        { type: 'deepseek_web_search', name: 'deepseek_web_search' },
        { type: 'deepseek_read_url', name: 'deepseek_read_url' },
      ],
    } : {},
  };

  const controller = new AbortController();
  const abort = () => controller.abort();
  res.on('close', abort);

  let upstream;
  try {
    upstream = await fetch(messagesEndpoint(config.baseUrl), {
      method: 'POST',
      headers: {
        ...auth.headers,
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
      redirect: 'error',
    });
  } catch (error) {
    res.off('close', abort);
    sendJson(res, 502, { error: 'upstream_unreachable', message: error instanceof Error ? error.message : String(error) });
    return;
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '');
    res.off('close', abort);
    sendJson(res, upstream.status || 502, {
      error: 'upstream',
      status: upstream.status,
      message: text.slice(0, 4000),
    });
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  try {
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) res.write(Buffer.from(value));
    }
  } catch {
    /* client aborted or upstream broke */
  } finally {
    res.off('close', abort);
    res.end();
  }
}

async function handle(req, res, prefix, ctx) {
  if (!isTrusted(req)) {
    send(res, 403, 'text/plain; charset=utf-8', 'Forbidden');
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (pathname === prefix || pathname === `${prefix}/`) {
      await serveFile(req, res, join(APP_DIR, 'index.html'));
      return;
    }
    if (pathname === `${prefix}/api/readme`) {
      try {
        const source = await readFile(README_PATH, 'utf8');
        // The settings reader lives under the app page; make README's relative
        // screenshot paths resolve against the plugin root instead.
        const markdown = source.replace(/\]\(docs\//g, `](${prefix}/docs/`);
        sendJson(res, 200, { ok: true, markdown, license: 'MIT', version: PLUGIN_VERSION });
      } catch {
        sendJson(res, 404, { error: 'readme_not_found', message: 'README.md 不可用' });
      }
      return;
    }
    if (pathname.startsWith(`${prefix}/docs/`)) {
      const rel = pathname.slice(`${prefix}/docs/`.length);
      const target = normalize(join(DOCS_DIR, rel));
      const root = DOCS_DIR.endsWith(sep) ? DOCS_DIR : DOCS_DIR + sep;
      if (!target.startsWith(root)) {
        send(res, 403, 'text/plain; charset=utf-8', 'Forbidden');
        return;
      }
      await serveFile(req, res, target);
      return;
    }
    if (pathname.startsWith(`${prefix}/app/`)) {
      const rel = pathname.slice(`${prefix}/app/`.length);
      const target = normalize(join(APP_DIR, rel));
      const root = APP_DIR.endsWith(sep) ? APP_DIR : APP_DIR + sep;
      if (!target.startsWith(root)) {
        send(res, 403, 'text/plain; charset=utf-8', 'Forbidden');
        return;
      }
      await serveFile(req, res, target);
      return;
    }
    if (pathname === `${prefix}/api/state`) {
      sendJson(res, 200, await publicState(ctx));
      return;
    }
    if (pathname === `${prefix}/api/sessions`) {
      sendJson(res, 200, { ok: true, ...await readSessions() });
      return;
    }
    if (pathname === `${prefix}/api/selfcheck`) {
      const checks = {};
      for (const file of ['index.html', 'css/app.css', 'js/app.js', 'js/icons.js', 'assets/whale.svg', 'vendor/markdown-it.min.js', 'vendor/katex/katex.min.js', 'vendor/katex/katex.min.css', 'vendor/jszip/jszip.min.js', 'vendor/pdfjs/pdf.min.js', 'vendor/pdfjs/pdf.worker.min.js', 'vendor/shiki/shiki.js']) {
        try {
          const info = await stat(join(APP_DIR, file));
          checks[file] = info.isFile();
        } catch {
          checks[file] = false;
        }
      }
      try {
        checks['README.md'] = (await stat(README_PATH)).isFile();
      } catch {
        checks['README.md'] = false;
      }
      sendJson(res, 200, {
        ok: Object.values(checks).every(Boolean),
        plugin: name,
        pluginVersion: PLUGIN_VERSION,
        node: process.version,
        route: `${prefix}/api`,
        checks,
      });
      return;
    }
  }

  if (req.method === 'POST') {
    if (pathname === `${prefix}/api/config`) {
      const body = await readJsonBody(req);
      const config = await readConfig();
      if (typeof body.baseUrl === 'string' && body.baseUrl.trim()) {
        const base = validBaseUrl(body.baseUrl.trim());
        if (!base) {
          sendJson(res, 400, { error: 'invalid_base_url', message: 'Base URL 必须是 HTTPS 或本机回环 HTTP' });
          return;
        }
        config.baseUrl = base;
      }
      if (typeof body.provider === 'string') config.provider = body.provider.trim().slice(0, 120);
      if (typeof body.model === 'string' && body.model.trim()) config.model = body.model.trim().slice(0, 120);
      if (Number.isSafeInteger(body.maxTokens) && body.maxTokens > 0) config.maxTokens = Math.min(body.maxTokens, 32_000);
      await writeConfig(config);
      sendJson(res, 200, await publicState(ctx));
      return;
    }
    if (pathname === `${prefix}/api/search`) {
      await handleSearch(req, res, ctx);
      return;
    }
    if (pathname === `${prefix}/api/search/agent`) {
      await handleSearchAgent(req, res, ctx);
      return;
    }
    if (pathname === `${prefix}/api/title`) {
      await handleTitle(req, res, ctx);
      return;
    }
    if (pathname === `${prefix}/api/compress`) {
      await handleCompress(req, res, ctx);
      return;
    }
    if (pathname === `${prefix}/api/tts`) {
      await handleTts(req, res, ctx);
      return;
    }
    if (pathname === `${prefix}/api/asr`) {
      await handleAsr(req, res, ctx);
      return;
    }
    if (pathname === `${prefix}/api/vision`) {
      await handleVision(req, res, ctx);
      return;
    }
    if (pathname === `${prefix}/api/chat`) {
      await handleChat(req, res, ctx);
      return;
    }
  }

  if (req.method === 'PUT' && pathname === `${prefix}/api/sessions`) {
    let body;
    try {
      body = await readJsonBody(req, SESSION_BODY_LIMIT);
    } catch {
      sendJson(res, 413, { error: 'body_too_large', message: '会话数据超过 192MB' });
      return;
    }
    if (!Array.isArray(body.sessions)) {
      sendJson(res, 400, { error: 'invalid_sessions', message: 'sessions 必须是数组' });
      return;
    }
    const saved = await writeSessions(body);
    sendJson(res, 200, { ok: true, savedAt: saved.savedAt, count: saved.sessions.length });
    return;
  }

  if (req.method === 'POST' && pathname === `${prefix}/api/import/fetch`) {
    let body;
    try {
      body = await readJsonBody(req, 16_000);
    } catch {
      sendJson(res, 400, { error: 'invalid_request', message: '请求过大' });
      return;
    }
    if (typeof body.url !== 'string' || !body.url) {
      sendJson(res, 400, { error: 'invalid_url', message: '缺少导出链接' });
      return;
    }
    try {
      await streamExportArchive(body.url, res);
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendJson(res, 400, {
        error: 'invalid_url',
        message: error instanceof Error ? error.message : '导出链接下载失败',
      });
    }
    return;
  }

  send(res, 404, 'text/plain; charset=utf-8', 'Not found');
}

export function apply(ctx, config = {}) {
  const prefix = typeof config.routePrefix === 'string' && config.routePrefix.startsWith('/')
    ? config.routePrefix.replace(/\/+$/, '')
    : DEFAULT_PREFIX;

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: prefix,
    handler: (req, res) => handle(req, res, prefix, ctx).catch((error) => {
      ctx.logger?.('deepseek-pc-chat')?.warn?.(error);
      if (!res.headersSent) send(res, 500, 'text/plain; charset=utf-8', 'Internal error');
      else res.destroy();
    }),
  }));
}
