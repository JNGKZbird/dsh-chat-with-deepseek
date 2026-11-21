(function () {
  'use strict';

  const icon = (name, size) => window.DSCIcons.icon(name, size);

  // Works both standalone (./index.html) and mounted inside DSH, where the
  // document lives at "/" while the app is served from its own prefix.
  const APP_BASE = (function () {
    if (window.DSC_APP_BASE) return window.DSC_APP_BASE;
    const script = document.currentScript;
    if (script && script.src) return new URL('../', script.src).href;
    return './';
  })();
  const asset = (name) => `${APP_BASE}assets/${name}?v=3`;
  // In DSH the app lives at <prefix>/app/, so its API is one level up. APP_BASE
  // may be a host-relative path, so resolve it against the document first.
  const API_BASE = new URL('../api/', new URL(APP_BASE, location.href)).href;

  // ---- Offline Shiki highlighter -------------------------------------
  // DSH's own chat renders fenced code with Shiki's `css-variables` theme:
  // every token references the host's --shiki-token-* palette, so light and
  // dark follow the surrounding theme without re-highlighting. The runtime is
  // a locally vendored ESM bundle (app/vendor/shiki/) built from the same
  // Shiki major, theme and JavaScript regex engine as DSH; grammars load on
  // demand and fences upgrade in place once their grammar arrives.
  const SHIKI_VERSION = '1';
  // While a reply streams, the code fence still growing is re-rendered every
  // frame. Re-running Shiki on a large block costs ~100ms per pass, so a
  // growing fence above this size stays plain until the reply settles.
  const SHIKI_STREAM_LIMIT = 2000;
  const CODE_CACHE_LIMIT = 300;
  const CODE_CACHE_CHARS = 4 * 1024 * 1024;
  let shikiRuntime = null;
  let shikiState = 'idle'; // idle | loading | ready | failed
  const codeHtmlCache = new Map();
  let codeCacheChars = 0;
  let codeUpgradeTimer = null;

  function bootShiki() {
    if (shikiState !== 'idle') return;
    shikiState = 'loading';
    try {
      const url = new URL(
        `vendor/shiki/shiki.js?v=${SHIKI_VERSION}`,
        new URL(APP_BASE, location.href),
      ).href;
      import(url)
        .then((mod) => mod.createRuntime())
        .then((runtime) => {
          shikiRuntime = runtime;
          shikiState = 'ready';
          scheduleCodeUpgrade();
        })
        .catch(() => {
          shikiState = 'failed';
        });
    } catch {
      // A broken highlighter must never take the chat surface down with it.
      shikiState = 'failed';
    }
  }

  function codeCacheStore(key, html) {
    codeHtmlCache.set(key, html);
    codeCacheChars += key.length + html.length;
    while (codeHtmlCache.size > CODE_CACHE_LIMIT || codeCacheChars > CODE_CACHE_CHARS) {
      const oldest = codeHtmlCache.keys().next();
      if (oldest.done) break;
      const oldHtml = codeHtmlCache.get(oldest.value);
      codeHtmlCache.delete(oldest.value);
      codeCacheChars -= oldest.value.length + (oldHtml ? oldHtml.length : 0);
    }
  }

  // Shiki emits bare `var(--shiki-*)` references. Inside DSH the host owns
  // that palette; the second argument keeps the plugin coloured on hosts (or
  // previews) that never publish it, with the same palette per theme.
  function withTokenFallbacks(html) {
    return html.replace(/var\(--shiki-([a-z-]+)\)/g, 'var(--shiki-$1, var(--dsc-shiki-$1))');
  }

  // Synchronous when possible. Returns null while the grammar is still
  // loading, which the caller renders as plain text.
  function highlightCode(code, lang) {
    if (!shikiRuntime || !lang) return null;
    const key = `${lang}\u0000${code}`;
    const cached = codeHtmlCache.get(key);
    if (cached !== undefined) return cached;
    const raw = shikiRuntime.highlight(code, lang);
    if (!raw) return null;
    const html = withTokenFallbacks(raw);
    codeCacheStore(key, html);
    return html;
  }

  function scheduleCodeUpgrade() {
    if (codeUpgradeTimer !== null) return;
    codeUpgradeTimer = setTimeout(() => {
      codeUpgradeTimer = null;
      upgradeCodeBlocks();
    }, 0);
  }

  // Replace plain <pre> bodies with Shiki output once their grammar is in.
  // Patching the pre in place keeps scroll position, hover state and any
  // running stream untouched, unlike a full message re-render.
  function upgradeCodeBlocks() {
    if (!shikiRuntime) return;
    for (const block of document.querySelectorAll('.dsc-code-block[data-dsc-hl="pending"]')) {
      if (block.dataset.dscStream === '1') continue;
      const lang = block.dataset.lang || '';
      if (shikiRuntime.status(lang) !== 'ready') continue;
      const codeEl = block.querySelector('code');
      const pre = block.querySelector('pre');
      if (!codeEl || !pre) continue;
      const html = highlightCode(codeEl.textContent, lang);
      if (!html) continue;
      pre.outerHTML = html;
      block.dataset.dscHl = 'ready';
    }
  }

  function codeBlockHTML(code, lang, env, tokens, idx) {
    const streaming = !!(env && env.streaming);
    const lastFence = (() => {
      for (let i = idx + 1; i < tokens.length; i += 1) {
        if (tokens[i].type === 'fence' || tokens[i].type === 'code_block') return false;
      }
      return true;
    })();
    const growing = streaming && lastFence;
    const deferred = growing && code.length > SHIKI_STREAM_LIMIT;
    let pre = null;
    let status = deferred ? 'pending' : 'plain';
    if (!deferred) {
      pre = highlightCode(code, lang);
      if (pre) status = 'ready';
      else if (lang && shikiRuntime && shikiRuntime.status(lang) === 'loading') {
        status = 'pending';
        void shikiRuntime.load(lang).then(scheduleCodeUpgrade);
      } else if (lang && shikiState === 'loading') {
        status = 'pending';
      }
    }
    if (pre === null) pre = `<pre class="dsc-code-pre"><code>${escapeHtml(code)}</code></pre>`;
    const streamAttr = growing ? ' data-dsc-stream="1"' : '';
    return `<div class="dsc-code-block" data-lang="${escapeHtml(lang)}" data-dsc-hl="${status}"${streamAttr}>`
      + `<div class="dsc-code-head"><span class="dsc-code-lang">${escapeHtml(lang)}</span>`
      + '<button class="dsc-code-copy" type="button" data-act="copy-code" aria-label="复制代码">复制</button></div>'
      + `${pre}</div>`;
  }

  let markdown = null;
  function markdownRenderer() {
    if (markdown !== null) return markdown;
    if (!window.markdownit) {
      markdown = false;
      return markdown;
    }
    markdown = window.markdownit({
      html: false,
      linkify: true,
      breaks: true,
      typographer: false,
    });
    const linkOpen = markdown.renderer.rules.link_open
      || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
    markdown.renderer.rules.link_open = (tokens, idx, options, env, self) => {
      tokens[idx].attrSet('target', '_blank');
      tokens[idx].attrSet('rel', 'noreferrer noopener');
      return linkOpen(tokens, idx, options, env, self);
    };
    // Fences carry the DSH chrome: a language banner (with the copy label)
    // over the highlighted body. Indented code blocks get the same card
    // without a language.
    markdown.renderer.rules.fence = (tokens, idx, options, env) => {
      const token = tokens[idx];
      // DSH keeps only the leading word of the info string (the language).
      const lang = (/^[\w-]+/.exec(String(token.info || '').trim()) || [''])[0].toLowerCase();
      const code = token.content.endsWith('\n') ? token.content.slice(0, -1) : token.content;
      // DSH renders a ```math fence as a display formula unless it is still
      // streaming (mid-fence content is not valid math yet).
      if (lang === 'math' && !(env && env.streaming)) {
        return `<p class="dsc-math-block">${renderMathHTML(code, true)}</p>\n`;
      }
      // An empty fence stays a bare block, exactly like DSH.
      if (code === '') return `<pre><code class="language-${escapeHtml(lang)}"></code></pre>\n`;
      return codeBlockHTML(code, lang, env, tokens, idx);
    };
    markdown.renderer.rules.code_block = (tokens, idx, options, env) => {
      const code = tokens[idx].content.endsWith('\n')
        ? tokens[idx].content.slice(0, -1)
        : tokens[idx].content;
      return codeBlockHTML(code, '', env, tokens, idx);
    };
    // DSH scrolls wide tables inside their own wrapper.
    markdown.renderer.rules.table_open = () => '<div class="dsc-table-scroll"><table>\n';
    markdown.renderer.rules.table_close = () => '</table></div>\n';
    registerMath(markdown);
    return markdown;
  }

  function renderMathHTML(content, displayMode) {
    const katex = window.katex;
    if (!katex) return escapeHtml(content);
    try {
      return katex.renderToString(content, { displayMode, throwOnError: false });
    } catch {
      return escapeHtml(content);
    }
  }

  // Minimal KaTeX support: block `$$...$$`, inline `$...$`. Code spans/blocks
  // win because the inline rule sits after `backticks` and fences consume
  // their own lines.
  function registerMath(md) {
    const katex = window.katex;
    if (!katex || !md) return;

    md.inline.ruler.before('escape', 'math_inline', (state, silent) => {
      const start = state.pos;
      const first = state.src.charCodeAt(start);
      const dollar = first === 0x24;
      const paren = first === 0x5c && state.src.charCodeAt(start + 1) === 0x28;
      if (!dollar && !paren) return false;
      if (dollar && (state.src.charCodeAt(start + 1) === 0x24 || state.src.charCodeAt(start + 1) === 0x20)) return false;
      const bodyStart = start + (dollar ? 1 : 2);
      let found = -1;
      for (let i = bodyStart; i < state.posMax; i += 1) {
        const code = state.src.charCodeAt(i);
        if (code === 0x0a) return false;
        if (paren) {
          if (code === 0x5c && state.src.charCodeAt(i + 1) === 0x29) { found = i; break; }
          continue;
        }
        if (code === 0x5c) { i += 1; continue; }
        if (code === 0x24) {
          if (state.src.charCodeAt(i - 1) === 0x20) continue;
          found = i;
          break;
        }
      }
      if (found < 0) return false;
      const content = state.src.slice(bodyStart, found);
      if (!content.trim()) return false;
      if (!silent) {
        const token = state.push('math_inline', 'math', 0);
        token.markup = dollar ? '$' : '\\(';
        token.content = content;
      }
      state.pos = found + (paren ? 2 : 1);
      return true;
    });

    md.block.ruler.before('fence', 'math_block', (state, startLine, endLine, silent) => {
      if (state.sCount[startLine] - state.blkIndent >= 4) return false;
      let pos = state.bMarks[startLine] + state.tShift[startLine];
      const max = state.eMarks[startLine];
      const opener = state.src.slice(pos, pos + 2);
      const closer = opener === '$$' ? '$$' : opener === '\\[' ? '\\]' : '';
      if (pos + 2 > max || !closer) return false;
      if (silent) return true;
      let nextLine = startLine;
      let body = '';
      const first = state.src.slice(pos + 2, max);
      let closed = false;
      if (first.trim().endsWith(closer)) {
        body = first.trim().slice(0, -closer.length);
        closed = true;
      } else {
        if (first.trim()) body = `${first.trim()}\n`;
        while (++nextLine < endLine) {
          pos = state.bMarks[nextLine] + state.tShift[nextLine];
          const lineMax = state.eMarks[nextLine];
          const line = state.src.slice(pos, lineMax);
          const close = line.indexOf(closer);
          if (close >= 0) {
            body += line.slice(0, close);
            closed = true;
            break;
          }
          body += `${line}\n`;
        }
      }
      if (!closed) return false;
      const token = state.push('math_block', 'math', 0);
      token.block = true;
      token.content = body.trim();
      token.map = [startLine, nextLine + 1];
      state.line = nextLine + 1;
      return true;
    }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });

    md.renderer.rules.math_inline = (tokens, idx) => renderMathHTML(tokens[idx].content, false);
    md.renderer.rules.math_block = (tokens, idx) => `<p class="dsc-math-block">${renderMathHTML(tokens[idx].content, true)}</p>\n`;
  }

  function renderMarkdown(text, options) {
    const engine = markdownRenderer();
    if (engine) return engine.render(text, options || {});
    return `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`;
  }

  const SESSIONS_KEY = 'dsc.sessions.v1';
  // Neither the number of conversations nor messages per conversation is
  // capped on disk. The host request body (32MB) is the physical ceiling.

  // Attachment whitelist mirrors the Android app's supported extension set
  // (调研/jadx_out/defpackage/yo3.java); limits follow its composer tooltip.
  const ATTACH_MAX_COUNT = 20;
  const ATTACH_MAX_BYTES = 100 * 1024 * 1024;
  const ATTACH_TEXT_LIMIT = 400_000;
  const ATTACH_IMAGE_EXTS = new Set([
    'png', 'jpg', 'jpeg', 'jpe', 'jfif', 'webp', 'gif', 'bmp', 'tif', 'tiff',
    'svg', 'svgz', 'ico', 'avif', 'heic', 'heif', 'dib',
  ]);
  const ATTACH_AUDIO_EXTS = new Set(['wav', 'ogg', 'oga', 'opus', 'mp3', 'm4a', 'aac', 'flac', 'webm', 'weba']);
  const ATTACH_OFFICE_EXTS = new Set(['docx', 'pptx', 'xlsx']);
  const ATTACH_LEGACY_OFFICE_EXTS = new Set(['doc', 'ppt', 'xls']);
  const ATTACH_TEXT_EXTS = new Set([
    'txt', 'md', 'markdown', 'mdx', 'rst', 'adoc', 'asciidoc', 'org', 'tex', 'ltx', 'bib',
    'csv', 'tsv', 'json', 'jsonl', 'json5', 'geojson', 'log', 'xml', 'yaml', 'yml', 'toml',
    'ini', 'cfg', 'conf', 'properties', 'env', 'diff', 'patch',
    'html', 'htm', 'xhtml', 'css', 'scss', 'sass', 'less', 'styl',
    'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte', 'astro',
    'py', 'pyi', 'ipynb', 'java', 'kt', 'kts', 'groovy', 'scala', 'clj', 'cljs',
    'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx', 'm', 'mm', 'cs', 'go', 'rs',
    'rb', 'php', 'pl', 'pm', 'lua', 'r', 'swift', 'dart', 'sh', 'bash', 'zsh', 'fish',
    'bat', 'cmd', 'ps1', 'psm1', 'sql', 'graphql', 'gql', 'proto', 'thrift',
    'asm', 's', 'v', 'vhd', 'vhdl', 'dockerfile', 'gradle', 'cmake', 'mk', 'makefile',
    'lock', 'gitignore', 'gitattributes', 'editorconfig',
  ]);
  const ATTACH_ALL_EXTS = new Set([
    'pdf', ...ATTACH_IMAGE_EXTS, ...ATTACH_AUDIO_EXTS, ...ATTACH_OFFICE_EXTS, ...ATTACH_LEGACY_OFFICE_EXTS, ...ATTACH_TEXT_EXTS,
  ]);

  const THINK_LEVELS = [
    { value: 'off', label: 'Off' },
    { value: 'low', label: 'Low' },
    { value: 'high', label: 'High' },
    { value: 'max', label: 'Max' },
  ];

  function initialThinking() {
    try {
      const stored = localStorage.getItem('dsc.thinking');
      if (['off', 'low', 'high', 'max'].includes(stored)) return stored;
      return { 0: 'low', 1: 'high', 2: 'max' }[stored] || 'off';
    } catch {
      return 'high';
    }
  }

  const MODEL_OPTIONS = [
    { id: 'deepseek-flash', label: 'DeepSeek-V4.1-Flash', desc: '快速，适合日常对话' },
    { id: 'deepseek-v4-pro', label: 'DeepSeek-V4-Pro', desc: '更强推理，适合复杂任务' },
  ];

  function modelLabel(id) {
    return MODEL_OPTIONS.find((model) => model.id === id)?.label || id || 'DeepSeek-V4.1-Flash';
  }

  const GENERIC_HTML = `
    <p>这个问题可以拆成两层看：先确认你真正要解决的目标，再选择成本最低的路径。</p>
    <h3>先说结论</h3>
    <p>如果你只是需要一个稳定的日常方案，优先选“够用、可替换、维护成本低”的组合，而不是一次性把预算压到某个极限配置上。</p>
    <ul>
      <li>先把必须满足的条件写下来，避免被额外功能带偏；</li>
      <li>把一次性支出和长期成本分开算；</li>
      <li>给方案留一个可以回退的余地。</li>
    </ul>
    <p>你可以把具体场景再补充一点，我再按你的约束给一版更细的取舍。</p>
  `;

  const REPLY_LATEX = `
    <p>可以。先给一个最直观的估算式：</p>
    <p>总成本 = 单价 × 容量 + 维护成本。若把维护成本记作 <code>C</code>，容量记作 <code>Q</code>，则单位容量成本为：</p>
    <pre><code>cost_per_unit = (price(Q) + C) / Q</code></pre>
    <p>实际比较时，把候选方案的 <code>Q</code> 和 <code>C</code> 代入，选单位成本最低的那个即可。</p>
  `;

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function stripTags(html) {
    const box = document.createElement('div');
    box.innerHTML = html;
    return box.textContent || '';
  }

  // TTS cache metadata is shared by messageHTML and the TTS pipeline.
  const ttsCachedKeys = new Set();
  let ttsVoiceGlobal = 'stella';
  let ttsReadyGlobal = false;
  let officialReadyGlobal = false;
  let visionModelsGlobal = [];

  function ttsCacheKey(text, voice) {
    let hash = 2166136261;
    const input = `${voice}:${text}`;
    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `${voice}:${input.length}:${(hash >>> 0).toString(36)}`;
  }

  function safeHttpUrl(value) {
    try {
      const url = new URL(String(value));
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
    } catch {
      return '';
    }
  }

  function hostOf(value) {
    try {
      return new URL(String(value)).hostname;
    } catch {
      return '';
    }
  }

  function sourcesHTML(message, messageIndex) {
    const sources = (message.sources || []).filter((source) => safeHttpUrl(source.url));
    if (!sources.length) return '';
    const open = message.sourcesOpen === true;
    return `
      <div class="dsc-sources" data-open="${open ? '1' : '0'}">
        <button class="dsc-sources-head" type="button" data-act="toggle-sources" data-message-index="${messageIndex}" aria-expanded="${open}">
          <span class="dsc-sources-title">参考来源</span>
          <span class="dsc-sources-count">${sources.length}</span>
          <span class="dsc-sources-chevron">${icon('chevronDown', 14)}</span>
        </button>
        ${open ? `<div class="dsc-source-list">
          ${sources.map((source, index) => `
            <a class="dsc-source" href="${escapeHtml(safeHttpUrl(source.url))}" target="_blank" rel="noreferrer noopener">
              <span class="dsc-source-index">${index + 1}</span>
              <span class="dsc-source-body">
                <span class="dsc-source-title">${escapeHtml(source.title || safeHttpUrl(source.url))}</span>
                <span class="dsc-source-host">${escapeHtml(hostOf(source.url))}</span>
              </span>
            </a>`).join('')}
        </div>` : ''}
      </div>`;
  }

  function cloneMessages(messages) {
    try {
      return JSON.parse(JSON.stringify(messages || []));
    } catch {
      return [];
    }
  }

  // The TTS cache key is derived from this exact string; render, synthesis and
  // old-cache backfill must all agree byte for byte (trim included).
  function ttsSpeechText(message) {
    return String(message?.text || stripTags(message?.html || '') || '').trim().slice(0, 9000);
  }

  // Messages are stored as a tree (id/parentId) so branches survive reloads,
  // while session.messages remains the current branch view for rendering,
  // streaming, search and compression. Store only the tree; messages is
  // derived on load so the two copies are never persisted twice.
  function branchFromTree(tree, byId, currentId) {
    if (!currentId || !byId.has(currentId)) return tree.slice();
    const chain = [];
    const seen = new Set();
    let node = byId.get(currentId);
    while (node && !seen.has(node.id)) {
      seen.add(node.id);
      chain.push(node);
      node = node.parentId != null ? byId.get(node.parentId) : null;
    }
    chain.reverse();
    return chain.length ? chain : tree.slice();
  }

  function normalizeMessageTree(rawTree, rawMessages, rawCurrentId, rawNextId) {
    const source = Array.isArray(rawTree) && rawTree.length
      ? rawTree
      : Array.isArray(rawMessages) ? rawMessages : [];
    const tree = cloneMessages(source).filter((node) => node && typeof node === 'object');
    const seen = new Set();
    let counter = 1;
    let previousId = null;
    for (const node of tree) {
      let id = typeof node.id === 'string' && node.id ? node.id : '';
      if (!id || seen.has(id)) {
        do { id = `m${counter++}`; } while (seen.has(id));
      }
      seen.add(id);
      node.id = id;
      if (node.parentId === undefined) node.parentId = previousId;
      node.streaming = false;
      previousId = id;
    }
    const byId = new Map(tree.map((node) => [node.id, node]));
    for (let index = 0; index < tree.length; index += 1) {
      const node = tree[index];
      if (node.parentId != null && !byId.has(node.parentId)) {
        node.parentId = index > 0 ? tree[index - 1].id : null;
      }
    }
    let nextMessageId = Math.max(1, Number(rawNextId) || 1);
    for (const node of tree) {
      const match = /^m(\d+)$/.exec(node.id);
      if (match) nextMessageId = Math.max(nextMessageId, Number(match[1]) + 1);
    }
    const currentId = typeof rawCurrentId === 'string' && byId.has(rawCurrentId)
      ? rawCurrentId
      : (tree[tree.length - 1]?.id || null);
    return {
      tree,
      currentId,
      nextMessageId,
      messages: branchFromTree(tree, byId, currentId),
    };
  }

  function ensureSessionTree(session) {
    if (!session || typeof session !== 'object') return null;
    if (!Array.isArray(session.tree) || !session.tree.length) {
      const normalized = normalizeMessageTree(null, session.messages, session.currentId, session.nextMessageId);
      session.tree = normalized.tree;
      session.currentId = normalized.currentId;
      session.nextMessageId = normalized.nextMessageId;
      // Keep the live empty array identity; state.messages may point at it.
      if (!(Array.isArray(session.messages) && session.messages.length === 0 && normalized.messages.length === 0)) {
        session.messages = normalized.messages;
      }
      return session;
    }
    let nextMessageId = Math.max(1, Number(session.nextMessageId) || 1);
    const byId = new Map();
    for (const node of session.tree) {
      if (!node || typeof node !== 'object') continue;
      if (typeof node.id !== 'string' || !node.id || byId.has(node.id)) {
        let id;
        do { id = `m${nextMessageId++}`; } while (byId.has(id));
        node.id = id;
      }
      const match = /^m(\d+)$/.exec(node.id);
      if (match) nextMessageId = Math.max(nextMessageId, Number(match[1]) + 1);
      byId.set(node.id, node);
    }
    if (!session.currentId || !byId.has(session.currentId)) {
      session.currentId = session.tree[session.tree.length - 1]?.id || null;
    }
    session.nextMessageId = nextMessageId;
    const branch = branchFromTree(session.tree, byId, session.currentId);
    const current = Array.isArray(session.messages) ? session.messages : [];
    const same = current.length === branch.length && current.every((message, index) => message === branch[index]);
    if (!same) session.messages = branch;
    return session;
  }

  function appendMessageNode(session, message) {
    ensureSessionTree(session);
    const id = `m${session.nextMessageId++}`;
    message.id = id;
    message.parentId = session.currentId || null;
    session.tree.push(message);
    session.currentId = id;
    session.messages.push(message);
    return message;
  }

  function sessionsForPersistence(sessions) {
    return (sessions || []).map((session) => {
      ensureSessionTree(session);
      return { ...session, messages: undefined };
    });
  }

  function messageHasAnyTts(message) {
    if (!message || message.role !== 'assistant') return false;
    if (message.tts && (message.tts.stella || message.tts.tide)) return true;
    const text = ttsSpeechText(message);
    if (!text) return false;
    return ttsCachedKeys.has(ttsCacheKey(text, 'stella'))
      || ttsCachedKeys.has(ttsCacheKey(text, 'tide'));
  }

  function isRoundLocked(session, message) {
    if (!message) return false;
    if (messageHasAnyTts(message)) return true;
    const tree = Array.isArray(session?.tree) ? session.tree : [];
    if (message.role === 'assistant') {
      return tree.some((entry) => entry
        && entry.role === 'assistant'
        && entry.parentId === message.parentId
        && messageHasAnyTts(entry));
    }
    if (message.role === 'user') {
      return tree.some((entry) => entry
        && entry.role === 'assistant'
        && entry.parentId === message.id
        && messageHasAnyTts(entry));
    }
    return false;
  }

  function computeRoundLocks(session) {
    const locks = new Set();
    const tree = Array.isArray(session?.tree) ? session.tree : [];
    for (const node of tree) {
      if (!node || node.role !== 'assistant' || !messageHasAnyTts(node)) continue;
      locks.add(node.id);
      const parent = node.parentId != null
        ? tree.find((entry) => entry.id === node.parentId)
        : null;
      if (parent && parent.role === 'user') {
        locks.add(parent.id);
        for (const sibling of tree) {
          if (sibling && sibling.role === 'assistant' && sibling.parentId === parent.id) {
            locks.add(sibling.id);
          }
        }
      }
    }
    return locks;
  }

  function normalizeSessionRecord(session) {
    if (!session || typeof session.id !== 'string' || typeof session.title !== 'string') return null;
    return {
      id: session.id,
      title: session.title.slice(0, 120) || '新对话',
      createdAt: Number(session.createdAt) || Date.now(),
      updatedAt: Number(session.updatedAt) || Number(session.createdAt) || Date.now(),
      pinned: session.pinned === true,
      ...session.autoTitle === true ? { autoTitle: true } : {},
      ...typeof session.model === 'string' && session.model
        ? { model: session.model.slice(0, 120) } : {},
      ...typeof session.provider === 'string' && session.provider
        ? { provider: session.provider.slice(0, 120) } : {},
      ...typeof session.importBatch === 'string' && session.importBatch
        ? { importBatch: session.importBatch.slice(0, 80) } : {},
      ...Number.isFinite(Number(session.importedAt)) && Number(session.importedAt) > 0
        ? { importedAt: Number(session.importedAt) } : {},
      ...typeof session.importSource === 'string' && session.importSource
        ? { importSource: session.importSource.slice(0, 20) } : {},
      ...session.summary && typeof session.summary === 'object' && typeof session.summary.text === 'string' && session.summary.text
        ? {
          summary: {
            text: session.summary.text.slice(0, 12_000),
            throughIndex: Math.max(0, Number(session.summary.throughIndex) || 0),
            at: Number(session.summary.at) || 0,
          },
        }
        : {},
      ...(() => {
        const normalized = normalizeMessageTree(
          session.tree,
          session.messages,
          session.currentId,
          session.nextMessageId,
        );
        return {
          tree: normalized.tree,
          currentId: normalized.currentId,
          nextMessageId: normalized.nextMessageId,
          messages: normalized.messages,
        };
      })(),
    };
  }

  function readStoredSessions() {
    try {
      const raw = JSON.parse(localStorage.getItem(SESSIONS_KEY) || '[]');
      if (!Array.isArray(raw)) return [];
      return raw
        .map(normalizeSessionRecord)
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  // Host persistence: localStorage is the fast mirror, sessions.json is the
  // durable copy shared by every DSH window. Standalone servers simply 404.
  let hostSessionsAvailable = false;
  let hostSaveTimer = null;
  let hostSaveBody = null;
  // Big imports (the official export can be tens of MB of text) cannot fit
  // in localStorage; once that happens the host sessions.json is the only
  // durable mirror. Keep this flag for the rest of the window's life.
  let localMirrorDisabled = false;
  const LOCAL_MIRROR_LIMIT = 3_000_000;

  function scheduleHostSave(sessions) {
    hostSaveBody = JSON.stringify({ savedAt: Date.now(), sessions: sessionsForPersistence(sessions) });
    if (hostSaveTimer) return;
    hostSaveTimer = setTimeout(() => {
      const body = hostSaveBody;
      hostSaveTimer = null;
      hostSaveBody = null;
      const fail = (status) => window.dispatchEvent(
        new CustomEvent('dsc:host-save-failed', { detail: { status } }),
      );
      fetch(new URL('sessions', API_BASE), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body,
      }).then((response) => {
        if (!response.ok) fail(response.status);
      }).catch(() => {
        // Host unavailable mid-session: the mirror may be the only copy, so
        // surface it instead of failing silently.
        fail(0);
      });
    }, 300);
  }

  function sessionsTextSize(sessions) {
    let total = 0;
    for (const session of sessions || []) {
      for (const message of session.messages || []) {
        total += (message.text?.length || 0) + (message.reasoning?.length || 0) + (message.error?.length || 0);
        if (total > LOCAL_MIRROR_LIMIT) return total;
      }
    }
    return total;
  }

  function storeSessions(sessions) {
    if (!localMirrorDisabled) {
      try {
        const json = JSON.stringify(sessionsForPersistence(sessions));
        if (json.length > LOCAL_MIRROR_LIMIT) {
          localMirrorDisabled = true;
          try { localStorage.removeItem(SESSIONS_KEY); } catch { /* ignore */ }
        } else {
          localStorage.setItem(SESSIONS_KEY, json);
        }
      } catch {
        localMirrorDisabled = true;
        try { localStorage.removeItem(SESSIONS_KEY); } catch { /* ignore */ }
      }
    }
    if (hostSessionsAvailable) scheduleHostSave(sessions);
  }

  function titleFromText(text) {
    const title = String(text || '').replace(/\s+/g, ' ').trim();
    return title.slice(0, 30) || '新对话';
  }

  function dayLabel(timestamp) {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const time = Number(timestamp) || Date.now();
    if (time >= start) return '今天';
    if (time >= start - 86_400_000) return '昨天';
    if (time >= start - 7 * 86_400_000) return '7 天内';
    if (time >= start - 30 * 86_400_000) return '30 天内';
    return '更早';
  }

  function monthLabel(timestamp) {
    const date = new Date(Number(timestamp) || Date.now());
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  }

  function groupSessions(sessions) {
    const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
    const groups = [];
    const pinned = sorted.filter((session) => session.pinned);
    if (pinned.length) groups.push({ label: '置顶', items: pinned });
    const buckets = new Map([['今天', []], ['昨天', []], ['7 天内', []], ['30 天内', []]]);
    const months = new Map();
    for (const session of sorted.filter((item) => !item.pinned)) {
      const label = dayLabel(session.updatedAt);
      if (buckets.has(label)) {
        buckets.get(label).push(session);
      } else {
        const month = monthLabel(session.updatedAt);
        if (!months.has(month)) months.set(month, []);
        months.get(month).push(session);
      }
    }
    for (const label of ['今天', '昨天', '7 天内', '30 天内']) {
      if (buckets.get(label).length) groups.push({ label, items: buckets.get(label) });
    }
    // Sorted list means months are discovered newest-first already.
    for (const [label, items] of months) groups.push({ label, items });
    return groups;
  }

  function brandHTML() {
    return `
      <a class="dsc-brand" href="#" data-act="home" aria-label="DeepSeek 首页">
        <span class="dsc-brand-mark" aria-hidden="true"></span>
        <span class="dsc-brand-word" aria-hidden="true"></span>
      </a>`;
  }

  function actionsHTML() {
    return `
      <div class="dsc-top-actions">
        <button class="dsc-icon-btn dsc-tip" data-tip="展开边栏" data-tip-side="bottom" data-act="toggle-sidebar" aria-label="展开边栏">${icon('panelLeft', 16)}</button>
        <button class="dsc-icon-btn dsc-tip" data-tip="搜索 Ctrl K" data-tip-side="bottom" data-act="open-search" aria-label="搜索对话">${icon('searchOutline', 16)}</button>
        <button class="dsc-icon-btn dsc-tip" data-tip="开启新对话" data-tip-side="bottom" data-act="new-chat" aria-label="开启新对话">${icon('newChat', 16)}</button>
      </div>`;
  }

  function sidebarHTML() {
    return `
      <aside class="dsc-sidebar" aria-label="会话列表">
        <div class="dsc-sidebar-inner">
        <div class="dsc-sb-head">
          ${brandHTML()}
          <div class="dsc-sb-head-actions">
            <button class="dsc-icon-btn dsc-tip" data-tip="搜索 Ctrl K" data-tip-side="bottom" data-act="open-search" aria-label="搜索对话">${icon('searchOutline', 18)}</button>
            <button class="dsc-icon-btn dsc-tip" data-tip="收起边栏" data-tip-side="bottom" data-act="toggle-sidebar" aria-label="收起侧栏">${icon('panelLeft', 18)}</button>
          </div>
        </div>
        <div class="dsc-sb-body">
          <div class="dsc-select-head">
            <h2 class="dsc-select-title" data-role="select-title">选择对话</h2>
            <button class="dsc-select-close" data-act="exit-select" title="退出多选" aria-label="退出多选">${icon('close', 16)}</button>
          </div>
          <button class="dsc-newchat" data-act="new-chat">${icon('newChat', 16)}开启新对话</button>
          <button class="dsc-mode-row" data-act="select-work" title="返回探索" aria-label="返回探索" hidden><span class="dsc-mode-harness" aria-hidden="true"></span><span>返回探索</span></button>
          <nav class="dsc-sessions" aria-label="历史会话"></nav>
        </div>
        <div class="dsc-select-actions">
          <button class="dsc-select-action" data-act="pin-selected" disabled>${icon('pin', 16)}<span>置顶</span></button>
          <span class="dsc-select-divider" aria-hidden="true"></span>
          <button class="dsc-select-action" data-act="delete-selected" disabled>${icon('trash', 16)}<span>删除</span></button>
        </div>
        <div class="dsc-sb-foot" role="group" aria-label="账户">
          <span class="dsc-avatar" data-role="avatar" aria-hidden="true">DS</span>
          <span class="dsc-name" data-role="account-name">DeepSeek 用户</span>
          <button class="dsc-account-more" data-act="account-menu" aria-label="账户菜单" aria-haspopup="menu">${icon('more', 18)}</button>
        </div>
        </div>
      </aside>`;
  }

  function topbarHTML() {
    return `
      <header class="dsc-topbar">
        <div class="dsc-topbar-left">
          <div class="dsc-collapsed-brand">
            <img class="dsc-whale" src="${asset('whale.svg')}" alt="">
            ${actionsHTML()}
          </div>
          <div class="dsc-chat-title" data-role="title"></div>
        </div>
        <div class="dsc-topbar-right">
          <button class="dsc-icon-btn" data-act="share" title="分享" aria-label="分享">${icon('share', 16)}</button>
        </div>
      </header>`;
  }

  function noticeHTML() {
    return `
      <div class="dsc-notice" data-role="notice" hidden>
        ${icon('info', 16)}
        <span data-role="notice-text">服务器繁忙，请稍后再试</span>
      </div>`;
  }

  function composerHTML(where) {
    const id = `dsc-composer-${where}`;
    return `
      <div class="dsc-composer-wrap">
        ${noticeHTML()}
        <div class="dsc-composer" data-composer="${where}">
          <div class="dsc-attach-strip" data-role="attach-strip" hidden></div>
          <textarea id="${id}" rows="1" placeholder="给 DeepSeek 发送消息" aria-label="给 DeepSeek 发送消息"></textarea>
          <div class="dsc-composer-row">
            <div class="dsc-composer-left">
              <button class="dsc-pill dsc-think-trigger dsc-tip" data-tip="先思考后回答，解决推理问题" data-act="think-menu" aria-haspopup="menu" aria-expanded="false" aria-label="思考强度">
                <span class="dsc-pill-inner">${icon('deepThink', 16)}<span>深度思考</span></span>
              </button>
              <button class="dsc-pill dsc-tip" data-tip="按需搜索网页" data-act="toggle-search" aria-pressed="false"><span class="dsc-pill-inner">${icon('globe', 16)}<span>联网搜索</span></span></button>
            </div>
            <div class="dsc-composer-right">
              <button class="dsc-model-trigger" data-act="model-menu" aria-haspopup="menu" aria-expanded="false" aria-label="选择模型">
                <span data-role="model-label">DeepSeek-V4.1-Flash</span>${icon('chevronDown', 14)}
              </button>
              <button class="dsc-attach dsc-tip" data-tip="上传文件，支持各类文档和图片" data-act="attach" aria-label="添加附件">${icon('paperclip', 20)}</button>
              <span class="dsc-find-count" data-role="find-count" hidden></span>
              <button class="dsc-find dsc-tip" data-act="toggle-find" data-tip="搜索当前对话" data-tip-side="bottom" aria-label="搜索当前对话" aria-pressed="false" type="button">${icon('searchOutline', 18)}</button>
              <span class="dsc-send-wrap dsc-tip" data-tip="请输入你的问题">
                <button class="dsc-send" data-act="send" aria-label="发送" disabled>${icon('sendArrow', 20)}</button>
              </span>
            </div>
          </div>
        </div>
        <div class="dsc-disclaimer">内容由 AI 生成，请仔细甄别</div>
      </div>`;
  }

  function welcomeHTML() {
    return `
      <div class="dsc-welcome">
        <div class="dsc-hero">
          <img class="dsc-hero-logo" src="${asset('whale.svg')}" alt="">
          <h1 class="dsc-hero-title" data-role="hero-title">你好，我是 DeepSeek</h1>
        </div>
        ${composerHTML('welcome')}
      </div>`;
  }

  const messageHtmlCache = new WeakMap();

  function messageBodyHtml(message) {
    if (message.html) return message.html;
    if (!message.text || message.streaming) return '';
    let html = messageHtmlCache.get(message);
    if (html == null) {
      html = renderMarkdown(message.text);
      messageHtmlCache.set(message, html);
    }
    return html;
  }

  function branchSwitcherHTML(info) {
    if (!info || info.count < 2) return '';
    return `<div class="dsc-branch-row">
      <button class="dsc-branch-btn" type="button" data-act="branch-switch" data-branch-target="${escapeHtml(info.prev || '')}" ${info.prev ? '' : 'disabled'} aria-label="上一分支">‹</button>
      <span class="dsc-branch-count">${info.index}/${info.count}</span>
      <button class="dsc-branch-btn" type="button" data-act="branch-switch" data-branch-target="${escapeHtml(info.next || '')}" ${info.next ? '' : 'disabled'} aria-label="下一分支">›</button>
    </div>`;
  }

  function messageHTML(message, messageIndex, lastAssistantIndex, branchInfo, roundLocked) {
    if (message.role === 'user') {
      const files = Array.isArray(message.attachments) ? message.attachments : [];
      const images = Array.isArray(message.images)
        ? message.images.filter((image) => image && image.data && image.mediaType)
        : [];
      const filesHtml = files.length
        ? `<div class="dsc-msg-files">${files.map((file) => `
            <span class="dsc-file-chip${file.unsupported ? ' is-warn' : ''}" title="${escapeHtml(file.name)}${file.missing ? '（原件未导入）' : ''}">
              <span class="dsc-file-ico">${icon(file.kind === 'audio' ? 'mic' : 'paperclip', 14)}</span>
              <span class="dsc-file-name">${escapeHtml(file.name)}</span>
            </span>`).join('')}</div>`
        : '';
      const imagesHtml = images.length
        ? `<div class="dsc-msg-images">${images.map((image) => `
            <button class="dsc-msg-image" type="button" data-act="open-image" aria-label="查看图片：${escapeHtml(image.name || '图片')}">
              <img src="data:${escapeHtml(image.mediaType)};base64,${image.data}" alt="${escapeHtml(image.name || '图片')}">
            </button>`).join('')}</div>`
        : '';
      return `
        <article class="dsc-msg dsc-msg-user" data-message-index="${messageIndex}">
          <div class="dsc-user-stack">
            ${imagesHtml}
            ${message.text ? `<div class="dsc-bubble">${escapeHtml(message.text)}</div>` : ''}
            ${filesHtml}
          </div>
          <div class="dsc-actions dsc-user-actions">
            <button class="dsc-action dsc-tip" data-tip="复制" data-tip-side="bottom" data-act="copy" data-message-index="${messageIndex}" aria-label="复制">${icon('copy', 16)}</button>
            <button class="dsc-action dsc-tip${roundLocked ? ' is-unsupported' : ''}" data-tip="${roundLocked ? '本轮已有 TTS 语音，不能修改' : '编辑'}" data-tip-side="bottom" data-act="edit-message" data-message-index="${messageIndex}" aria-label="${roundLocked ? '本轮已有 TTS 语音，不能修改' : '编辑'}"${roundLocked ? ' disabled aria-disabled="true"' : ''}>${icon('edit', 16)}</button>
            <button class="dsc-action dsc-tip" data-tip="删除" data-tip-side="bottom" data-act="delete-message" data-message-index="${messageIndex}" aria-label="删除">${icon('trash', 16)}</button>
          </div>
          ${branchSwitcherHTML(branchInfo)}
        </article>`;
    }
    const body = messageBodyHtml(message);
    const activities = (message.activity || []).map((item) => {
      if (item.type === 'think') {
        const expanded = message.reasoningOpen === true;
        return `
          <div class="dsc-reasoning" data-expanded="${expanded ? '1' : '0'}">
            <button class="dsc-act-row dsc-reasoning-row" data-act="toggle-reasoning" data-message-index="${messageIndex}"
              aria-expanded="${expanded}" ${message.streaming ? 'data-streaming="1"' : ''}>
              <span class="dsc-act-ico">${icon('deepThink', 14)}</span>
              <span class="dsc-act-name">${escapeHtml(item.label || '思考')}</span>
              ${item.preview ? `<span class="dsc-act-sep" aria-hidden="true"></span><span class="dsc-act-preview">${escapeHtml(item.preview)}</span>` : ''}
            </button>
            ${expanded ? `<div class="dsc-reasoning-body">${renderMarkdown(message.reasoning)}</div>` : ''}
          </div>`;
      }
      return `
        <div class="dsc-act-row">
          <span class="dsc-act-ico">${icon(item.type === 'search' ? 'globe' : 'deepThink', 14)}</span>
          <span class="dsc-act-name">${escapeHtml(item.label)}</span>
          ${item.preview ? `<span class="dsc-act-sep" aria-hidden="true"></span><span class="dsc-act-preview">${escapeHtml(item.preview)}</span>` : ''}
        </div>`;
    }).join('');
    const elapsedSeconds = message.startedAt
      ? Math.max(1, Math.round((Date.now() - message.startedAt) / 1000))
      : 1;
    const runAction = message.reasoning
      ? ` data-act="toggle-reasoning" data-message-index="${messageIndex}"`
      : '';
    const running = message.streaming && !message.html && !message.error ? `
      <div class="dsc-run"${runAction}>
        <span class="dsc-run-ico">${icon('run', 16)}</span>
        <span>深度求索中，用时 <span data-run-seconds>${elapsedSeconds}</span>秒</span>
        <span class="dsc-run-ellipsis">…</span>
      </div>` : '';
    const cursor = message.streaming && body ? '<span class="dsc-stream-cursor" aria-hidden="true"></span>' : '';
    const error = message.error
      ? `<div class="dsc-msg-error">${escapeHtml(message.error)}</div>`
      : '';
    const stopped = message.stopped && !message.streaming && !message.error && !message.text
      ? '<div class="dsc-msg-stopped">已停止生成</div>'
      : '';
    const disclaimer = body && !message.streaming && !message.error
      ? '<div class="dsc-msg-disclaimer">本回答由 AI 生成，内容仅供参考，请仔细甄别</div>'
      : '';
    // Official only offers the full interaction set on the newest answer;
    // older answers keep just copy (regenerate on an old turn would need a
    // branch, which lands with the conversation tree).
    const latest = messageIndex === lastAssistantIndex;
    const ttsText = latest ? ttsSpeechText(message) : '';
    const ttsVoice = ttsVoiceGlobal === 'tide' ? 'tide' : 'stella';
    const ttsFlagged = Boolean(message.tts && message.tts[ttsVoice]);
    const ttsCached = ttsFlagged || (Boolean(ttsText)
      && ttsCachedKeys.has(ttsCacheKey(ttsText, ttsVoice)));
    const actions = body && !message.streaming && !message.error
      ? `<div class="dsc-actions">
          <button class="dsc-action dsc-tip" data-tip="复制" data-tip-side="bottom" data-act="copy" data-message-index="${messageIndex}" aria-label="复制">${icon('copy', 16)}</button>
          <button class="dsc-action dsc-tip" data-tip="重新生成" data-tip-side="bottom" data-act="regenerate" data-message-index="${messageIndex}" aria-label="重新生成">${icon('refresh', 16)}</button>
          <button class="dsc-action dsc-tip${roundLocked ? ' is-unsupported' : ''}" data-tip="${roundLocked ? '本轮已有 TTS 语音，不能修改' : '编辑'}" data-tip-side="bottom" data-act="edit-message" data-message-index="${messageIndex}" aria-label="${roundLocked ? '本轮已有 TTS 语音，不能修改' : '编辑'}"${roundLocked ? ' disabled aria-disabled="true"' : ''}>${icon('edit', 16)}</button>
          <button class="dsc-action dsc-tip" data-tip="删除" data-tip-side="bottom" data-act="delete-message" data-message-index="${messageIndex}" aria-label="删除">${icon('trash', 16)}</button>
          ${latest ? `
          <button class="dsc-action dsc-tip${ttsCached ? ' is-cached' : ''}${ttsReadyGlobal ? '' : ' is-unsupported'}" data-tip="${ttsReadyGlobal ? '朗读' : '需要 DeepSeek 官方 API'}" data-tip-side="bottom" data-act="read" aria-label="朗读">${icon('volume', 16)}</button>
          <button class="dsc-action dsc-tip" data-tip="分享" data-tip-side="bottom" data-act="share" aria-label="分享">${icon('share', 16)}</button>` : ''}
        </div>`
      : '';
    return `
      <article class="dsc-msg dsc-msg-assistant" data-message-index="${messageIndex}">
        ${activities ? `<div class="dsc-activity">${activities}</div>` : ''}
        ${body ? `<div class="dsc-md">${body}${cursor}</div>` : ''}
        ${running}
        ${message.cite ? `<div class="dsc-cite"><span class="dsc-cite-favicons"><span class="dsc-cite-favicon"></span><span class="dsc-cite-favicon"></span><span class="dsc-cite-favicon"></span><span class="dsc-cite-favicon"></span></span>${escapeHtml(message.cite)}</div>` : ''}
        ${sourcesHTML(message, messageIndex)}
        ${error}
        ${stopped}
        ${disclaimer}
        ${actions}
        ${branchSwitcherHTML(branchInfo)}
      </article>`;
  }

  function settingsHTML() {
    return `
      <div class="dsc-settings-overlay" data-role="settings" hidden>
        <div class="dsc-settings-card" role="dialog" aria-modal="true" aria-labelledby="dsc-settings-title">
          <div class="dsc-settings-head">
            <h2 class="dsc-settings-title" id="dsc-settings-title">设置</h2>
            <button class="dsc-icon-btn" data-act="settings-close" title="关闭" aria-label="关闭">${icon('close', 18)}</button>
          </div>
          <div class="dsc-settings-menu">
            <button class="dsc-settings-item" data-act="settings-import">
              <span class="dsc-settings-ico">${icon('importFile', 18)}</span>
              <span class="dsc-settings-text">
                <span class="dsc-settings-main">导入内容</span>
                <span class="dsc-settings-desc">从 DeepSeek 导出的 ZIP / JSON 恢复对话</span>
              </span>
            </button>
            <div class="dsc-import-link-block">
              <span class="dsc-import-link-label">${icon('share', 14)}<span>或粘贴导出链接</span></span>
              <div class="dsc-import-link-row">
                <input class="dsc-import-url" data-role="import-url" type="url" inputmode="url"
                  placeholder="https://…/deepseek_data-….zip" spellcheck="false" aria-label="DeepSeek 导出链接">
                <button class="dsc-import-go" data-act="import-link" type="button">下载并导入</button>
              </div>
              <span class="dsc-import-hint">导出链接 7 天有效；图片原件暂不导入</span>
            </div>
            <button class="dsc-settings-item" data-act="settings-export">
              <span class="dsc-settings-ico">${icon('share', 18)}</span>
              <span class="dsc-settings-text">
                <span class="dsc-settings-main">导出全部对话</span>
                <span class="dsc-settings-desc">仅文本，或连同已合成的 TTS 语音</span>
              </span>
            </button>
            <div class="dsc-settings-item is-static" data-role="last-import" hidden>
              <span class="dsc-settings-ico">${icon('importFile', 18)}</span>
              <span class="dsc-settings-text">
                <span class="dsc-settings-main">最近一次导入</span>
                <span class="dsc-settings-desc" data-role="last-import-desc">暂无导入记录</span>
              </span>
              <button class="dsc-settings-undo" data-act="undo-import" type="button" disabled>撤销</button>
            </div>
            <div class="dsc-settings-item is-static" data-role="legacy-import" hidden>
              <span class="dsc-settings-ico">${icon('trash', 16)}</span>
              <span class="dsc-settings-text">
                <span class="dsc-settings-main">历史导入</span>
                <span class="dsc-settings-desc" data-role="legacy-import-desc"></span>
              </span>
              <button class="dsc-settings-undo" data-act="clear-legacy-import" type="button">清理</button>
            </div>
            <button class="dsc-settings-item" data-act="open-capabilities" data-role="capability-row" aria-haspopup="dialog" aria-expanded="false">
              <span class="dsc-settings-ico">${icon('eye', 18)}</span>
              <span class="dsc-settings-text">
                <span class="dsc-settings-main">应用能力</span>
                <span class="dsc-settings-desc" data-role="capability-desc">识图 · 语音输入 · 语音输出 · 联网搜索</span>
              </span>
              <span class="dsc-settings-chevron" aria-hidden="true">${icon('chevronDown', 14)}</span>
            </button>
            <div class="dsc-settings-item is-static">
              <span class="dsc-settings-ico">${icon('volume', 16)}</span>
              <span class="dsc-settings-text">
                <span class="dsc-settings-main">TTS 音色</span>
                <span class="dsc-settings-desc">朗读使用的 DeepSeek 语音</span>
              </span>
              <span class="dsc-voice-switch" role="radiogroup" aria-label="TTS 音色">
                <span class="dsc-voice-thumb" aria-hidden="true"></span>
                <button class="dsc-voice-option" data-tts-voice="stella" role="radio" aria-checked="true">星海 · 女声</button>
                <button class="dsc-voice-option" data-tts-voice="tide" role="radio" aria-checked="false">暗潮 · 男声</button>
              </span>
            </div>
            <button class="dsc-settings-item" data-act="settings-readme" aria-haspopup="dialog">
              <span class="dsc-settings-ico">${icon('info', 18)}</span>
              <span class="dsc-settings-text">
                <span class="dsc-settings-main">README</span>
                <span class="dsc-settings-desc">项目说明、使用文档与 MIT 许可</span>
              </span>
              <span class="dsc-settings-badge">MIT</span>
              <span class="dsc-settings-chevron" aria-hidden="true">${icon('chevronDown', 14)}</span>
            </button>
          </div>
        </div>
      </div>
      <div class="dsc-readme-overlay" data-role="readme" hidden>
        <div class="dsc-readme-card" role="dialog" aria-modal="true" aria-labelledby="dsc-readme-title">
          <div class="dsc-readme-head">
            <div class="dsc-readme-heading">
              <h2 class="dsc-readme-title" id="dsc-readme-title">README</h2>
              <span class="dsc-readme-meta" data-role="readme-meta">DSH Chat with DeepSeek · MIT</span>
            </div>
            <button class="dsc-icon-btn" data-act="readme-close" title="关闭" aria-label="关闭">${icon('close', 18)}</button>
          </div>
          <div class="dsc-readme-body" data-role="readme-body">
            <div class="dsc-readme-loading">正在读取 README…</div>
          </div>
        </div>
      </div>`;
  }

  function shellHTML() {
    return `
      ${sidebarHTML()}
      <main class="dsc-main">
        ${topbarHTML()}
        <div class="dsc-stage">
          ${welcomeHTML()}
          <div class="dsc-messages" hidden></div>
        </div>
        <div class="dsc-rail-wrap" data-role="rail" hidden>
          <div class="dsc-rail" data-role="rail-list"></div>
          <div class="dsc-rail-tip" data-role="rail-tip" hidden></div>
        </div>
        <div class="dsc-dock" hidden>
          ${composerHTML('dock')}
        </div>
      </main>
      <div class="dsc-search-overlay" hidden data-role="search-overlay">
        <div class="dsc-search-card">
          <div class="dsc-search-row">
            ${icon('searchOutline', 16)}
            <input type="text" placeholder="搜索对话内容..." aria-label="搜索对话内容" data-role="search-input">
            <div class="dsc-search-divider"></div>
            <button class="dsc-icon-btn" data-act="close-search" title="关闭" aria-label="关闭">${icon('close', 16)}</button>
          </div>
          <div class="dsc-search-results" data-role="search-results"></div>
        </div>
      </div>
      <div class="dsc-think-pop" data-role="think-pop" role="menu" aria-label="选择思考强度" hidden>
        <div data-role="think-options"></div>
      </div>
      <div class="dsc-think-pop dsc-search-pop" data-role="search-pop" role="menu" aria-label="联网搜索模式" hidden>
        <div data-role="search-options"></div>
      </div>
      ${settingsHTML()}
      <div class="dsc-cap-pop" data-role="capability-pop" role="dialog" aria-label="应用能力" hidden>
        <div class="dsc-cap-head">应用能力</div>
        <div class="dsc-cap-item">
          <span class="dsc-cap-ico">${icon('eye', 16)}</span>
          <span class="dsc-cap-text"><span class="dsc-cap-main">默认识图模型</span><span class="dsc-cap-desc">当前模型不支持识图时委派</span></span>
          <select class="dsc-settings-select" data-setting="vision" aria-label="默认识图模型"></select>
        </div>
        <div class="dsc-cap-item">
          <span class="dsc-cap-ico">${icon('mic', 16)}</span>
          <span class="dsc-cap-text"><span class="dsc-cap-main">语音输入模型</span><span class="dsc-cap-desc">语音识别转文字</span></span>
          <select class="dsc-settings-select" data-setting="asr" aria-label="语音输入模型"></select>
        </div>
        <div class="dsc-cap-item">
          <span class="dsc-cap-ico">${icon('volume', 16)}</span>
          <span class="dsc-cap-text"><span class="dsc-cap-main">语音输出模型</span><span class="dsc-cap-desc">朗读使用 DeepSeek 语音合成</span></span>
          <select class="dsc-settings-select" data-setting="tts" aria-label="语音输出模型"></select>
        </div>
        <div class="dsc-cap-item">
          <span class="dsc-cap-ico">${icon('globe', 16)}</span>
          <span class="dsc-cap-text"><span class="dsc-cap-main">联网搜索提供商</span><span class="dsc-cap-desc">官方工具或 DSH 模型子 Agent</span></span>
          <select class="dsc-settings-select" data-setting="search" aria-label="联网搜索提供商"></select>
        </div>
      </div>
      <div class="dsc-import-overlay" data-role="export-preview" hidden>
        <div class="dsc-import-card" role="dialog" aria-modal="true" aria-labelledby="dsc-export-title">
          <div class="dsc-import-head">
            <div>
              <h2 class="dsc-import-title" id="dsc-export-title">导出全部对话</h2>
              <p class="dsc-import-sub" data-role="export-summary">正在统计…</p>
            </div>
            <button class="dsc-icon-btn" data-act="export-close" title="关闭" aria-label="关闭">${icon('close', 18)}</button>
          </div>
          <div class="dsc-export-options">
            <button class="dsc-export-option" data-act="export-mode" data-export-mode="text" type="button">
              <span class="dsc-export-option-title">仅文本</span>
              <span class="dsc-export-option-desc">标准 DeepSeek v3 ZIP，可导回官方 chat-demo 或本插件</span>
            </button>
            <button class="dsc-export-option" data-act="export-mode" data-export-mode="tts" type="button">
              <span class="dsc-export-option-title">文本 + TTS 语音</span>
              <span class="dsc-export-option-desc" data-role="export-tts-desc">附带已合成 WAV；官方导入器会忽略扩展目录</span>
            </button>
          </div>
          <div class="dsc-import-foot">
            <span class="dsc-import-count" data-role="export-count"></span>
            <button class="dsc-import-cancel" data-act="export-cancel" type="button">取消</button>
          </div>
        </div>
      </div>
      <div class="dsc-import-overlay" data-role="import-preview" hidden>
        <div class="dsc-import-card" role="dialog" aria-modal="true" aria-labelledby="dsc-import-title">
          <div class="dsc-import-head">
            <div>
              <h2 class="dsc-import-title" id="dsc-import-title">导入对话</h2>
              <p class="dsc-import-sub" data-role="import-summary">发现 0 个对话</p>
            </div>
            <button class="dsc-icon-btn" data-act="import-preview-close" title="关闭" aria-label="关闭">${icon('close', 18)}</button>
          </div>
          <div class="dsc-import-toolbar">
            <input class="dsc-import-search" data-role="import-search" placeholder="搜索标题…" spellcheck="false" aria-label="搜索导入的对话">
            <button class="dsc-import-select" data-act="import-select-all" type="button">全选</button>
            <button class="dsc-import-select" data-act="import-select-none" type="button">清空</button>
          </div>
          <div class="dsc-import-list" data-role="import-list" aria-label="待导入对话"></div>
          <div class="dsc-import-foot">
            <span class="dsc-import-count" data-role="import-selected-count">已选 0 个</span>
            <div class="dsc-import-actions">
              <button class="dsc-import-cancel" data-act="import-preview-cancel" type="button">取消</button>
              <button class="dsc-import-go" data-act="import-preview-confirm" type="button" disabled>导入选中的 0 个</button>
            </div>
          </div>
        </div>
      </div>
      <div class="dsc-edit-overlay" data-role="edit-message" hidden>
        <div class="dsc-edit-card" role="dialog" aria-modal="true" aria-labelledby="dsc-edit-title">
          <h2 class="dsc-edit-title" id="dsc-edit-title" data-role="edit-title">编辑消息</h2>
          <p class="dsc-edit-hint" data-role="edit-hint"></p>
          <textarea class="dsc-edit-text" data-role="edit-text" spellcheck="false" aria-label="编辑消息内容"></textarea>
          <div class="dsc-edit-actions">
            <button class="dsc-import-cancel" type="button" data-act="edit-cancel">取消</button>
            <button class="dsc-import-go" type="button" data-act="edit-save">保存</button>
          </div>
        </div>
      </div>
      <div class="dsc-dialog-overlay" data-role="dialog" hidden>
        <div class="dsc-dialog-card" role="dialog" aria-modal="true" aria-labelledby="dsc-dialog-title">
          <h3 class="dsc-dialog-title" id="dsc-dialog-title" data-role="dialog-title"></h3>
          <p class="dsc-dialog-desc" data-role="dialog-desc" hidden></p>
          <div class="dsc-dialog-actions">
            <button class="dsc-dialog-btn" data-act="dialog-cancel">取消</button>
            <button class="dsc-dialog-btn is-primary" data-act="dialog-confirm">置顶</button>
          </div>
        </div>
      </div>
      <div class="dsc-think-pop dsc-model-pop" data-role="model-pop" role="menu" aria-label="选择模型" hidden>
        <div data-role="model-options"></div>
      </div>
      <div class="dsc-session-menu" data-role="session-menu" role="menu" aria-label="对话操作" hidden></div>
      <input type="file" data-role="import-file" accept=".zip,.json,application/zip,application/json" hidden>
      <input type="file" data-role="attach-file" multiple hidden>
      <div class="dsc-toast" data-role="toast">
        <span class="dsc-toast-check" data-role="toast-check" aria-hidden="true" hidden>${icon('check', 12)}</span>
        <span data-role="toast-text"></span>
        <button class="dsc-toast-action" data-role="toast-action" type="button" hidden></button>
      </div>
      <div class="dsc-image-viewer" data-role="image-viewer" hidden>
        <img data-role="image-viewer-img" alt="">
      </div>`;
  }

  function initialSearchMode() {
    try {
      const stored = localStorage.getItem('dsc.searchMode');
      if (stored === 'off') return 'off';
      if (stored === 'fast' || stored === 'precise' || stored === 'on') return 'on';
      return localStorage.getItem('dsc.searchOn') === '1' ? 'on' : 'off';
    } catch {
      return 'off';
    }
  }

  function mount(el, options) {
    const opts = options || {};
    const controller = new AbortController();
    const { signal } = controller;
    const timers = new Set();

    const sidebarKey = opts.surface === 'dsh' ? 'dsc.sidebar.dsh' : 'dsc.sidebar';
    if (opts.surface === 'dsh') {
      try {
        if (localStorage.getItem('dsc.sidebar.dsh.version') !== '3') {
          localStorage.setItem(sidebarKey, 'expanded');
          localStorage.setItem('dsc.sidebar.dsh.version', '3');
        }
      } catch { /* ignore */ }
    }
    const state = {
      view: 'welcome',
      sidebar: localStorage.getItem(sidebarKey) === 'collapsed' ? 'collapsed' : 'expanded',
      activeId: null,
      sessions: readStoredSessions(),
      messages: [],
      selectMode: false,
      selected: new Set(),
      sessionMenuId: null,
      menuDeleteArmed: false,
      renamingId: null,
      thinking: initialThinking(),
      thinkingSupported: true,
      searchMode: initialSearchMode(),
      searchOn: initialSearchMode() !== 'off',
      lastUsedModel: localStorage.getItem('dsc.lastModel') || '',
      lastUsedProvider: localStorage.getItem('dsc.lastProvider') || '',
      findOn: false,
      findQuery: '',
      findMatches: [],
      findSel: 0,
      findDraft: '',
      ttsVoice: localStorage.getItem('dsc.ttsVoice') === 'tide' ? 'tide' : 'stella',
      visionModel: localStorage.getItem('dsc.visionModel') || '',
      ttsModel: localStorage.getItem('dsc.ttsModel') || 'deepseek-flash',
      asrModel: localStorage.getItem('dsc.asrModel') || 'deepseek-flash',
      searchProvider: (() => {
        const stored = localStorage.getItem('dsc.searchProvider');
        return !stored || stored === 'deepseek' ? 'official' : stored;
      })(),
      busy: false,
      // #quota is a standalone preview only; inside DSH it must never mask
      // the real, working conversation surface.
      quota: opts.surface !== 'dsh' && location.hash === '#quota',
      theme: opts.surface === 'dsh'
        ? (opts.theme === 'dark' ? 'dark' : 'light')
        : (localStorage.getItem('dsc.theme') || 'light'),
      account: opts.account || null,
      api: {
        available: opts.surface === 'dsh',
        loaded: opts.surface !== 'dsh',
        configured: false,
        authSource: null,
        baseUrl: 'https://api.deepseek.com/anthropic',
        provider: '',
        model: 'deepseek-flash',
        models: [],
        searchSupported: false,
        fetchSupported: false,
        officialReady: false,
        ttsReady: false,
        asrReady: false,
        imageModels: [],
        error: '',
      },
    };

    const root = document.createElement('div');
    root.className = 'dsc-root';
    root.dataset.sidebar = state.sidebar;
    root.dataset.view = state.view;
    root.dataset.theme = state.theme;
    root.dataset.embedded = opts.surface === 'dsh' ? '1' : '0';
    bootShiki();
    root.dataset.select = '0';
    root.dataset.sidebarPhase = 'idle';
    root.innerHTML = shellHTML();
    el.innerHTML = '';
    el.appendChild(root);

    const $ = (selector, from) => (from || root).querySelector(selector);
    const $$ = (selector, from) => Array.from((from || root).querySelectorAll(selector));
    const sessionsEl = $('.dsc-sessions');
    const messagesEl = $('.dsc-messages');
    const railWrap = $('[data-role="rail"]');
    const railList = $('[data-role="rail-list"]');
    const railTip = $('[data-role="rail-tip"]');
    const stageEl = $('.dsc-stage');
    const dockEl = $('.dsc-dock');
    const overlayEl = $('[data-role="search-overlay"]');
    const searchInput = $('[data-role="search-input"]');
    const searchResults = $('[data-role="search-results"]');
    const toastEl = $('[data-role="toast"]');
    const toastTextEl = $('[data-role="toast-text"]');
    const toastCheck = $('[data-role="toast-check"]');
    const imageViewerEl = $('[data-role="image-viewer"]');
    const imageViewerImg = $('[data-role="image-viewer-img"]');
    const dialogEl = $('[data-role="dialog"]');
    const dialogTitle = $('[data-role="dialog-title"]');
    const dialogDesc = $('[data-role="dialog-desc"]');
    const dialogConfirm = $('[data-act="dialog-confirm"]');
    const dialogCancel = $('[data-act="dialog-cancel"]');
    const selectTitleEl = $('[data-role="select-title"]');
    const titleEl = $('[data-role="title"]');
    const heroTitle = $('[data-role="hero-title"]');
    const thinkPop = $('[data-role="think-pop"]');
    const thinkOptions = $('[data-role="think-options"]');
    const searchPop = $('[data-role="search-pop"]');
    const searchOptionsEl = $('[data-role="search-options"]');
    const modelPop = $('[data-role="model-pop"]');
    const modelOptions = $('[data-role="model-options"]');
    const settingsEl = $('[data-role="settings"]');
    const editOverlay = $('[data-role="edit-message"]');
    const editTitle = $('[data-role="edit-title"]');
    const editHint = $('[data-role="edit-hint"]');
    const editText = $('[data-role="edit-text"]');
    let editMessageState = null;
    let pendingMessageDelete = null;
    const sessionMenuEl = $('[data-role="session-menu"]');
    const importFileEl = $('[data-role="import-file"]');
    const importUrlEl = $('[data-role="import-url"]');
    const importLinkButton = $('[data-act="import-link"]');
    const capabilityPop = $('[data-role="capability-pop"]');
    const capabilityRow = $('[data-role="capability-row"]');
    const importPreviewEl = $('[data-role="import-preview"]');
    const exportPreviewEl = $('[data-role="export-preview"]');
    const exportSummaryEl = $('[data-role="export-summary"]');
    const exportCountEl = $('[data-role="export-count"]');
    const exportTtsDescEl = $('[data-role="export-tts-desc"]');
    const readmeEl = $('[data-role="readme"]');
    const readmeBodyEl = $('[data-role="readme-body"]');
    let readmeMarkdown = '';
    let readmeVersion = '0.6.1';
    let readmeLoading = null;
    let readmeCloseTimer = null;
    let exportState = null;
    const importSummaryEl = $('[data-role="import-summary"]');
    const importListEl = $('[data-role="import-list"]');
    const importSearchEl = $('[data-role="import-search"]');
    const importSelectedCountEl = $('[data-role="import-selected-count"]');
    const importConfirmButton = $('[data-act="import-preview-confirm"]');
    const toastActionEl = $('[data-role="toast-action"]');
    let toastActionHandler = null;
    let importPreviewState = null;
    const attachFileEl = $('[data-role="attach-file"]');
    let thinkTrigger = null;
    let modelTrigger = null;
    let searchTrigger = null;
    let menuDeleteTimer = null;
    let toastTimer = null;
    let sidebarTimer = null;
    let dialogMode = null;
    let dialogIds = [];
    let dialogBatchId = null;
    let dialogCloseTimer = null;
    let settingsCloseTimer = null;

    // One stream per conversation. Switching conversations must neither block
    // nor cancel a reply still running in another one.
    const streams = new Map();
    let stickToBottom = true;

    function activeStream() {
      return state.activeId ? streams.get(state.activeId) || null : null;
    }

    function syncBusy() {
      state.busy = Boolean(activeStream());
    }

    function abortSessionStream(id) {
      const stream = streams.get(id);
      if (!stream) return;
      streams.delete(id);
      if (stream.frame) cancelAnimationFrame(stream.frame);
      if (stream.tick) {
        clearInterval(stream.tick);
        timers.delete(stream.tick);
      }
      if (stream.demoTimer) {
        clearTimeout(stream.demoTimer);
        timers.delete(stream.demoTimer);
      }
      try { stream.controller?.abort(); } catch { /* already gone */ }
      syncBusy();
    }

    $$('[data-act="select-work"]').forEach((button) => {
      button.hidden = typeof opts.onSelectWork !== 'function';
    });

    function remember(key, value) {
      try { localStorage.setItem(key, value); } catch { /* ignore */ }
    }

    function initials(name) {
      const text = String(name || '').trim();
      if (!text) return 'DS';
      const chars = Array.from(text);
      return chars.slice(0, 2).join('').toUpperCase();
    }

    function renderAccount() {
      const fallback = opts.surface === 'dsh' ? 'DeepSeek 用户' : 'JNGKZbird';
      const name = state.account?.name || fallback;
      const avatarUrl = state.account?.avatarUrl || '';
      const nameEl = $('[data-role="account-name"]');
      const avatarEl = $('[data-role="avatar"]');
      if (nameEl) nameEl.textContent = name;
      if (!avatarEl) return;
      if (avatarUrl) {
        avatarEl.innerHTML = `<img src="${escapeHtml(avatarUrl)}" alt="" referrerpolicy="no-referrer">`;
        const image = avatarEl.querySelector('img');
        if (image) image.addEventListener('error', () => {
          avatarEl.textContent = initials(name);
        }, { once: true });
      } else {
        avatarEl.textContent = initials(name);
      }
    }

    function hideToast() {
      toastEl.classList.remove('show');
      if (toastCheck) toastCheck.hidden = true;
      if (toastActionEl) toastActionEl.hidden = true;
      toastActionHandler = null;
      if (toastTimer) {
        clearTimeout(toastTimer);
        timers.delete(toastTimer);
        toastTimer = null;
      }
    }

    function showToast(text, options = {}) {
      const success = options.success === true;
      const top = options.top === true;
      const action = options.action && typeof options.action === 'object' ? options.action : null;
      if (toastTimer) {
        clearTimeout(toastTimer);
        timers.delete(toastTimer);
        toastTimer = null;
      }
      toastTextEl.textContent = text;
      toastEl.classList.toggle('is-success', success);
      toastEl.classList.toggle('is-top', top);
      if (toastCheck) toastCheck.hidden = !success;
      if (toastActionEl) {
        toastActionEl.hidden = !action;
        toastActionEl.textContent = action?.label || '';
        toastActionHandler = typeof action?.onClick === 'function' ? action.onClick : null;
      }
      toastEl.classList.add('show');
      const duration = Number(options.duration) || (action ? 10_000 : 1800);
      toastTimer = setTimeout(() => {
        toastEl.classList.remove('show');
        if (toastActionEl) toastActionEl.hidden = true;
        toastActionHandler = null;
        timers.delete(toastTimer);
        toastTimer = null;
      }, duration);
      timers.add(toastTimer);
    }

    // ---- read aloud: DeepSeek TTS only ------------------------------
    let ttsAbort = null;
    let ttsAudio = null;
    let ttsUrl = null;
    let ttsPlayingVoice = null;
    let ttsGeneration = 0;
    let readLockArmTimer = null;
    let ttsCacheKeysLoaded = false;
    let hostHydrated = false;
    let ttsDbPromise = null;

    function openTtsDb() {
      if (ttsDbPromise) return ttsDbPromise;
      ttsDbPromise = new Promise((resolve) => {
        try {
          const request = indexedDB.open('dsc-tts', 1);
          request.onupgradeneeded = () => request.result.createObjectStore('audio');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      });
      return ttsDbPromise;
    }

    async function ttsCacheGet(key) {
      const db = await openTtsDb();
      if (!db) return null;
      return new Promise((resolve) => {
        try {
          const request = db.transaction('audio', 'readonly').objectStore('audio').get(key);
          request.onsuccess = () => resolve(request.result?.blob || null);
          request.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      });
    }

    async function ttsCachePut(key, blob) {
      const db = await openTtsDb();
      if (!db) return;
      await new Promise((resolve) => {
        try {
          const tx = db.transaction('audio', 'readwrite');
          tx.objectStore('audio').put({ blob, at: Date.now() }, key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        } catch {
          resolve();
        }
      });
      ttsCachedKeys.add(key);
      try {
        const entries = [];
        const tx = db.transaction('audio', 'readwrite');
        const store = tx.objectStore('audio');
        store.openCursor().onsuccess = (event) => {
          const cursor = event.target.result;
          if (cursor) {
            entries.push([cursor.key, cursor.value?.at || 0]);
            cursor.continue();
            return;
          }
          if (entries.length > 40) {
            entries.sort((a, b) => a[1] - b[1]);
            for (const [oldKey] of entries.slice(0, entries.length - 40)) store.delete(oldKey);
          }
        };
      } catch { /* pruning is best-effort */ }
    }

    // Older synthesis runs may predate the persisted message.tts flag. Once
    // both the cache keys and the host sessions are in, map keys back onto
    // messages so the read button stays blue after a reload.
    function backfillTtsFlags() {
      if (!ttsCacheKeysLoaded || !hostHydrated) return;
      let changed = false;
      for (const session of state.sessions) {
        for (const message of session.messages || []) {
          if (message.role !== 'assistant') continue;
          const text = ttsSpeechText(message);
          if (!text) continue;
          const flags = message.tts || {};
          if (ttsCachedKeys.has(ttsCacheKey(text, 'stella'))) flags.stella = true;
          if (ttsCachedKeys.has(ttsCacheKey(text, 'tide'))) flags.tide = true;
          if (flags.stella || flags.tide) {
            message.tts = flags;
            changed = true;
          }
        }
      }
      if (changed) {
        storeSessions(state.sessions);
        if (state.view === 'chat') renderMessages();
      }
    }

    async function pruneTtsCache() {
      const db = await openTtsDb();
      if (!db) return 0;
      const keep = new Set();
      for (const session of state.sessions) {
        const nodes = Array.isArray(session.tree) && session.tree.length
          ? session.tree
          : (session.messages || []);
        for (const message of nodes) {
          if (!message || message.role !== 'assistant') continue;
          const text = ttsSpeechText(message);
          if (!text) continue;
          keep.add(ttsCacheKey(text, 'stella'));
          keep.add(ttsCacheKey(text, 'tide'));
        }
      }
      const keys = await new Promise((resolve) => {
        try {
          const request = db.transaction('audio', 'readonly').objectStore('audio').getAllKeys();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => resolve([]);
        } catch {
          resolve([]);
        }
      });
      const remove = keys.filter((key) => !keep.has(key));
      if (!remove.length) return 0;
      await new Promise((resolve) => {
        try {
          const tx = db.transaction('audio', 'readwrite');
          const store = tx.objectStore('audio');
          for (const key of remove) {
            store.delete(key);
            ttsCachedKeys.delete(key);
          }
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        } catch {
          resolve();
        }
      });
      return remove.length;
    }

    async function loadTtsCacheKeys() {
      const db = await openTtsDb();
      if (!db) return;
      try {
        const keys = await new Promise((resolve) => {
          const request = db.transaction('audio', 'readonly').objectStore('audio').getAllKeys();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => resolve([]);
        });
        for (const key of keys) ttsCachedKeys.add(key);
        ttsCacheKeysLoaded = true;
        backfillTtsFlags();
        if (state.view === 'chat') renderMessages();
      } catch { /* cache is optional */ }
    }

    function clearReadLockArm() {
      if (readLockArmTimer) {
        clearTimeout(readLockArmTimer);
        timers.delete(readLockArmTimer);
        readLockArmTimer = null;
      }
      $$('.dsc-action.is-lock-armed').forEach((button) => {
        button.classList.remove('is-lock-armed');
        delete button.dataset.ttsLockArmed;
        if (!button.classList.contains('is-reading')) {
          button.dataset.tip = '朗读';
          button.setAttribute('aria-label', '朗读');
        }
      });
    }

    function resetReadButtons() {
      $$('.dsc-action.is-reading').forEach((btn) => {
        btn.classList.remove('is-reading');
        btn.innerHTML = icon('volume', 18);
        btn.setAttribute('aria-label', '朗读');
        btn.dataset.tip = '朗读';
      });
    }

    function stopSpeech() {
      clearReadLockArm();
      if (ttsAbort) {
        try { ttsAbort.abort(); } catch { /* ignore */ }
        ttsAbort = null;
      }
      if (ttsAudio) {
        const audio = ttsAudio;
        ttsAudio = null;
        audio.onended = null;
        audio.onerror = null;
        try { audio.pause(); } catch { /* ignore */ }
        audio.src = '';
      }
      if (ttsUrl) {
        try { URL.revokeObjectURL(ttsUrl); } catch { /* ignore */ }
        ttsUrl = null;
      }
      ttsPlayingVoice = null;
      ttsGeneration += 1;
      resetReadButtons();
    }

    function markReading(button) {
      button.classList.add('is-reading');
      button.innerHTML = '<span class="dsc-tts-bars" aria-hidden="true"><i></i><i></i><i></i><i></i></span>';
      button.setAttribute('aria-label', '停止朗读');
      button.dataset.tip = '停止朗读';
    }

    function playTtsBlob(blob) {
      const url = URL.createObjectURL(blob);
      ttsUrl = url;
      const audio = new Audio(url);
      ttsAudio = audio;
      // Clearing the src in stopSpeech() can fire a late error event; ignore
      // anything that arrives after this playback was stopped/replaced.
      audio.onended = () => {
        if (ttsAudio === audio) stopSpeech();
      };
      audio.onerror = () => {
        if (ttsAudio !== audio) return;
        showToast('语音播放失败');
        stopSpeech();
      };
      audio.play().catch(() => {
        if (ttsAudio !== audio) return;
        showToast('语音播放失败');
        stopSpeech();
      });
    }

    function refreshRoundEditLocks() {
      const locks = computeRoundLocks(sessionById(state.activeId));
      state.messages.forEach((message, index) => {
        const button = messagesEl.querySelector(`.dsc-action[data-act="edit-message"][data-message-index="${index}"]`);
        if (!button) return;
        const locked = locks.has(message.id);
        button.disabled = locked;
        button.classList.toggle('is-unsupported', locked);
        button.dataset.tip = locked ? '本轮已有 TTS 语音，不能修改' : '编辑';
        button.setAttribute('aria-label', locked ? '本轮已有 TTS 语音，不能修改' : '编辑');
      });
    }

    function markCachedReadButton() {
      const readButton = document.querySelector('.dsc-action[data-act="read"]');
      if (!readButton) return;
      readButton.classList.add('is-cached');
      // Blue carries the cached state; the label stays the plain 朗读.
      if (!readButton.classList.contains('is-reading')) readButton.dataset.tip = '朗读';
    }

    async function toggleReadAloud(button) {
      if (!ttsReadyGlobal) {
        showToast('朗读需要 DeepSeek 官方 API');
        return;
      }
      // One audio at a time: clicking the playing button stops it when the
      // voice is unchanged; a different voice replaces (stops then plays).
      if (button.classList.contains('is-reading') && ttsPlayingVoice === state.ttsVoice) {
        stopSpeech();
        return;
      }
      const lastAssistant = [...state.messages].reverse().find((item) => item.role === 'assistant');
      const text = ttsSpeechText(lastAssistant);
      if (!text) return;
      const session = sessionById(state.activeId);
      const sessionId = state.activeId;
      const voice = state.ttsVoice;
      const cachedCurrent = Boolean(lastAssistant?.tts?.[voice])
        || ttsCachedKeys.has(ttsCacheKey(text, voice));
      const lockedRound = isRoundLocked(session, lastAssistant);
      if (!lockedRound && !cachedCurrent) {
        if (button.dataset.ttsLockArmed !== '1') {
          clearReadLockArm();
          button.dataset.ttsLockArmed = '1';
          button.classList.add('is-lock-armed');
          button.dataset.tip = '再点一次：生成语音后本轮不可编辑';
          button.setAttribute('aria-label', '再点一次：生成语音后本轮不可编辑');
          showToast('再点一次生成语音；本轮将锁定编辑');
          readLockArmTimer = setTimeout(() => {
            readLockArmTimer = null;
            clearReadLockArm();
          }, 3000);
          timers.add(readLockArmTimer);
          return;
        }
        clearReadLockArm();
      } else {
        clearReadLockArm();
      }
      stopSpeech();
      markReading(button);
      ttsPlayingVoice = voice;
      const generation = ttsGeneration;
      const cacheKey = ttsCacheKey(text, voice);
      const markMessageTts = () => {
        if (!lastAssistant) return;
        lastAssistant.tts = { ...(lastAssistant.tts || {}), [voice]: true };
        const session = sessionById(state.activeId);
        if (session) {
          session.messages = state.messages;
          storeSessions(state.sessions);
          renderSessions();
        }
        refreshRoundEditLocks();
        markCachedReadButton();
      };
      const cached = await ttsCacheGet(cacheKey);
      if (generation !== ttsGeneration) return;
      if (cached) {
        markMessageTts();
        playTtsBlob(cached);
        return;
      }
      showToast('正在合成语音…');
      const controller = new AbortController();
      ttsAbort = controller;
      try {
        const response = await fetch(new URL('tts', API_BASE), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, voiceId: voice }),
          signal: controller.signal,
        });
        if (response.status === 404 || response.status === 501) {
          stopSpeech();
          showToast('当前环境未接入语音合成，朗读不可用');
          return;
        }
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.message || `语音合成失败（HTTP ${response.status}）`);
        }
        const blob = await response.blob();
        if (controller.signal.aborted || generation !== ttsGeneration) return;
        ttsAbort = null;
        await ttsCachePut(cacheKey, blob);
        if (generation !== ttsGeneration) return;
        markMessageTts();
        markCachedReadButton();
        playTtsBlob(blob);
      } catch (error) {
        if (controller.signal.aborted) return;
        stopSpeech();
        showToast(error instanceof Error ? error.message : String(error));
      }
    }

    function openImageViewer(src, alt) {
      if (!imageViewerEl || !imageViewerImg || !src) return;
      imageViewerImg.src = src;
      imageViewerImg.alt = alt || '图片';
      imageViewerEl.hidden = false;
      requestAnimationFrame(() => imageViewerEl.classList.add('show'));
    }

    function closeImageViewer() {
      if (!imageViewerEl || imageViewerEl.hidden) return;
      imageViewerEl.classList.remove('show');
      const timer = setTimeout(() => {
        timers.delete(timer);
        imageViewerEl.hidden = true;
        imageViewerImg?.removeAttribute('src');
      }, 140);
      timers.add(timer);
    }

    // ---- attachments (client-side extraction) -------------------------
    let pendingAttachments = [];
    let attachGeneration = 0;
    let attachHistory = [];

    function recordAttachAction(action) {
      attachHistory.push(action);
      if (attachHistory.length > 20) attachHistory.shift();
    }

    function undoAttachmentAction() {
      const action = attachHistory.pop();
      if (!action) return false;
      if (action.type === 'add') {
        const before = pendingAttachments.length;
        pendingAttachments = pendingAttachments.filter((item) => item.id !== action.id);
        if (pendingAttachments.length === before) return false;
      } else {
        if (pendingAttachments.some((item) => item.id === action.item.id)) return false;
        pendingAttachments.splice(Math.min(action.index, pendingAttachments.length), 0, action.item);
      }
      renderAttachmentStrips();
      showToast(action.type === 'add' ? '已撤销添加附件' : '已恢复附件');
      return true;
    }

    function attachmentKind(ext) {
      if (ext === 'pdf') return 'pdf';
      if (ATTACH_IMAGE_EXTS.has(ext)) return 'image';
      if (ATTACH_AUDIO_EXTS.has(ext)) return 'audio';
      if (ATTACH_OFFICE_EXTS.has(ext)) return 'office';
      if (ATTACH_LEGACY_OFFICE_EXTS.has(ext)) return 'legacy';
      return 'text';
    }

    function formatBytes(size) {
      const value = Number(size) || 0;
      if (value < 1024) return `${value} B`;
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
      return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    }

    // true = declared image input, false = declared text-only,
    // null = DSH did not expose capabilities (attempt the image anyway).
    function modelImageSupport() {
      const models = state.api.models || [];
      const model = models.find((item) => item.id === state.api.model
        && (!state.api.provider || item.provider === state.api.provider))
        || models.find((item) => item.id === state.api.model);
      const modalities = model?.inputModalities;
      if (!Array.isArray(modalities) || modalities.length === 0) return null;
      return modalities.includes('image');
    }

    async function readTextAttachment(file) {
      const buffer = await file.arrayBuffer();
      let text = new TextDecoder('utf-8').decode(buffer);
      const bad = (text.match(/�/g) || []).length;
      if (bad > Math.max(4, text.length * 0.01)) {
        try { text = new TextDecoder('gbk').decode(buffer); } catch { /* keep utf-8 */ }
      }
      return text;
    }

    async function extractDocx(file) {
      const zip = await window.JSZip.loadAsync(await file.arrayBuffer());
      const entry = zip.file('word/document.xml');
      if (!entry) throw new Error('缺少 word/document.xml');
      const doc = new DOMParser().parseFromString(await entry.async('string'), 'application/xml');
      return [...doc.getElementsByTagName('w:p')].map((paragraph) => (
        [...paragraph.getElementsByTagName('w:t')].map((node) => node.textContent || '').join('')
      )).join('\n').trim();
    }

    async function extractPptx(file) {
      const zip = await window.JSZip.loadAsync(await file.arrayBuffer());
      const slides = Object.keys(zip.files)
        .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
        .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]));
      const pages = [];
      for (const name of slides) {
        const doc = new DOMParser().parseFromString(await zip.file(name).async('string'), 'application/xml');
        const text = [...doc.getElementsByTagName('a:t')].map((node) => node.textContent || '').join(' ').trim();
        if (text) pages.push(text);
      }
      return pages.join('\n\n').trim();
    }

    async function extractXlsx(file) {
      const zip = await window.JSZip.loadAsync(await file.arrayBuffer());
      const shared = [];
      const sharedEntry = zip.file('xl/sharedStrings.xml');
      if (sharedEntry) {
        const doc = new DOMParser().parseFromString(await sharedEntry.async('string'), 'application/xml');
        for (const item of [...doc.getElementsByTagName('si')]) {
          shared.push([...item.getElementsByTagName('t')].map((node) => node.textContent || '').join(''));
        }
      }
      const sheets = Object.keys(zip.files)
        .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
        .sort();
      const blocks = [];
      for (const name of sheets) {
        const doc = new DOMParser().parseFromString(await zip.file(name).async('string'), 'application/xml');
        const rows = [];
        for (const row of [...doc.getElementsByTagName('row')].slice(0, 2000)) {
          const cells = [...row.getElementsByTagName('c')].map((cell) => {
            const raw = cell.getElementsByTagName('v')[0]?.textContent || '';
            if (cell.getAttribute('t') === 's') return shared[Number(raw)] || '';
            if (cell.getAttribute('t') === 'inlineStr') {
              return [...cell.getElementsByTagName('t')].map((node) => node.textContent || '').join('');
            }
            return raw;
          });
          if (cells.some((cell) => cell.trim())) rows.push(cells.join('\t'));
        }
        if (rows.length) blocks.push(rows.join('\n'));
      }
      return blocks.join('\n\n').trim();
    }

    async function extractPdf(file) {
      if (!window.pdfjsLib) throw new Error('PDF 解析器未加载');
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
        'vendor/pdfjs/pdf.worker.min.js',
        new URL(APP_BASE, location.href),
      ).href;
      const doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
      const pages = [];
      const total = Math.min(doc.numPages, 300);
      for (let index = 1; index <= total; index += 1) {
        const page = await doc.getPage(index);
        const content = await page.getTextContent();
        const text = content.items
          .map((item) => `${item.str || ''}${item.hasEOL ? '\n' : ''}`)
          .join(' ')
          .trim();
        if (text) pages.push(text);
      }
      return pages.join('\n\n');
    }

    function encodeWav(samples, sampleRate) {
      const buffer = new ArrayBuffer(44 + samples.length * 2);
      const view = new DataView(buffer);
      const writeString = (offset, text) => {
        for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
      };
      writeString(0, 'RIFF');
      view.setUint32(4, 36 + samples.length * 2, true);
      writeString(8, 'WAVE');
      writeString(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      writeString(36, 'data');
      view.setUint32(40, samples.length * 2, true);
      let offset = 44;
      for (let index = 0; index < samples.length; index += 1) {
        const sample = Math.max(-1, Math.min(1, samples[index]));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        offset += 2;
      }
      return buffer;
    }

    function blobToBase64(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
        reader.onerror = () => reject(new Error('音频编码失败'));
        reader.readAsDataURL(blob);
      });
    }

    async function transcribeAudioFile(file, item) {
      if (state.api.officialReady !== true || state.api.asrReady !== true) {
        throw new Error('语音识别需要 DeepSeek 官方 API');
      }
      const AudioCtor = window.AudioContext || window.webkitAudioContext;
      const OfflineCtor = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (!AudioCtor || !OfflineCtor) throw new Error('当前环境不支持音频解码');
      const context = new AudioCtor();
      let decoded;
      try {
        decoded = await context.decodeAudioData(await file.arrayBuffer());
      } finally {
        try { await context.close(); } catch { /* ignore */ }
      }
      if (!decoded || !decoded.length) throw new Error('无法解码该音频');
      const rate = 16000;
      let samples;
      if (decoded.sampleRate === rate && decoded.numberOfChannels === 1) {
        samples = decoded.getChannelData(0);
      } else {
        const length = Math.max(1, Math.ceil(decoded.duration * rate));
        const offline = new OfflineCtor(1, length, rate);
        const source = offline.createBufferSource();
        source.buffer = decoded;
        source.connect(offline.destination);
        source.start();
        const rendered = await offline.startRendering();
        samples = rendered.getChannelData(0);
      }
      const chunkFrames = rate * 110;
      const chunks = Math.max(1, Math.ceil(samples.length / chunkFrames));
      const texts = [];
      for (let index = 0; index < chunks; index += 1) {
        if (!pendingAttachments.includes(item)) throw new Error('附件已移除');
        item.progress = chunks > 1 ? `转写中 ${index + 1}/${chunks}` : '转写中…';
        renderAttachmentStrips();
        const slice = samples.subarray(index * chunkFrames, Math.min(samples.length, (index + 1) * chunkFrames));
        const wav = encodeWav(slice, rate);
        const audio = await blobToBase64(new Blob([wav], { type: 'audio/wav' }));
        const response = await fetch(new URL('asr', API_BASE), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ audio, mediaType: 'audio/wav' }),
        });
        const data = await response.json().catch(() => ({}));
        if (response.status === 404) {
          throw new Error('宿主没有加载语音识别路由，请重启 DSH 让 host 0.6.0+ 生效');
        }
        if (!response.ok) throw new Error(data.message || `语音识别失败（HTTP ${response.status}）`);
        if (data.text) texts.push(String(data.text));
      }
      item.progress = '';
      return texts.join('\n\n').trim();
    }

    async function prepareImageAttachment(file) {
      const bitmap = await createImageBitmap(file);
      const max = 1600;
      const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
      bitmap.close?.();
      const ext = file.name.split('.').pop().toLowerCase();
      const keepPng = ext !== 'jpg' && ext !== 'jpeg' && ext !== 'jpe' && ext !== 'jfif';
      const dataUrl = canvas.toDataURL(keepPng ? 'image/png' : 'image/jpeg', 0.85);
      return {
        dataUrl,
        data: dataUrl.split(',')[1] || '',
        mediaType: keepPng ? 'image/png' : 'image/jpeg',
      };
    }

    function renderAttachmentStrips() {
      const html = pendingAttachments.map((item) => {
        if (item.kind === 'image') {
          return `<span class="dsc-attach-tile${item.status === 'error' ? ' is-error' : ''}" data-attach-id="${item.id}" title="${escapeHtml(item.name)}">
            ${item.dataUrl
              ? `<img src="${item.dataUrl}" alt="">`
              : `<span class="dsc-attach-tile-note">${item.status === 'reading' ? '读取中…' : escapeHtml(item.error || '图片')}</span>`}
            <button class="dsc-attach-tile-remove" data-act="remove-attachment" data-attach-id="${item.id}" aria-label="移除图片">${icon('close', 12)}</button>
          </span>`;
        }
        const audio = item.kind === 'audio';
        return `<span class="dsc-attach-chip${item.status === 'error' ? ' is-error' : ''}" data-attach-id="${item.id}">
          <span class="dsc-file-ico">${icon(audio ? 'mic' : 'paperclip', 14)}</span>
          <span class="dsc-attach-name">${escapeHtml(item.name)}</span>
          <span class="dsc-attach-meta">${item.status === 'reading'
            ? (item.progress || (audio ? '转写中…' : '读取中…'))
            : item.status === 'error'
              ? escapeHtml(item.error || '读取失败')
              : audio && item.needsAsr
                ? '发送时转写'
                : formatBytes(item.size)}</span>
          <button class="dsc-attach-remove" data-act="remove-attachment" data-attach-id="${item.id}" aria-label="移除附件">${icon('close', 12)}</button>
        </span>`;
      }).join('');
      $$('[data-role="attach-strip"]').forEach((strip) => {
        strip.innerHTML = html;
        strip.hidden = pendingAttachments.length === 0;
      });
      updateSendState();
    }

    // Clipboard files often lose their name/MIME (e.g. a raw hash), so fall
    // back to sniffing the first bytes before rejecting an attachment.
    async function sniffFile(file) {
      try {
        const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
        const ascii = (start, length) => String.fromCharCode(...head.slice(start, start + length));
        if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return { ext: 'png', mime: 'image/png' };
        if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
        if (ascii(0, 4) === 'GIF8') return { ext: 'gif', mime: 'image/gif' };
        if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return { ext: 'wav', mime: 'audio/wav' };
        if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
        if (ascii(0, 4) === 'OggS') return { ext: 'ogg', mime: 'audio/ogg' };
        if (ascii(0, 4) === 'fLaC') return { ext: 'flac', mime: 'audio/flac' };
        if (ascii(0, 3) === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) return { ext: 'mp3', mime: 'audio/mpeg' };
        if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return { ext: 'webm', mime: 'audio/webm' };
        if (ascii(4, 4) === 'ftyp') return { ext: 'm4a', mime: 'audio/mp4' };
        if (head[0] === 0x42 && head[1] === 0x4d) return { ext: 'bmp', mime: 'image/bmp' };
        if (ascii(0, 4) === '%PDF') return { ext: 'pdf', mime: 'application/pdf' };
        if (head[0] === 0x50 && head[1] === 0x4b && window.JSZip) {
          const zip = await window.JSZip.loadAsync(await file.arrayBuffer());
          if (zip.file('word/document.xml')) return { ext: 'docx', mime: '' };
          if (zip.file('ppt/presentation.xml')) return { ext: 'pptx', mime: '' };
          if (zip.file('xl/workbook.xml')) return { ext: 'xlsx', mime: '' };
        }
      } catch { /* not a recognizable file */ }
      return null;
    }

    async function normalizeIncomingFile(file) {
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      if (ATTACH_ALL_EXTS.has(ext)) return file;
      const mime = String(file.type || '').toLowerCase();
      const mapped = {
        'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
        'image/gif': 'gif', 'image/bmp': 'bmp', 'application/pdf': 'pdf',
        'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg',
        'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac',
        'audio/flac': 'flac', 'audio/webm': 'webm',
      }[mime];
      const sniffed = mapped ? { ext: mapped, mime } : await sniffFile(file);
      const target = sniffed || (mime.startsWith('image/') ? { ext: mime.slice(6) || 'png', mime } : null);
      if (!target) return file;
      try {
        const base = (file.name || '').replace(/\.[^.]+$/, '') || `粘贴附件-${Date.now()}`;
        return new File([file], `${base}.${target.ext}`, {
          type: target.mime || file.type || '',
          lastModified: Date.now(),
        });
      } catch {
        return file;
      }
    }

    async function addAttachmentFiles(fileList) {
      const generation = attachGeneration;
      const files = await Promise.all([...fileList].map((file) => normalizeIncomingFile(file)));
      const room = ATTACH_MAX_COUNT - pendingAttachments.length;
      if (room <= 0) {
        showToast(`最多 ${ATTACH_MAX_COUNT} 个附件`);
        return;
      }
      for (const file of files.slice(0, room)) {
        if (generation !== attachGeneration) return;
        const ext = (file.name.split('.').pop() || '').toLowerCase();
        if (!ATTACH_ALL_EXTS.has(ext)) {
          showToast(`不支持${ext ? ` .${ext}` : ''} 文件`);
          continue;
        }
        if (file.size > ATTACH_MAX_BYTES) {
          showToast(`${file.name} 超过 100MB`);
          continue;
        }
        const item = {
          id: `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          name: file.name,
          size: file.size,
          ext,
          kind: attachmentKind(ext),
          status: 'reading',
        };
        pendingAttachments.push(item);
        recordAttachAction({ type: 'add', id: item.id });
        renderAttachmentStrips();
        try {
          if (item.kind === 'legacy') throw new Error('旧版 Office 请另存为 docx/pptx/xlsx');
          if (item.kind === 'audio') {
            item.sourceFile = file;
            item.needsAsr = true;
          } else if (item.kind === 'image') Object.assign(item, await prepareImageAttachment(file));
          else if (item.kind === 'pdf') item.text = await extractPdf(file);
          else if (ext === 'docx') item.text = await extractDocx(file);
          else if (ext === 'pptx') item.text = await extractPptx(file);
          else if (ext === 'xlsx') item.text = await extractXlsx(file);
          else item.text = await readTextAttachment(file);
          if (typeof item.text === 'string') item.text = item.text.slice(0, ATTACH_TEXT_LIMIT);
          item.status = 'ready';
        } catch (error) {
          item.status = 'error';
          item.error = error instanceof Error ? error.message : String(error);
        }
        if (generation !== attachGeneration) return;
        renderAttachmentStrips();
      }
      if (files.length > room) showToast(`最多 ${ATTACH_MAX_COUNT} 个附件`);
      updateSendState();
    }

    async function collectAttachmentPayload(question = '') {
      const ready = pendingAttachments.filter((item) => item.status === 'ready');
      const imageSupport = modelImageSupport();
      const official = state.api.officialReady === true;
      const imageModels = Array.isArray(state.api.imageModels) ? state.api.imageModels : [];
      const vision = official && imageModels.length
        ? imageModels.find((model) => `${model.provider}|${model.id}` === state.visionModel) || imageModels[0]
        : null;
      const attachments = [];
      const lines = [];
      const images = [];
      const delegatedImages = [];
      for (const item of ready) {
        if (item.kind === 'image') {
          if (imageSupport === true && item.data && item.mediaType) {
            images.push({ name: item.name, mediaType: item.mediaType, data: item.data });
            attachments.push({ name: item.name, size: item.size, ext: item.ext, kind: 'image' });
          } else if (vision && item.data && item.mediaType) {
            delegatedImages.push(item);
            attachments.push({ name: item.name, size: item.size, ext: item.ext, kind: 'image' });
          } else {
            attachments.push({ name: item.name, size: item.size, ext: item.ext, kind: 'image', unsupported: true });
          }
          continue;
        }
        if (item.kind === 'audio') {
          if (!item.text && item.sourceFile) {
            if (state.api.officialReady !== true || state.api.asrReady !== true) {
              throw new Error('语音识别需要 DeepSeek 官方 API');
            }
            item.status = 'reading';
            item.progress = '转写中…';
            renderAttachmentStrips();
            updateSendState();
            try {
              item.text = await transcribeAudioFile(item.sourceFile, item);
              item.status = 'ready';
              item.needsAsr = false;
            } catch (error) {
              item.status = 'error';
              item.error = error instanceof Error ? error.message : String(error);
              renderAttachmentStrips();
              throw error;
            }
            renderAttachmentStrips();
          }
          if (item.text) lines.push(`【音频转写：${item.name}】\n${item.text}`);
          attachments.push({ name: item.name, size: item.size, ext: item.ext, kind: 'audio' });
          continue;
        }
        if (item.text) lines.push(`【附件：${item.name}】\n${item.text}`);
        attachments.push({ name: item.name, size: item.size, ext: item.ext, kind: item.kind });
      }
      let delegated = false;
      if (delegatedImages.length) {
        const spec = state.visionModel || `${vision.provider}|${vision.id}`;
        const [provider, model] = spec.split('|');
        const visionName = vision.name || model;
        showToast(`正在由 ${visionName} 识别图片…`);
        try {
          const response = await fetch(new URL('vision', API_BASE), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              provider,
              model,
              question,
              images: delegatedImages.map((item) => ({ mediaType: item.mediaType, data: item.data })),
            }),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.message || `识图失败（HTTP ${response.status}）`);
          if (!data.text) throw new Error('识图模型没有返回内容');
          lines.push(`【图片由 ${visionName} 识别】\n${data.text}`);
          for (const item of delegatedImages) {
            images.push({ name: item.name, mediaType: item.mediaType, data: item.data });
          }
          delegated = true;
        } catch (error) {
          showToast(error instanceof Error ? error.message : String(error));
          for (const meta of attachments) {
            if (meta.kind === 'image') meta.unsupported = true;
          }
        }
      }
      return {
        attachments,
        attachmentText: lines.join('\n\n').slice(0, 800_000),
        images,
        delegated,
      };
    }

    function clearAttachments() {
      attachGeneration += 1;
      attachHistory = [];
      pendingAttachments = [];
      renderAttachmentStrips();
    }

    function clipboardFiles(event) {
      const items = event.clipboardData?.items;
      if (!items) return [];
      const files = [];
      for (const item of items) {
        if (item.kind !== 'file') continue;
        const file = item.getAsFile();
        if (file) files.push(file);
      }
      return files;
    }

    function onComposerPaste(event) {
      const files = clipboardFiles(event);
      if (!files.length) return;
      event.preventDefault();
      void addAttachmentFiles(files);
    }

    function bindComposerDrop(wrap) {
      const hasFiles = (event) => Array.from(event.dataTransfer?.types || []).includes('Files');
      wrap.addEventListener('dragenter', (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        wrap.classList.add('is-drop');
      }, { signal });
      wrap.addEventListener('dragover', (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
        wrap.classList.add('is-drop');
      }, { signal });
      wrap.addEventListener('dragleave', (event) => {
        if (!wrap.contains(event.relatedTarget)) wrap.classList.remove('is-drop');
      }, { signal });
      wrap.addEventListener('drop', (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        wrap.classList.remove('is-drop');
        const files = [...(event.dataTransfer?.files || [])];
        if (files.length) void addAttachmentFiles(files);
      }, { signal });
    }

    function authSourceLabel(source) {
      if (source === 'api-key') return 'DSH 已配置的 DeepSeek API Key';
      if (source === 'account') return 'DSH 已登录的 DeepSeek 账号';
      if (source === 'env') return '启动环境里的 DEEPSEEK_API_KEY';
      return 'DSH 已配置的模型目录';
    }

    async function loadApiState() {
      if (!state.api.available) return null;
      const firstLoad = state.api.loaded !== true;
      try {
        const response = await fetch(new URL('state', API_BASE), { signal, cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        Object.assign(state.api, data, { loaded: true, available: true });
        if (new URLSearchParams(location.search).has('noOfficial')) {
          state.api.officialReady = false;
          state.api.ttsReady = false;
          state.api.asrReady = false;
          state.api.imageModels = [];
        }
        ttsReadyGlobal = state.api.ttsReady === true;
        officialReadyGlobal = state.api.officialReady === true;
        visionModelsGlobal = Array.isArray(state.api.imageModels) ? state.api.imageModels : [];
        if (!state.api.officialReady && state.searchOn) setSearchMode('off');
        if (!data.searchSupported && state.searchOn) setSearchMode('off');
        renderSearchOptions();
        updateSearchAvailability();
        renderSettingsCapabilities();
        updateThinkSupport();
        renderModelLabel();
        if (firstLoad) {
          if (state.activeId) {
            const active = sessionById(state.activeId);
            if (active) applySessionModel(active);
          } else {
            applyDefaultModel();
          }
        }
        if (state.view === 'chat') renderMessages();
        return data;
      } catch (error) {
        state.api.loaded = true;
        state.api.error = error instanceof Error ? error.message : String(error);
        return null;
      }
    }

    function positionVoiceThumb() {
      const thumb = document.querySelector('.dsc-voice-thumb');
      const active = document.querySelector('.dsc-voice-option.is-active');
      const wrap = active?.closest('.dsc-voice-switch');
      if (!thumb || !active || !wrap || !active.offsetWidth) return;
      thumb.style.width = `${active.offsetWidth}px`;
      thumb.style.transform = `translateX(${active.offsetLeft}px)`;
    }

    function renderTtsVoice() {
      $$('[data-tts-voice]').forEach((button) => {
        const active = button.dataset.ttsVoice === state.ttsVoice;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-checked', active ? 'true' : 'false');
      });
      requestAnimationFrame(positionVoiceThumb);
    }

    function selectedSearchProvider() {
      const value = String(state.searchProvider || 'official');
      if (value === 'official' || value === 'deepseek') return { kind: 'official' };
      const split = value.indexOf('|');
      if (split < 0) return { kind: 'official' };
      return {
        kind: 'agent',
        provider: value.slice(0, split),
        model: value.slice(split + 1),
      };
    }

    function searchModelReady() {
      const config = selectedSearchProvider();
      if (config.kind === 'official') {
        return state.api.officialReady === true && state.api.model === 'deepseek-flash';
      }
      return state.api.searchSupported === true
        && (state.api.models || []).some((model) => model.provider === config.provider && model.id === config.model);
    }

    function updateSearchAvailability() {
      const available = searchModelReady();
      $$('[data-act="toggle-search"]').forEach((button) => {
        button.classList.toggle('is-unsupported', !available);
        button.setAttribute('aria-disabled', available ? 'false' : 'true');
        button.dataset.tip = available
          ? '按需搜索网页'
          : (selectedSearchProvider().kind === 'official'
            ? '联网搜索需要 DeepSeek-V4.1-Flash（官方 API）'
            : '联网搜索子 Agent 不可用');
      });
      if (!available && state.searchOn) setSearchMode('off');
    }

    function modelOptionValue(model) {
      return `${model.provider || ''}|${model.id}`;
    }

    function renderSettingsCapabilities() {
      const official = state.api.officialReady === true;
      const imageModels = Array.isArray(state.api.imageModels) ? state.api.imageModels : [];
      const capabilityDesc = $('[data-role="capability-desc"]');
      if (capabilityDesc) {
        const webSearch = state.api.searchSupported === true;
        capabilityDesc.textContent = official
          ? '识图 · 语音输入 · 语音输出 · 联网搜索'
          : webSearch
            ? '联网搜索可用（子 Agent）；其余需要官方 API'
            : '需要 DeepSeek 官方 API';
      }
      const vision = $('[data-setting="vision"]');
      if (vision) {
        if (!official || !imageModels.length) {
          vision.innerHTML = '<option value="">不可用</option>';
          vision.disabled = true;
        } else {
          vision.disabled = false;
          const values = imageModels.map((model) => ({ value: modelOptionValue(model), label: model.name || model.id }));
          if (!values.some((item) => item.value === state.visionModel)) {
            state.visionModel = values[0].value;
            remember('dsc.visionModel', state.visionModel);
          }
          vision.innerHTML = values.map((item) => `<option value="${escapeHtml(item.value)}">${escapeHtml(item.label)}</option>`).join('');
          vision.value = state.visionModel;
        }
      }
      const flash = (state.api.models || []).find((model) => model.id === 'deepseek-flash');
      for (const [key, stateKey, storageKey] of [
        ['asr', 'asrModel', 'dsc.asrModel'],
        ['tts', 'ttsModel', 'dsc.ttsModel'],
      ]) {
        const select = $(`[data-setting="${key}"]`);
        if (!select) continue;
        if (!official || !flash) {
          select.innerHTML = '<option value="">不可用</option>';
          select.disabled = true;
        } else {
          select.disabled = false;
          const value = modelOptionValue(flash);
          state[stateKey] = value;
          remember(storageKey, value);
          select.innerHTML = `<option value="${escapeHtml(value)}">${escapeHtml(flash.name || flash.id)}</option>`;
          select.value = value;
        }
      }
      const search = $('[data-setting="search"]');
      if (search) {
        const options = [];
        if (official) options.push({ value: 'official', label: 'DeepSeek 官方（模型自决）' });
        const webSearch = state.api.searchSupported === true;
        if (webSearch) {
          for (const model of state.api.models || []) {
            options.push({
              value: modelOptionValue(model),
              label: `${model.name || model.id} · 搜索子 Agent`,
            });
          }
        }
        if (!options.length) {
          search.innerHTML = '<option value="">不可用</option>';
          search.disabled = true;
          state.searchProvider = '';
        } else {
          search.disabled = false;
          if (!options.some((option) => option.value === state.searchProvider)) {
            state.searchProvider = options[0].value;
            remember('dsc.searchProvider', state.searchProvider);
          }
          search.innerHTML = options
            .map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`)
            .join('');
          search.value = state.searchProvider;
        }
      }
    }

    function setTtsVoice(voice) {
      const next = voice === 'tide' ? 'tide' : 'stella';
      if (next === state.ttsVoice) return;
      clearReadLockArm();
      if (ttsAudio) stopSpeech();
      state.ttsVoice = next;
      ttsVoiceGlobal = next;
      remember('dsc.ttsVoice', next);
      renderTtsVoice();
      if (state.view === 'chat') renderMessages();
    }

    function requestClearLegacy(button) {
      const ids = state.sessions
        .filter((session) => !session.importBatch && isImportedSession(session))
        .map((session) => session.id);
      if (!ids.length) {
        showToast('没有历史导入的对话');
        return;
      }
      if (button?.dataset.armed !== '1') {
        if (button) {
          button.dataset.armed = '1';
          button.classList.add('is-danger');
          button.textContent = '确认清理';
        }
        const desc = $('[data-role="legacy-import-desc"]');
        if (desc) desc.textContent = `再点一次，删除 ${ids.length} 个历史导入`;
        if (legacyArmTimer) clearTimeout(legacyArmTimer);
        legacyArmTimer = setTimeout(() => {
          legacyArmTimer = null;
          renderLastImport();
        }, 3000);
        return;
      }
      if (legacyArmTimer) {
        clearTimeout(legacyArmTimer);
        legacyArmTimer = null;
      }
      performDelete(ids);
    }

    function requestClearImported() {
      const ids = state.sessions.filter((session) => !session.importBatch && isImportedSession(session)).map((session) => session.id);
      if (!ids.length) {
        showToast('没有导入的对话');
        return;
      }
      if (dialogCloseTimer) {
        clearTimeout(dialogCloseTimer);
        dialogCloseTimer = null;
      }
      dialogMode = 'delete-imported';
      dialogIds = ids;
      dialogTitle.textContent = `清理历史导入的 ${ids.length} 个对话?`;
      dialogDesc.textContent = '这些是启用批次记录前导入的会话；自己创建的对话不受影响。删除后不可恢复。';
      dialogDesc.hidden = false;
      dialogConfirm.textContent = '清理';
      dialogConfirm.classList.remove('is-primary');
      dialogConfirm.classList.add('is-danger');
      if (dialogCancel) dialogCancel.textContent = '取消';
      dialogEl.hidden = false;
      dialogEl.classList.remove('show');
      requestAnimationFrame(() => requestAnimationFrame(() => {
        dialogEl.classList.add('show');
        dialogConfirm.focus({ preventScroll: true });
      }));
      // rAF can be throttled in a background/embedded window; never leave an
      // invisible full-screen overlay swallowing clicks.
      setTimeout(() => dialogEl.classList.add('show'), 80);
    }

    function positionCapabilityPop() {
      if (!capabilityPop || !capabilityRow) return;
      const rootRect = root.getBoundingClientRect();
      const rowRect = capabilityRow.getBoundingClientRect();
      const card = root.querySelector('.dsc-settings-card')?.getBoundingClientRect();
      const width = capabilityPop.offsetWidth || 460;
      const height = capabilityPop.offsetHeight || 300;
      let left;
      let top;
      if (card && card.right + 10 + width <= rootRect.right - 12) {
        left = card.right - rootRect.left + 10;
        top = rowRect.top - rootRect.top - 10;
      } else {
        left = rowRect.left - rootRect.left;
        top = rowRect.bottom - rootRect.top + 8;
      }
      left = Math.max(12, Math.min(left, rootRect.width - width - 12));
      top = Math.max(12, Math.min(top, rootRect.height - height - 12));
      capabilityPop.style.left = `${Math.round(left)}px`;
      capabilityPop.style.top = `${Math.round(top)}px`;
    }

    function closeCapabilities(immediate = false) {
      if (!capabilityPop || capabilityPop.hidden) return;
      capabilityPop.classList.remove('show');
      capabilityRow?.classList.remove('is-open');
      capabilityRow?.setAttribute('aria-expanded', 'false');
      if (immediate) {
        capabilityPop.hidden = true;
        return;
      }
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!capabilityPop.classList.contains('show')) capabilityPop.hidden = true;
      }, 140);
      timers.add(timer);
    }

    function openCapabilities() {
      if (!capabilityPop || !capabilityRow) return;
      if (!capabilityPop.hidden) {
        closeCapabilities();
        return;
      }
      closeThinkMenu();
      closeSearchMenu();
      closeModelMenu();
      closeSessionMenu();
      capabilityPop.hidden = false;
      capabilityPop.classList.remove('show');
      positionCapabilityPop();
      capabilityRow.classList.add('is-open');
      capabilityRow.setAttribute('aria-expanded', 'true');
      requestAnimationFrame(() => requestAnimationFrame(() => capabilityPop.classList.add('show')));
      setTimeout(() => capabilityPop.classList.add('show'), 80);
    }

    function openSettings() {
      closeThinkMenu();
      closeSearchMenu();
      closeModelMenu();
      closeSessionMenu();
      if (settingsCloseTimer) {
        clearTimeout(settingsCloseTimer);
        settingsCloseTimer = null;
      }
      closeCapabilities(true);
      renderTtsVoice();
      renderSettingsCapabilities();
      renderLastImport();
      settingsEl.hidden = false;
      settingsEl.classList.remove('show');
      requestAnimationFrame(positionVoiceThumb);
      requestAnimationFrame(() => requestAnimationFrame(() => settingsEl.classList.add('show')));
    }

    function closeSettings() {
      closeCapabilities(true);
      if (settingsEl.hidden) return;
      settingsEl.classList.remove('show');
      if (settingsCloseTimer) clearTimeout(settingsCloseTimer);
      settingsCloseTimer = setTimeout(() => {
        settingsCloseTimer = null;
        settingsEl.hidden = true;
      }, 150);
    }

    function renderReadme(source) {
      const meta = $('[data-role="readme-meta"]', readmeEl);
      if (meta) meta.textContent = `DSH Chat with DeepSeek · v${readmeVersion} · MIT`;
      readmeBodyEl.innerHTML = `<div class="dsc-md dsc-readme-md">${renderMarkdown(source)}</div>`;
      readmeBodyEl.scrollTop = 0;
    }

    function openReadme() {
      if (!readmeEl) return;
      closeCapabilities(true);
      if (readmeCloseTimer) {
        clearTimeout(readmeCloseTimer);
        readmeCloseTimer = null;
      }
      readmeEl.hidden = false;
      readmeEl.classList.remove('show');
      requestAnimationFrame(() => requestAnimationFrame(() => readmeEl.classList.add('show')));
      if (readmeMarkdown) {
        renderReadme(readmeMarkdown);
        return;
      }
      readmeBodyEl.innerHTML = '<div class="dsc-readme-loading">正在读取 README…</div>';
      if (!readmeLoading) {
        readmeLoading = (async () => {
          const response = await fetch(new URL('readme', API_BASE), {
            cache: 'no-store',
            headers: { accept: 'application/json' },
          });
          const payload = await response.json().catch(() => null);
          if (!response.ok || !payload || typeof payload.markdown !== 'string') {
            throw new Error(apiErrorMessage(payload) || 'README 不可用');
          }
          readmeMarkdown = payload.markdown;
          if (typeof payload.version === 'string' && payload.version) readmeVersion = payload.version;
          return readmeMarkdown;
        })().finally(() => { readmeLoading = null; });
      }
      readmeLoading.then((source) => {
        if (!readmeEl.hidden) renderReadme(source);
      }).catch((error) => {
        if (!readmeEl.hidden) {
          readmeBodyEl.innerHTML = `<div class="dsc-readme-error">README 读取失败：${escapeHtml(error.message || '请重启 DSH 后重试')}</div>`;
        }
      });
    }

    function closeReadme() {
      if (!readmeEl || readmeEl.hidden) return;
      readmeEl.classList.remove('show');
      if (readmeCloseTimer) clearTimeout(readmeCloseTimer);
      readmeCloseTimer = setTimeout(() => {
        readmeCloseTimer = null;
        readmeEl.hidden = true;
      }, 150);
    }

    function apiErrorMessage(payload) {
      if (payload && typeof payload === 'object' && payload.error && typeof payload.error === 'object') {
        const detail = payload.error.message || payload.error.type;
        if (typeof detail === 'string' && detail.trim()) return detail.trim().slice(0, 400);
      }
      const raw = payload && typeof payload === 'object' ? payload.message || payload.error : payload;
      if (typeof raw !== 'string' || !raw.trim()) return '请求失败，请稍后再试';
      try {
        const parsed = JSON.parse(raw);
        const detail = parsed?.error?.message || parsed?.error?.type || parsed?.message;
        if (typeof detail === 'string' && detail.trim()) return detail.trim().slice(0, 400);
      } catch { /* plain message */ }
      return raw.trim().slice(0, 400);
    }

    function updateSelectTitle() {
      if (!selectTitleEl) return;
      const count = state.selected.size;
      selectTitleEl.textContent = count > 0 ? `已选择 ${count} 个对话` : '选择对话';
    }

    function selectedAllPinned() {
      if (state.selected.size === 0) return false;
      return [...state.selected].every((id) => sessionById(id)?.pinned === true);
    }

    function updateSelectActions() {
      const pin = $('[data-act="pin-selected"]');
      const remove = $('[data-act="delete-selected"]');
      const count = state.selected.size;
      const allPinned = selectedAllPinned();
      if (pin) {
        pin.disabled = count === 0;
        pin.innerHTML = `${icon(allPinned ? 'pinOff' : 'pin', 16)}<span>${allPinned ? '取消置顶' : '置顶'}</span>`;
      }
      if (remove) remove.disabled = count === 0;
      updateSelectTitle();
    }

    function syncSelectionRows() {
      for (const row of sessionsEl.querySelectorAll('.dsc-session[data-session]')) {
        const selected = state.selected.has(row.dataset.session);
        row.classList.toggle('selected', selected);
        row.setAttribute('aria-pressed', selected ? 'true' : 'false');
        const check = row.querySelector('.dsc-session-check');
        if (check) {
          check.classList.toggle('checked', selected);
          check.innerHTML = selected ? icon('check', 12) : '';
        }
      }
    }

    function renderSessions() {
      const groups = groupSessions(state.sessions);
      const scrollTop = sessionsEl.scrollTop;
      sessionsEl.innerHTML = groups.map((group, groupIndex) => `
        <div class="dsc-group">
          <div class="dsc-group-head">
            <span class="dsc-group-label">${group.label}</span>
            ${groupIndex === 0 && state.sessions.length > 0 ? `
              <button class="dsc-multiselect" data-act="select-mode" data-tip="多选" aria-label="多选">
                ${icon('listSelect', 18)}
              </button>` : ''}
          </div>
          ${group.items.map((item) => {
            const selected = state.selected.has(item.id);
            if (state.renamingId === item.id) {
              return `
                <div class="dsc-session dsc-session-renaming">
                  <input class="dsc-rename-input" data-rename-input value="${escapeHtml(item.title)}" maxlength="60"
                    aria-label="重命名对话" spellcheck="false" autocomplete="off">
                </div>`;
            }
            return `
              <button class="dsc-session${item.id === state.activeId && !state.selectMode ? ' active' : ''}${selected ? ' selected' : ''}"
                data-session="${escapeHtml(item.id)}" aria-pressed="${selected}">
                <span class="dsc-session-check${selected ? ' checked' : ''}" aria-hidden="true">${selected ? icon('check', 12) : ''}</span>
                <span class="dsc-session-title">${escapeHtml(item.title)}</span>
                <span class="dsc-session-more" data-act="session-menu" aria-hidden="true">${icon('more', 16)}</span>
              </button>`;
          }).join('')}
        </div>`).join('');
      sessionsEl.scrollTop = scrollTop;
      updateSelectActions();
      const renameInput = sessionsEl.querySelector('[data-rename-input]');
      if (renameInput) {
        renameInput.focus({ preventScroll: true });
        renameInput.select();
        renameInput.addEventListener('blur', commitRename, { once: true });
      }
    }

    function enterSelectMode(preselectId) {
      if (!state.sessions.length) return;
      closeThinkMenu();
      closeModelMenu();
      closeSearch();
      closeSessionMenu();
      state.selectMode = true;
      state.selected.clear();
      if (preselectId && sessionById(preselectId)) state.selected.add(preselectId);
      root.dataset.select = '1';
      syncSelectionRows();
      updateSelectActions();
    }

    function exitSelectMode() {
      state.selectMode = false;
      state.selected.clear();
      root.dataset.select = '0';
      syncSelectionRows();
      updateSelectActions();
    }

    function toggleSessionSelected(id) {
      if (!state.selectMode) return;
      if (state.selected.has(id)) state.selected.delete(id);
      else state.selected.add(id);
      syncSelectionRows();
      updateSelectActions();
    }

    function openDialog(mode) {
      const count = state.selected.size;
      if (!count) return;
      if (dialogCloseTimer) {
        clearTimeout(dialogCloseTimer);
        dialogCloseTimer = null;
      }
      dialogMode = mode;
      dialogIds = [...state.selected];
      dialogTitle.textContent = mode === 'pin'
        ? `将选择的 ${count} 个对话置顶?`
        : mode === 'unpin'
          ? `将选择的 ${count} 个对话取消置顶?`
          : `删除选择的 ${count} 个对话?`;
      dialogDesc.textContent = '删除后，对话将不可恢复，由该对话生成的分享链接也将失效。';
      dialogDesc.hidden = mode !== 'delete';
      dialogConfirm.textContent = mode === 'pin' ? '置顶' : mode === 'unpin' ? '取消置顶' : '删除';
      if (dialogCancel) dialogCancel.textContent = mode === 'unpin' ? '保留' : '取消';
      dialogConfirm.classList.toggle('is-primary', mode !== 'delete');
      dialogConfirm.classList.toggle('is-danger', mode === 'delete');
      dialogEl.hidden = false;
      dialogEl.classList.remove('show');
      requestAnimationFrame(() => requestAnimationFrame(() => {
        dialogEl.classList.add('show');
        dialogConfirm.focus({ preventScroll: true });
      }));
      // rAF can be throttled in a background/embedded window; never leave an
      // invisible full-screen overlay swallowing clicks.
      setTimeout(() => dialogEl.classList.add('show'), 80);
    }

    function closeDialog(immediate = false) {
      dialogEl.classList.remove('show');
      const hide = () => {
        dialogEl.hidden = true;
        dialogMode = null;
        dialogIds = [];
        dialogBatchId = null;
        pendingMessageDelete = null;
      };
      if (immediate) {
        hide();
        return;
      }
      if (dialogCloseTimer) clearTimeout(dialogCloseTimer);
      dialogCloseTimer = setTimeout(() => {
        dialogCloseTimer = null;
        hide();
      }, 140);
    }

    function performPin(ids) {
      const count = ids.length;
      for (const session of state.sessions) {
        if (ids.includes(session.id)) session.pinned = true;
      }
      storeSessions(state.sessions);
      exitSelectMode();
      const timer = setTimeout(() => {
        timers.delete(timer);
        renderSessions();
        showToast(`已置顶 ${count} 个对话`, { success: true, top: true });
      }, 200);
      timers.add(timer);
    }

    function performDelete(ids) {
      const count = ids.length;
      const activeDeleted = state.activeId != null && ids.includes(state.activeId);
      ids.forEach((id) => abortSessionStream(id));
      state.sessions = state.sessions.filter((session) => !ids.includes(session.id));
      void pruneTtsCache();
      storeSessions(state.sessions);
      if (activeDeleted) {
        state.activeId = null;
        state.messages = [];
        syncBusy();
      }
      exitSelectMode();
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (activeDeleted) {
          setView('welcome');
          clearComposers();
        }
        renderSessions();
        renderLastImport();
        showToast(`已删除 ${count} 个对话`, { success: true, top: true });
      }, 200);
      timers.add(timer);
    }

    function confirmDialog() {
      const mode = dialogMode;
      const ids = [...dialogIds];
      if (mode === 'delete-message') {
        const pending = pendingMessageDelete;
        closeDialog(true);
        dialogMode = null;
        dialogIds = [];
        dialogBatchId = null;
        pendingMessageDelete = null;
        if (pending) {
          try {
            deleteMessageNode(pending.sessionId, pending.nodeId);
          } catch (error) {
            showToast(`删除失败：${error && error.message ? error.message : error}`);
          }
        }
        return;
      }
      if (mode === 'undo-import') {
        const batchId = dialogBatchId;
        closeDialog(true);
        dialogMode = null;
        dialogIds = [];
        dialogBatchId = null;
        if (batchId) undoImportBatch(batchId);
        return;
      }
      if (!mode || ids.length === 0) {
        closeDialog(true);
        return;
      }
      closeDialog();
      dialogMode = null;
      dialogIds = [];
      if (mode === 'pin') performPin(ids);
      else if (mode === 'unpin') performUnpin(ids);
      else performDelete(ids);
    }

    function performUnpin(ids) {
      const count = ids.length;
      for (const session of state.sessions) {
        if (ids.includes(session.id)) session.pinned = false;
      }
      storeSessions(state.sessions);
      exitSelectMode();
      const timer = setTimeout(() => {
        timers.delete(timer);
        renderSessions();
        showToast(`已取消置顶 ${count} 个对话`, { success: true, top: true });
      }, 200);
      timers.add(timer);
    }

    function requestPinSelected() {
      if (state.selected.size) openDialog(selectedAllPinned() ? 'unpin' : 'pin');
    }

    function requestDeleteSelected() {
      if (state.selected.size) openDialog('delete');
    }

    function closeSessionMenu() {
      state.sessionMenuId = null;
      state.menuDeleteArmed = false;
      if (menuDeleteTimer) {
        clearTimeout(menuDeleteTimer);
        menuDeleteTimer = null;
      }
      sessionMenuEl.hidden = true;
      sessionMenuEl.classList.remove('dsc-account-menu');
      sessionMenuEl.innerHTML = '';
    }

    // Account-level menu (currently import; future settings live here too).
    function openAccountMenu(trigger) {
      if (!sessionMenuEl.hidden && sessionMenuEl.classList.contains('dsc-account-menu')) {
        closeSessionMenu();
        return;
      }
      closeSessionMenu();
      sessionMenuEl.classList.add('dsc-account-menu');
      sessionMenuEl.innerHTML = `
        <button class="dsc-session-menu-item" data-menu-act="import-sessions" role="menuitem">${icon('importFile', 17)}<span>导入聊天记录…</span></button>`;
      sessionMenuEl.hidden = false;
      sessionMenuEl.style.left = '0px';
      sessionMenuEl.style.top = '0px';
      sessionMenuEl.style.visibility = 'hidden';
      const rootRect = root.getBoundingClientRect();
      const rect = trigger.getBoundingClientRect();
      const menuWidth = sessionMenuEl.offsetWidth;
      const menuHeight = sessionMenuEl.offsetHeight;
      let left = rect.right - rootRect.left - menuWidth;
      if (left < 8) left = 8;
      if (left + menuWidth > rootRect.width - 8) left = rootRect.width - menuWidth - 8;
      let top = rect.top - rootRect.top - menuHeight - 6;
      if (top < 8) top = rect.bottom - rootRect.top + 6;
      sessionMenuEl.style.left = `${Math.round(left)}px`;
      sessionMenuEl.style.top = `${Math.round(top)}px`;
      sessionMenuEl.style.visibility = '';
    }

    // ---- import DeepSeek exports -------------------------------------
    // Tolerant adapters: the official export schema is unknown until a real
    // sample lands, so accept our own shape, plain arrays, `conversations`,
    // and the web API's `data.biz_data.chat_messages` envelope.

    function importedRole(value) {
      const role = String(value || '').toLowerCase();
      if (role === 'user' || role === 'human') return 'user';
      if (role === 'assistant' || role === 'ai' || role === 'bot') return 'assistant';
      return null;
    }

    function importedText(message) {
      if (!message) return '';
      if (typeof message.content === 'string') return message.content;
      if (Array.isArray(message.content)) {
        return message.content
          .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
          .join('');
      }
      if (typeof message.text === 'string') return message.text;
      return '';
    }

    // Exports occasionally carry raw control bytes (e.g. a literal \f from a
    // mis-escaped LaTeX export); they break KaTeX and render oddly.
    function stripControlChars(text) {
      return String(text).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
    }

    // ---- DeepSeek v3 export ZIP (deepseek_data-*.zip) ----------------
    const EXPORT_ARCHIVE_VERSION = 3;
    const EXPORT_ARCHIVE_MAX_BYTES = 512_000_000;
    const EXPORT_TEXT_MAX_CHARS = 180_000_000;

    function exportIsoTime(value) {
      const time = Date.parse(String(value || ''));
      return Number.isFinite(time) ? time : 0;
    }

    function exportFragmentText(fragments, type) {
      return (fragments || [])
        .filter((fragment) => fragment && fragment.type === type && typeof fragment.content === 'string')
        .map((fragment) => fragment.content)
        .join('\n\n')
        .trim();
    }

    function exportSources(fragments) {
      const seen = new Set();
      const sources = [];
      const add = (result) => {
        if (!result) return;
        const url = safeHttpUrl(result.url || result.source_page_url);
        if (!url || seen.has(url) || sources.length >= 12) return;
        seen.add(url);
        sources.push({
          url,
          title: String(result.title || result.site_name || url).slice(0, 200),
          snippet: String(result.snippet || '').slice(0, 300),
        });
      };
      for (const fragment of fragments || []) {
        if (!fragment) continue;
        if (fragment.type === 'TOOL_SEARCH' || fragment.type === 'TOOL_IMAGE_SEARCH') {
          for (const result of fragment.results || []) add(result);
        } else if (fragment.type === 'TOOL_OPEN') {
          add(fragment);
        } else if (fragment.type === 'READ_LINK') {
          for (const result of fragment.results || []) add(result);
        }
      }
      return sources;
    }

    function exportAttachments(fragments) {
      const attachments = [];
      for (const fragment of fragments || []) {
        if (!fragment || fragment.type !== 'FILE') continue;
        for (const file of fragment.files || []) {
          if (!file) continue;
          attachments.push({
            name: String(file.file_name || '附件').slice(0, 160) || '附件',
            size: Number(file.file_size) || 0,
            kind: file.is_image ? 'image' : 'file',
            missing: true,
          });
        }
      }
      return attachments;
    }

    function convertExportMessage(message) {
      const fragments = Array.isArray(message.fragments) ? message.fragments : [];
      if (message.role === 'USER') {
        const text = stripControlChars(exportFragmentText(fragments, 'REQUEST')).trim();
        const attachments = exportAttachments(fragments);
        return { role: 'user', text, ...attachments.length ? { attachments } : {} };
      }
      if (message.role !== 'ASSISTANT') return null;
      const response = stripControlChars(exportFragmentText(fragments, 'RESPONSE')).trim();
      const template = stripControlChars(exportFragmentText(fragments, 'TEMPLATE_RESPONSE')).trim();
      const reasoning = stripControlChars(exportFragmentText(fragments, 'THINK')).trim();
      const sources = exportSources(fragments);
      const status = String(message.status || '').toUpperCase();
      const failed = status === 'FAILED' || status === 'TIMEOUT' || status === 'CONTEXT_LENGTH_EXCEEDED';
      const stopped = status === 'INCOMPLETE' || status === 'WIP';
      let text = response;
      let error = '';
      if (failed) {
        const label = status === 'TIMEOUT' ? '超时' : status === 'FAILED' ? '失败' : '超出上下文';
        error = template || `这次回答没有完成（${label}）`;
      } else if (!text && template) {
        text = template;
      }
      const activity = [];
      if (reasoning) {
        let elapsed = 0;
        for (const fragment of fragments) {
          if (fragment && fragment.type === 'THINK') elapsed = Math.max(elapsed, Number(fragment.elapsed_secs) || 0);
        }
        activity.push({
          type: 'think',
          label: elapsed ? `已思考 ${Math.round(elapsed)} 秒` : '已思考',
          preview: reasoning.replace(/\s+/g, ' ').slice(0, 48),
        });
      }
      const queries = [];
      let opened = 0;
      for (const fragment of fragments) {
        if (!fragment) continue;
        if (fragment.type === 'TOOL_SEARCH') {
          for (const query of fragment.queries || []) {
            if (typeof query === 'string' && query.trim()) queries.push(query.trim());
          }
        } else if (fragment.type === 'TOOL_FIND' && typeof fragment.pattern === 'string' && fragment.pattern.trim()) {
          queries.push(fragment.pattern.trim());
        } else if (fragment.type === 'TOOL_OPEN' && fragment.url) {
          opened += 1;
        }
      }
      if (queries.length || opened) {
        activity.push({
          type: 'search',
          label: `联网搜索${opened ? ` · 读取 ${opened} 个网页` : ''}`,
          preview: queries.slice(0, 4).join(' · ').slice(0, 80),
        });
      }
      const next = { role: 'assistant', text };
      if (error) next.error = error;
      if (stopped) next.stopped = true;
      if (reasoning) next.reasoning = reasoning;
      if (activity.length) next.activity = activity;
      if (sources.length) next.sources = sources;
      return next;
    }

    // Import the whole message tree, not just the selected branch: every
    // archived node keeps its parent link, so complex branch structures are
    // available to the branch switcher after import. session.messages is the
    // derived current-branch view and remains the only thing search sees.
    function convertExportSession(raw, options = {}) {
      if (!raw || !Array.isArray(raw.messages) || !raw.messages.length) return null;
      const entries = [];
      const byRawId = new Map();
      for (const rawMessage of raw.messages) {
        if (!rawMessage || rawMessage.id == null || byRawId.has(rawMessage.id)) continue;
        const node = convertExportMessage(rawMessage);
        if (!node) continue;
        const internalId = `m${entries.length + 1}`;
        const entry = {
          rawId: rawMessage.id,
          rawParentId: rawMessage.parent_id,
          internalId,
          node,
        };
        entries.push(entry);
        byRawId.set(rawMessage.id, entry);
      }
      if (!entries.length) return null;
      for (const entry of entries) {
        entry.node.id = entry.internalId;
        const parent = entry.rawParentId == null ? null : byRawId.get(entry.rawParentId);
        entry.node.parentId = parent ? parent.internalId : null;
      }
      const tree = entries.map((entry) => entry.node);
      const byId = new Map(tree.map((node) => [node.id, node]));
      const currentEntry = byRawId.get(raw.current_message_id)
        || entries[entries.length - 1];
      const currentId = currentEntry?.internalId || tree[tree.length - 1]?.id || null;
      const messages = branchFromTree(tree, byId, currentId);
      const firstUser = tree.find((message) => message.role === 'user' && message.text);
      const rawId = String(raw.id || '').slice(0, 120) || Date.now().toString(36);
      const id = options.keepIds
        ? rawId
        : (rawId.startsWith('ds-') ? rawId : `ds-${rawId}`);
      const title = String(raw.title || '').trim()
        || (firstUser?.text || '').replace(/\s+/g, ' ').slice(0, 30)
        || '导入的对话';
      const createdAt = exportIsoTime(raw.inserted_at) || Date.now();
      return {
        id,
        title: title.slice(0, 60),
        createdAt,
        updatedAt: exportIsoTime(raw.updated_at) || createdAt,
        pinned: raw.pinned === true,
        tree,
        currentId,
        nextMessageId: entries.length + 1,
        messages,
      };
    }

    function exportUuid() {
      if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
        const value = Math.floor(Math.random() * 16);
        return (ch === 'x' ? value : (value & 0x3) | 0x8).toString(16);
      });
    }

    function safeExportFileId(id, used) {
      const base = String(id || 'session')
        .replace(/[^A-Za-z0-9._-]/g, '_')
        .slice(0, 80) || 'session';
      let candidate = base;
      let suffix = 2;
      while (used.has(candidate)) {
        candidate = `${base}-${suffix}`;
        suffix += 1;
      }
      used.add(candidate);
      return candidate;
    }

    function exportFileEntry(attachment, insertedAt) {
      return {
        id: exportUuid(),
        file_name: String(attachment?.name || '附件').slice(0, 200),
        file_size: Number(attachment?.size) || 0,
        token_usage: null,
        inserted_at: insertedAt,
        export_path: null,
        is_image: attachment?.kind === 'image',
        width: null,
        height: null,
      };
    }

    function buildExportSession(session, usedFileIds) {
      const source = Array.isArray(session.tree) && session.tree.length
        ? session.tree
        : (Array.isArray(session.messages) ? session.messages : []);
      const nodes = source.filter((node) => node && typeof node === 'object');
      if (!nodes.length) return null;
      const byId = new Map(nodes.map((node) => [node.id, node]));
      const children = new Map();
      for (const node of nodes) {
        const key = node.parentId ?? null;
        if (!children.has(key)) children.set(key, []);
        children.get(key).push(node);
      }
      const ordered = [];
      const visited = new Set();
      const visit = (node) => {
        if (!node || visited.has(node.id)) return;
        visited.add(node.id);
        ordered.push(node);
        for (const child of children.get(node.id) || []) visit(child);
      };
      for (const node of nodes) {
        if (node.parentId == null || !byId.has(node.parentId)) visit(node);
      }
      for (const node of nodes) visit(node);
      const exportIds = new Map(ordered.map((node, index) => [node.id, index + 1]));
      const base = Number(session.createdAt) || Date.now();
      const messages = [];
      for (let index = 0; index < ordered.length; index += 1) {
        const node = ordered[index];
        const role = node.role === 'user' ? 'USER' : node.role === 'assistant' ? 'ASSISTANT' : null;
        if (!role) continue;
        const parentExport = node.parentId != null && exportIds.has(node.parentId)
          ? exportIds.get(node.parentId)
          : null;
        const insertedAt = new Date(base + index * 1000).toISOString();
        const item = {
          id: exportIds.get(node.id),
          parent_id: parentExport,
          role,
          status: 'FINISHED',
          thinking_enabled: false,
          search_enabled: false,
          accumulated_token_usage: 0,
          inserted_at: insertedAt,
          fragments: [],
        };
        if (role === 'USER') {
          const text = stripControlChars(String(node.text || '')).trim();
          const files = (Array.isArray(node.attachments) ? node.attachments : [])
            .map((attachment) => exportFileEntry(attachment, insertedAt));
          item.fragments.push({ type: 'REQUEST', content: text || (files.length ? '（附件）' : '') });
          if (files.length) item.fragments.push({ type: 'FILE', files });
        } else {
          const reasoning = stripControlChars(String(node.reasoning || '')).trim();
          const text = stripControlChars(String(node.text || '')).trim();
          const sources = (Array.isArray(node.sources) ? node.sources : [])
            .filter((source) => source && safeHttpUrl(source.url))
            .slice(0, 20);
          if (reasoning) {
            item.fragments.push({ type: 'THINK', content: reasoning.slice(0, 40_000), elapsed_secs: null });
          }
          if (sources.length) {
            item.fragments.push({
              type: 'TOOL_SEARCH',
              queries: [],
              status: 'FINISHED',
              results: sources.map((source) => ({
                url: safeHttpUrl(source.url),
                title: String(source.title || source.url).slice(0, 300),
                snippet: String(source.snippet || '').slice(0, 800),
                published_at: null,
                site_name: null,
                site_icon: null,
              })),
            });
          }
          if (text) item.fragments.push({ type: 'RESPONSE', content: text.slice(0, 200_000) });
          if (node.error) {
            item.fragments.push({ type: 'TEMPLATE_RESPONSE', content: String(node.error).slice(0, 4000) });
            item.status = 'FAILED';
          } else if (node.stopped) {
            item.status = 'INCOMPLETE';
          }
          item.thinking_enabled = Boolean(reasoning);
          item.search_enabled = Boolean(sources.length);
        }
        messages.push(item);
      }
      if (!messages.length) return null;
      const mappedCurrent = exportIds.get(session.currentId);
      const currentMessageId = mappedCurrent || messages[messages.length - 1].id;
      const firstUser = messages.find((message) => message.role === 'USER' && message.fragments[0]?.content);
      const title = String(session.title || '').trim()
        || (firstUser?.fragments[0]?.content || '').replace(/\s+/g, ' ').slice(0, 30)
        || '导入的对话';
      const updatedAt = Math.max(
        base,
        Number(session.updatedAt) || base,
        base + ordered.length * 1000,
      );
      return {
        fileId: safeExportFileId(session.id, usedFileIds),
        session: {
          id: String(session.id),
          title: title.slice(0, 120),
          pinned: session.pinned === true,
          current_message_id: currentMessageId,
          inserted_at: new Date(base).toISOString(),
          updated_at: new Date(updatedAt).toISOString(),
          messages,
        },
      };
    }

    async function collectTtsExport() {
      const entries = [];
      const files = new Map();
      let totalBytes = 0;
      for (const session of state.sessions) {
        const nodes = Array.isArray(session.tree) && session.tree.length
          ? session.tree
          : (session.messages || []);
        for (const node of nodes) {
          if (!node || node.role !== 'assistant' || !node.tts) continue;
          const text = ttsSpeechText(node);
          if (!text) continue;
          for (const voice of ['stella', 'tide']) {
            if (!node.tts[voice]) continue;
            const key = ttsCacheKey(text, voice);
            const file = `deepseek_tts/${voice}-${key.replace(/[^A-Za-z0-9_-]/g, '_')}.wav`;
            if (!files.has(file)) {
              const blob = await ttsCacheGet(key);
              if (!blob) continue;
              files.set(file, blob);
              totalBytes += blob.size;
            }
            entries.push({
              session_id: session.id,
              voice,
              message_text: text,
              file,
            });
          }
        }
      }
      return { entries, files, totalBytes };
    }

    async function estimateExport() {
      const sessions = state.sessions.filter((session) => {
        const nodes = session.tree || session.messages;
        return Array.isArray(nodes) && nodes.length > 0;
      });
      let nodeCount = 0;
      let textChars = 0;
      for (const session of sessions) {
        const nodes = session.tree || session.messages || [];
        nodeCount += nodes.length;
        for (const node of nodes) {
          textChars += String(node.text || '').length
            + String(node.reasoning || '').length
            + String(node.error || '').length;
        }
      }
      const tts = await collectTtsExport();
      exportState = { sessions, tts, nodeCount, textChars, busy: false };
      if (exportSummaryEl) {
        const mb = (textChars * 3 / (1024 * 1024)).toFixed(1);
        exportSummaryEl.textContent = `${sessions.length} 个对话 · ${nodeCount} 个节点 · 文本约 ${mb} MB`;
      }
      if (exportCountEl) {
        exportCountEl.textContent = `${sessions.length} 个对话 · ${tts.entries.length} 条语音`;
      }
      if (exportTtsDescEl) {
        exportTtsDescEl.textContent = tts.entries.length
          ? `含 ${tts.entries.length} 条语音（约 ${(tts.totalBytes / (1024 * 1024)).toFixed(1)} MB）`
          : '暂无已合成语音';
      }
      const ttsOption = exportPreviewEl?.querySelector('[data-export-mode="tts"]');
      if (ttsOption) ttsOption.disabled = tts.entries.length === 0;
      exportPreviewEl?.querySelectorAll('[data-export-mode]').forEach((button) => {
        button.disabled = !sessions.length || (button.dataset.exportMode === 'tts' && !tts.entries.length);
      });
    }

    function openExportDialog() {
      if (!exportPreviewEl) return;
      closeSettings();
      closeImportPreview();
      closeCapabilities(true);
      exportState = null;
      exportPreviewEl.hidden = false;
      exportPreviewEl.classList.remove('show');
      if (exportSummaryEl) exportSummaryEl.textContent = '正在统计…';
      if (exportCountEl) exportCountEl.textContent = '';
      exportPreviewEl.querySelectorAll('[data-export-mode]').forEach((button) => { button.disabled = true; });
      requestAnimationFrame(() => requestAnimationFrame(() => exportPreviewEl.classList.add('show')));
      setTimeout(() => exportPreviewEl.classList.add('show'), 80);
      void estimateExport().catch(() => {
        if (exportSummaryEl) exportSummaryEl.textContent = '统计失败，请重试';
      });
    }

    function closeExportDialog() {
      if (!exportPreviewEl || exportPreviewEl.hidden) return;
      exportPreviewEl.classList.remove('show');
      const timer = setTimeout(() => {
        timers.delete(timer);
        exportPreviewEl.hidden = true;
        exportState = null;
      }, 140);
      timers.add(timer);
    }

    function downloadExportBlob(blob, filename) {
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      const timer = setTimeout(() => {
        timers.delete(timer);
        URL.revokeObjectURL(url);
      }, 60_000);
      timers.add(timer);
    }

    async function exportAll(mode) {
      if (!exportState || exportState.busy) return;
      if (!exportState.sessions.length) {
        showToast('没有可导出的对话');
        return;
      }
      const selectedMode = mode === 'tts' && exportState.tts.entries.length ? 'tts' : 'text';
      exportState.busy = true;
      const optionButtons = [...exportPreviewEl.querySelectorAll('[data-export-mode]')];
      optionButtons.forEach((button) => { button.disabled = true; });
      const chosen = exportPreviewEl.querySelector(`[data-export-mode="${selectedMode}"]`);
      const titleNode = chosen?.querySelector('.dsc-export-option-title');
      const originalTitle = titleNode?.innerHTML || '';
      if (titleNode) titleNode.innerHTML = '<span class="dsc-spinner" aria-hidden="true"></span>导出中…';
      chosen?.classList.add('is-busy');
      try {
        const zip = new JSZip();
        zip.file('manifest.json', JSON.stringify({ export_format_version: 3 }));
        zip.file('deepseek_local.json', JSON.stringify({
          version: 1,
          generator: 'dsh-chat-with-deepseek',
          keep_ids: true,
          exported_at: new Date().toISOString(),
        }));
        const usedFileIds = new Set();
        const index = [];
        const exportedIds = new Set();
        for (const session of exportState.sessions) {
          const payload = buildExportSession(session, usedFileIds);
          if (!payload) continue;
          exportedIds.add(String(session.id));
          zip.file(`chat_sessions/${payload.fileId}.json`, JSON.stringify(payload.session));
          index.push({
            id: payload.session.id,
            title: payload.session.title,
            pinned: payload.session.pinned,
            message_count: payload.session.messages.length,
            inserted_at: payload.session.inserted_at,
            updated_at: payload.session.updated_at,
          });
        }
        zip.file('chat_session_index.json', JSON.stringify(index));
        if (selectedMode === 'tts' && exportState.tts.entries.length) {
          const items = exportState.tts.entries.filter((item) => exportedIds.has(String(item.session_id)));
          zip.file('deepseek_tts/manifest.json', JSON.stringify({ version: 1, items }));
          for (const [file, blob] of exportState.tts.files) {
            zip.file(file, blob, { compression: 'STORE' });
          }
        }
        let lastToast = 0;
        const blob = await zip.generateAsync({
          type: 'blob',
          compression: 'DEFLATE',
          compressionOptions: { level: 6 },
        }, (meta) => {
          const percent = Math.round(meta.percent || 0);
          if (percent >= lastToast + 10) {
            lastToast = percent;
            if (percent < 100) showToast(`正在导出… ${percent}%`);
          }
        });
        const date = new Date();
        const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        downloadExportBlob(blob, `deepseek_data-${stamp}.zip`);
        closeExportDialog();
        showToast(`已导出 ${index.length} 个对话${selectedMode === 'tts' ? `（含 ${exportState?.tts?.entries?.length || 0} 条语音）` : ''}`, {
          success: true,
          top: true,
        });
      } catch (error) {
        showToast(error instanceof Error ? error.message : '导出失败');
      } finally {
        if (titleNode) titleNode.innerHTML = originalTitle;
        chosen?.classList.remove('is-busy');
        if (exportState) exportState.busy = false;
        optionButtons.forEach((button) => {
          if (!exportState) { button.disabled = false; return; }
          button.disabled = !exportState.sessions.length
            || (button.dataset.exportMode === 'tts' && !exportState.tts.entries.length);
        });
      }
    }

    async function restoreTtsFromArchive(tts, importedSessions) {
      const zip = tts?.zip;
      const items = Array.isArray(tts?.manifest?.items) ? tts.manifest.items : [];
      if (!zip || !items.length) return 0;
      const selected = new Set((importedSessions || []).map((session) => String(session.id)));
      const blobs = new Map();
      let restored = 0;
      for (const item of items) {
        if (!item || !selected.has(String(item.session_id))) continue;
        const session = state.sessions.find((entry) => String(entry.id) === String(item.session_id));
        if (!session) continue;
        const nodes = Array.isArray(session.tree) && session.tree.length
          ? session.tree
          : (session.messages || []);
        const messageText = String(item.message_text || '');
        if (!messageText) continue;
        const node = nodes.find((entry) => entry
          && entry.role === 'assistant'
          && entry.text
          && entry.text === messageText)
          || nodes.find((entry) => entry
            && entry.role === 'assistant'
            && entry.text
            && (entry.text.includes(messageText) || messageText.includes(entry.text)));
        if (!node) continue;
        const voice = item.voice === 'tide' ? 'tide' : 'stella';
        const file = zip.file(item.file);
        if (!file) continue;
        let blob = blobs.get(item.file);
        if (!blob) {
          try {
            blob = await file.async('blob');
          } catch {
            continue;
          }
          blobs.set(item.file, blob);
        }
        await ttsCachePut(ttsCacheKey(node.text, voice), blob);
        node.tts = { ...(node.tts || {}), [voice]: true };
        restored += 1;
      }
      if (restored) {
        storeSessions(state.sessions);
        renderSessions();
        if (state.view === 'chat') renderMessages();
      }
      return restored;
    }

    async function importedSessionsFromZip(buffer, onProgress) {
      if (typeof JSZip === 'undefined') throw new Error('缺少 ZIP 解析组件');
      if (!buffer || buffer.byteLength > EXPORT_ARCHIVE_MAX_BYTES) throw new Error('导出包超过 512MB');
      const zip = await JSZip.loadAsync(buffer, { checkCRC32: false });
      const manifestFile = zip.file('manifest.json');
      if (!manifestFile) throw new Error('不是 DeepSeek 导出包：缺少 manifest.json');
      let manifest;
      try {
        manifest = JSON.parse(await manifestFile.async('string'));
      } catch {
        throw new Error('导出包 manifest.json 无法解析');
      }
      const version = Number(manifest?.export_format_version);
      if (version !== EXPORT_ARCHIVE_VERSION) {
        throw new Error(`不支持的导出格式版本：${Number.isFinite(version) ? version : '未知'}`);
      }
      let keepIds = false;
      const localMeta = zip.file('deepseek_local.json');
      if (localMeta) {
        try {
          const meta = JSON.parse(await localMeta.async('string'));
          keepIds = meta?.keep_ids === true;
        } catch { /* optional local metadata */ }
      }
      let tts = null;
      const ttsManifestFile = zip.file('deepseek_tts/manifest.json');
      if (ttsManifestFile) {
        try {
          const manifest = JSON.parse(await ttsManifestFile.async('string'));
          if (manifest && Array.isArray(manifest.items)) tts = { manifest, zip };
        } catch { /* optional TTS extension */ }
      }
      const names = Object.keys(zip.files).filter((name) =>
        name.startsWith('chat_sessions/') && name.endsWith('.json') && !name.includes('_files/'));
      const sessions = [];
      let textChars = 0;
      for (let index = 0; index < names.length; index += 1) {
        try {
          const entry = zip.file(names[index]);
          if (!entry) continue;
          const raw = JSON.parse(await entry.async('string'));
          textChars += JSON.stringify(raw).length;
          if (textChars > EXPORT_TEXT_MAX_CHARS) throw new Error('导出包文本超过安全上限');
          const session = convertExportSession(raw, { keepIds });
          if (session) sessions.push(session);
        } catch (error) {
          if (error instanceof Error && error.message.includes('安全上限')) throw error;
          // A broken single session must not discard the rest of the export.
        }
        if (onProgress && (index % 25 === 0 || index === names.length - 1)) {
          onProgress(index + 1, names.length);
        }
      }
      return { sessions, imageCount: Object.keys(zip.files).filter((name) => name.includes('_files/')).length, tts };
    }

    function toImportedSession(raw) {
      if (!raw || typeof raw !== 'object') return null;
      const rawMessages = Array.isArray(raw.messages) ? raw.messages
        : Array.isArray(raw.chat_messages) ? raw.chat_messages
          : Array.isArray(raw.message_list) ? raw.message_list
            : [];
      const messages = rawMessages.map((message) => {
        const role = importedRole(message?.role);
        const text = stripControlChars(importedText(message)).trim();
        if (!role || !text) return null;
        return role === 'assistant'
          ? { role, text, html: renderMarkdown(text) }
          : { role, text };
      }).filter(Boolean);
      if (!messages.length) return null;
      const times = rawMessages
        .map((message) => Number(message?.inserted_at || message?.created_at || message?.createdAt))
        .filter((time) => time > 0);
      const createdAt = Number(raw.createdAt || raw.created_at || raw.inserted_at)
        || (times.length ? Math.min(...times) : Date.now());
      const updatedAt = Number(raw.updatedAt || raw.updated_at)
        || (times.length ? Math.max(...times) : createdAt);
      const sessionTitle = raw.title || raw.name || raw.chat_session?.title || '';
      const title = String(sessionTitle).trim()
        || (messages.find((message) => message.role === 'user')?.text || '').slice(0, 30)
        || '导入的对话';
      return {
        id: `imp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        title: title.slice(0, 60),
        createdAt,
        updatedAt,
        pinned: false,
        messages,
      };
    }

    function importedSessionsFromJson(json) {
      const candidates = [];
      const biz = json?.data?.biz_data;
      if (biz && (Array.isArray(biz.chat_messages) || biz.chat_session)) {
        candidates.push({ ...biz.chat_session, messages: biz.chat_messages || biz.messages });
      } else if (Array.isArray(json)) {
        candidates.push(...json);
      } else if (Array.isArray(json?.sessions)) {
        candidates.push(...json.sessions);
      } else if (Array.isArray(json?.conversations)) {
        candidates.push(...json.conversations);
      } else if (Array.isArray(json?.data?.conversations)) {
        candidates.push(...json.data.conversations);
      } else if (json && typeof json === 'object') {
        candidates.push(json);
      }
      return candidates.map(toImportedSession).filter(Boolean);
    }

    let importBusy = false;
    let legacyArmTimer = null;

    function isImportedSession(session) {
      const id = String(session?.id || '');
      return id.startsWith('ds-') || id.startsWith('imp-');
    }

    function preserveImportedLocalState(localSession, importedSession) {
      // Local actions that do not bump updatedAt (pin, synthesized TTS) are
      // newer than the archive and must survive an overwrite.
      importedSession.pinned = localSession.pinned === true || importedSession.pinned === true;
      if (localSession.model) {
        importedSession.model = localSession.model;
        importedSession.provider = localSession.provider || '';
      }
      const ttsByText = new Map();
      for (const message of localSession.messages || []) {
        if (message.role === 'assistant' && message.text && message.tts
          && (message.tts.stella || message.tts.tide)) {
          ttsByText.set(message.text, message.tts);
        }
      }
      if (ttsByText.size) {
        for (const message of importedSession.messages || []) {
          if (message.role !== 'assistant' || !message.text) continue;
          const tts = ttsByText.get(message.text);
          if (tts) message.tts = tts;
        }
      }
      return importedSession;
    }

    // Cheap content signature used to recognize a re-imported archive.
    // Pinned state and TTS flags are deliberately excluded: they are local
    // choices and must not force a rewrite.
    function sessionContentSignature(session) {
      let hash = 2166136261;
      const feed = (value) => {
        const text = String(value || '');
        for (let index = 0; index < text.length; index += 1) {
          hash ^= text.charCodeAt(index);
          hash = Math.imul(hash, 16777619);
        }
        hash ^= 0x1f;
        hash = Math.imul(hash, 16777619);
      };
      feed(session.title);
      feed(session.createdAt);
      feed(session.updatedAt);
      const nodes = Array.isArray(session.tree) && session.tree.length
        ? session.tree
        : (session.messages || []);
      for (const message of nodes) {
        feed(message.id);
        feed(message.parentId);
        feed(message.role);
        feed(message.text);
        feed(message.reasoning);
        feed(message.error);
        for (const source of message.sources || []) feed(source.url);
        for (const attachment of message.attachments || []) feed(attachment.name);
      }
      return `${nodes.length}:${hash >>> 0}`;
    }

    // ---- import preview, batches and undo ---------------------------
    function importStatusFor(session, byId, fingerprints) {
      const local = byId.get(session.id);
      if (local) {
        if (streams.has(session.id)) return { kind: 'streaming', label: '生成中', selectable: false };
        if (Number(local.updatedAt) > Number(session.updatedAt)) {
          return { kind: 'local', label: '本地较新', selectable: false };
        }
        if (sessionContentSignature(local) === sessionContentSignature(session)) {
          return { kind: 'same', label: '已存在', selectable: false };
        }
        return { kind: 'update', label: '将更新', selectable: true };
      }
      if (fingerprints.has(`${session.title}|${session.createdAt}`)) {
        return { kind: 'dup', label: '重复', selectable: false };
      }
      return { kind: 'new', label: '新增', selectable: true };
    }

    function formatImportDate(timestamp) {
      const date = new Date(Number(timestamp) || Date.now());
      const pad = (value) => String(value).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    function openImportPreview(sessions, options = {}) {
      closeCapabilities(true);
      if (!sessions.length) {
        showToast('没有找到可导入的对话');
        return;
      }
      const byId = new Map(state.sessions.map((session) => [session.id, session]));
      const fingerprints = new Set(state.sessions.map((session) => `${session.title}|${session.createdAt}`));
      const items = sessions.map((session) => ({
        session,
        status: importStatusFor(session, byId, fingerprints),
      }));
      const selected = new Set();
      for (const item of items) if (item.status.selectable) selected.add(item.session.id);
      importPreviewState = {
        items,
        selected,
        source: options.source || 'zip',
        imageCount: Number(options.imageCount) || 0,
        tts: options.tts || null,
        query: '',
      };
      if (importSearchEl) importSearchEl.value = '';
      renderImportPreview();
      importPreviewEl.hidden = false;
      importPreviewEl.classList.remove('show');
      requestAnimationFrame(() => requestAnimationFrame(() => importPreviewEl.classList.add('show')));
      setTimeout(() => importPreviewEl.classList.add('show'), 80);
      requestAnimationFrame(() => importSearchEl?.focus({ preventScroll: true }));
    }

    function renderImportPreview() {
      if (!importPreviewState) return;
      const preview = importPreviewState;
      const counts = { new: 0, update: 0, same: 0, local: 0, dup: 0, streaming: 0 };
      for (const item of preview.items) counts[item.status.kind] += 1;
      const summary = [`发现 ${preview.items.length} 个对话`, `新增 ${counts.new}`, `将更新 ${counts.update}`, `已存在 ${counts.same}`];
      if (counts.local) summary.push(`本地较新 ${counts.local}`);
      if (counts.dup) summary.push(`重复 ${counts.dup}`);
      if (counts.streaming) summary.push(`生成中 ${counts.streaming}`);
      if (preview.tts?.manifest?.items?.length) summary.push(`含 ${preview.tts.manifest.items.length} 条语音`);
      importSummaryEl.textContent = summary.join(' · ');
      const query = preview.query.trim().toLowerCase();
      const items = preview.items.filter((item) => !query || item.session.title.toLowerCase().includes(query));
      importListEl.innerHTML = items.length
        ? items.map((item) => {
          const checked = preview.selected.has(item.session.id) ? ' checked' : '';
          const disabled = item.status.selectable ? '' : ' disabled';
          return `<label class="dsc-import-row" data-kind="${item.status.kind}">
            <input type="checkbox" data-import-id="${escapeHtml(item.session.id)}"${checked}${disabled}>
            <span class="dsc-import-row-main">
              <span class="dsc-import-row-title">${escapeHtml(item.session.title)}</span>
              <span class="dsc-import-row-meta">${formatImportDate(item.session.updatedAt)} · ${item.session.tree?.length || item.session.messages.length} 个节点${item.session.tree && item.session.tree.length !== item.session.messages.length ? ` · 当前分支 ${item.session.messages.length} 条` : ''}</span>
            </span>
            <span class="dsc-import-badge" data-kind="${item.status.kind}">${item.status.label}</span>
          </label>`;
        }).join('')
        : '<div class="dsc-import-empty">没有匹配的对话</div>';
      updateImportPreviewCount();
    }

    function updateImportPreviewCount() {
      if (!importPreviewState) return;
      const count = importPreviewState.selected.size;
      importSelectedCountEl.textContent = `已选 ${count} 个`;
      if (importConfirmButton) {
        importConfirmButton.disabled = count === 0;
        importConfirmButton.textContent = `导入选中的 ${count} 个`;
      }
    }

    function closeImportPreview() {
      if (importPreviewEl.hidden) return;
      importPreviewEl.classList.remove('show');
      const timer = setTimeout(() => {
        timers.delete(timer);
        importPreviewEl.hidden = true;
        importPreviewState = null;
      }, 140);
      timers.add(timer);
    }

    function setImportPreviewSelection(select) {
      if (!importPreviewState) return;
      const query = importPreviewState.query.trim().toLowerCase();
      for (const item of importPreviewState.items) {
        if (!item.status.selectable) continue;
        if (query && !item.session.title.toLowerCase().includes(query)) continue;
        if (select) importPreviewState.selected.add(item.session.id);
        else importPreviewState.selected.delete(item.session.id);
      }
      renderImportPreview();
    }

    function confirmImportPreview() {
      if (!importPreviewState) return;
      const sessions = importPreviewState.items
        .filter((item) => importPreviewState.selected.has(item.session.id))
        .map((item) => item.session);
      const source = importPreviewState.source;
      const imageCount = importPreviewState.imageCount;
      const tts = importPreviewState.tts;
      closeImportPreview();
      if (!sessions.length) return;
      applyImportSessions(sessions, { source, imageCount, tts });
    }

    function applyImportSessions(sessions, options = {}) {
      const batchId = `ib-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const at = Date.now();
      const { added, updated, unchanged, kept, skipped } = mergeImportedSessions(sessions, {
        batchId,
        at,
        source: options.source || 'zip',
      });
      if (!added && !updated) {
        showToast(unchanged || kept ? '没有变化（导入内容与本地一致）' : '没有新的对话可导入');
        renderLastImport();
        return;
      }
      const parts = [];
      if (added) parts.push(`新增 ${added}`);
      if (updated) parts.push(`更新 ${updated}`);
      if (unchanged) parts.push(`跳过相同 ${unchanged}`);
      if (kept) parts.push(`保留较新 ${kept}`);
      if (skipped) parts.push(`跳过重复 ${skipped}`);
      showToast(`导入完成：${parts.join('，')}`, {
        success: true,
        top: true,
        duration: 10_000,
        action: { label: '撤销', onClick: () => undoImportBatch(batchId) },
      });
      renderLastImport();
      if (options.tts) void restoreTtsFromArchive(options.tts, sessions);
    }

    function latestImportBatch() {
      let latest = null;
      for (const session of state.sessions) {
        if (!session.importBatch) continue;
        const at = Number(session.importedAt) || 0;
        if (!latest || at > latest.at) {
          latest = { id: session.importBatch, at, source: session.importSource || 'zip' };
        }
      }
      if (!latest) return null;
      latest.sessions = state.sessions.filter((session) => session.importBatch === latest.id);
      return latest;
    }

    function renderLastImport() {
      const row = $('[data-role="last-import"]');
      const desc = $('[data-role="last-import-desc"]');
      const button = $('[data-act="undo-import"]');
      const legacyRow = $('[data-role="legacy-import"]');
      const legacyDesc = $('[data-role="legacy-import-desc"]');
      if (!row || !desc || !button || !legacyRow || !legacyDesc) return;
      const batch = latestImportBatch();
      if (batch) {
        row.hidden = false;
        desc.textContent = `${batch.sessions.length} 个 · ${formatImportDate(batch.at)}`;
        button.textContent = '撤销';
        button.disabled = batch.sessions.length === 0;
      } else {
        row.hidden = true;
        button.disabled = true;
      }
      const legacyButton = $('[data-act="clear-legacy-import"]');
      if (legacyButton) {
        delete legacyButton.dataset.armed;
        legacyButton.classList.remove('is-danger');
        legacyButton.textContent = '清理';
      }
      const legacy = state.sessions.filter((session) => !session.importBatch && isImportedSession(session));
      legacyRow.hidden = legacy.length === 0;
      legacyDesc.textContent = legacy.length ? `${legacy.length} 个（启用批次记录前导入）` : '';
    }

    function undoImportBatch(batchId) {
      const batchSessions = state.sessions.filter((session) => session.importBatch === batchId);
      if (!batchSessions.length) return;
      const removeIds = new Set();
      let kept = 0;
      for (const session of batchSessions) {
        if (streams.has(session.id) || Number(session.updatedAt) > Number(session.importedAt)) {
          kept += 1;
          continue;
        }
        removeIds.add(session.id);
      }
      state.sessions = state.sessions.filter((session) => !removeIds.has(session.id));
      void pruneTtsCache();
      for (const session of state.sessions) {
        if (session.importBatch !== batchId) continue;
        delete session.importBatch;
        delete session.importedAt;
        delete session.importSource;
      }
      if (state.activeId && removeIds.has(state.activeId)) {
        state.activeId = null;
        state.messages = [];
        syncBusy();
        setView('welcome');
        clearComposers();
      }
      storeSessions(state.sessions);
      renderSessions();
      renderLastImport();
      showToast(`已撤销 ${removeIds.size} 个导入对话${kept ? `，保留 ${kept} 个已编辑` : ''}`, {
        success: true,
        top: true,
      });
    }

    function requestUndoImport() {
      const batch = latestImportBatch();
      if (batch) {
        if (!batch.sessions.length) {
          showToast('没有可撤销的导入');
          return;
        }
        if (dialogCloseTimer) {
          clearTimeout(dialogCloseTimer);
          dialogCloseTimer = null;
        }
        dialogMode = 'undo-import';
        dialogIds = [batch.id];
        dialogBatchId = batch.id;
        dialogTitle.textContent = `撤销最近一次导入的 ${batch.sessions.length} 个对话?`;
        dialogDesc.textContent = '导入后继续聊过的会话会保留；其余导入会话将删除，且不可恢复。';
        dialogDesc.hidden = false;
        dialogConfirm.textContent = '撤销';
        dialogConfirm.classList.remove('is-primary');
        dialogConfirm.classList.add('is-danger');
        if (dialogCancel) dialogCancel.textContent = '取消';
        dialogEl.hidden = false;
        dialogEl.classList.remove('show');
        requestAnimationFrame(() => requestAnimationFrame(() => {
          dialogEl.classList.add('show');
          dialogConfirm.focus({ preventScroll: true });
        }));
        setTimeout(() => dialogEl.classList.add('show'), 80);
        return;
      }
      // Legacy imports predate batch metadata: fall back to the old cleanup.
      requestClearImported();
    }

    function mergeImportedSessions(imported, options = {}) {
      const localById = new Map();
      const fingerprints = new Set();
      for (let index = 0; index < state.sessions.length; index += 1) {
        const session = state.sessions[index];
        localById.set(session.id, index);
        fingerprints.add(`${session.title}|${session.createdAt}`);
      }
      const merged = [...state.sessions];
      let added = 0;
      let updated = 0;
      let unchanged = 0;
      let kept = 0;
      let skipped = 0;
      for (const session of imported) {
        ensureSessionTree(session);
        if (options.batchId) {
          session.importBatch = options.batchId;
          session.importedAt = Number(options.at) || Date.now();
          session.importSource = options.source || 'zip';
        }
        const index = localById.get(session.id);
        if (index != null) {
          const local = merged[index];
          // Never replace a session that is currently streaming, and keep a
          // local conversation that has messages newer than the archive.
          if (streams.has(session.id) || Number(local.updatedAt) > Number(session.updatedAt)) {
            kept += 1;
            continue;
          }
          if (sessionContentSignature(local) === sessionContentSignature(session)) {
            unchanged += 1;
            continue;
          }
          merged[index] = preserveImportedLocalState(local, session);
          updated += 1;
          continue;
        }
        const fingerprint = `${session.title}|${session.createdAt}`;
        if (fingerprints.has(fingerprint)) {
          skipped += 1;
          continue;
        }
        merged.push(session);
        localById.set(session.id, merged.length - 1);
        fingerprints.add(fingerprint);
        added += 1;
      }
      merged.sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt));
      state.sessions = merged;
      if (updated && state.activeId && !streams.has(state.activeId)) {
        const active = sessionById(state.activeId);
        if (active) {
          state.messages = active.messages;
          if (state.view === 'chat') renderMessages();
        }
      }
      if (added || updated) {
        if (sessionsTextSize(imported) > LOCAL_MIRROR_LIMIT) {
          localMirrorDisabled = true;
          try { localStorage.removeItem(SESSIONS_KEY); } catch { /* ignore */ }
        }
        storeSessions(state.sessions);
        renderSessions();
      }
      return { added, updated, unchanged, kept, skipped };
    }

    async function importArchiveBuffer(buffer, sourceLabel) {
      if (!buffer || buffer.byteLength > EXPORT_ARCHIVE_MAX_BYTES) {
        showToast('导出包超过 512MB');
        return;
      }
      showToast('正在解析导出包…');
      let result;
      try {
        result = await importedSessionsFromZip(buffer, (done, total) => {
          if (done === total || done % 50 === 0) showToast(`正在解析导出包 ${done}/${total}…`);
        });
      } catch (error) {
        showToast(error instanceof Error ? error.message : '导出包解析失败');
        return;
      }
      openImportPreview(result.sessions, { source: sourceLabel, imageCount: result.imageCount, tts: result.tts });
    }

    function setImportLinkBusy(busy) {
      if (!importLinkButton) return;
      importLinkButton.disabled = busy;
      importLinkButton.classList.toggle('is-busy', busy);
      importLinkButton.setAttribute('aria-busy', busy ? 'true' : 'false');
      importLinkButton.innerHTML = busy
        ? '<span class="dsc-spinner" aria-hidden="true"></span>导入中'
        : '下载并导入';
      if (importUrlEl) importUrlEl.disabled = busy;
    }

    async function importFromLink() {
      const input = importUrlEl;
      const url = String(input?.value || '').trim();
      if (!url) {
        showToast('请先粘贴导出链接');
        input?.focus();
        return;
      }
      if (!/^https:\/\//i.test(url)) {
        showToast('只支持 https 导出链接');
        return;
      }
      if (importBusy) return;
      importBusy = true;
      setImportLinkBusy(true);
      try {
        showToast('正在下载导出包…');
        let response = null;
        try {
          const hostResponse = await fetch(new URL('import/fetch', API_BASE), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url }),
          });
          if (hostResponse.ok) {
            response = hostResponse;
          } else if (hostResponse.status !== 404 && hostResponse.status !== 501) {
            const data = await hostResponse.json().catch(() => ({}));
            showToast(data.message || `下载失败（HTTP ${hostResponse.status}）`);
            return;
          }
        } catch {
          response = null;
        }
        if (!response) {
          try {
            response = await fetch(url, { cache: 'no-store' });
          } catch {
            showToast('链接下载失败：可能被跨域限制，请下载 ZIP 后导入');
            return;
          }
        }
        if (!response.ok) {
          showToast(`下载失败（HTTP ${response.status}）`);
          return;
        }
        const blob = await response.blob();
        await importArchiveBuffer(await blob.arrayBuffer(), 'link');
        if (input) input.value = '';
      } catch (error) {
        showToast(error instanceof Error ? error.message : '下载失败');
      } finally {
        setImportLinkBusy(false);
        importBusy = false;
      }
    }

    async function fileLooksLikeZip(file) {
      if (/\.zip$/i.test(file.name || '')) return true;
      try {
        const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
        return head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b
          && (head[2] === 0x03 || head[2] === 0x05 || head[2] === 0x07);
      } catch {
        return false;
      }
    }

    async function handleImportFile(event) {
      const file = event.target.files && event.target.files[0];
      event.target.value = '';
      if (!file || importBusy) return;
      if (await fileLooksLikeZip(file)) {
        if (file.size > EXPORT_ARCHIVE_MAX_BYTES) {
          showToast('导出包超过 512MB');
          return;
        }
        importBusy = true;
        try {
          await importArchiveBuffer(await file.arrayBuffer(), 'zip');
        } catch (error) {
          showToast(error instanceof Error ? error.message : '导出包读取失败');
        } finally {
          importBusy = false;
        }
        return;
      }
      if (file.size > 64_000_000) {
        showToast('JSON 导入文件超过 64MB');
        return;
      }
      let json;
      try {
        json = JSON.parse(await file.text());
      } catch {
        showToast('无法解析：请选择 DeepSeek 导出的 ZIP 或 JSON');
        return;
      }
      const imported = importedSessionsFromJson(json);
      openImportPreview(imported, { source: 'json' });
    }

    function openSessionMenu(id, trigger) {
      const session = sessionById(id);
      if (!session || !trigger) return;
      if (state.sessionMenuId === id && !sessionMenuEl.hidden) {
        closeSessionMenu();
        return;
      }
      closeSessionMenu();
      state.sessionMenuId = id;
      sessionMenuEl.innerHTML = `
        <button class="dsc-session-menu-item" data-menu-act="rename" role="menuitem">${icon('edit', 17)}<span>重命名</span></button>
        <button class="dsc-session-menu-item" data-menu-act="pin" role="menuitem">${icon('pin', 17)}<span>置顶</span></button>
        <button class="dsc-session-menu-item" data-menu-act="multi" role="menuitem">${icon('listSelect', 17)}<span>多选</span></button>
        <button class="dsc-session-menu-item danger" data-menu-act="delete" role="menuitem">${icon('trash', 17)}<span>删除</span></button>`;
      sessionMenuEl.hidden = false;
      sessionMenuEl.style.left = '0px';
      sessionMenuEl.style.top = '0px';
      sessionMenuEl.style.visibility = 'hidden';
      const rootRect = root.getBoundingClientRect();
      const rect = trigger.getBoundingClientRect();
      const menuWidth = sessionMenuEl.offsetWidth;
      const menuHeight = sessionMenuEl.offsetHeight;
      let left = rect.left - rootRect.left - 6;
      if (left + menuWidth > rootRect.width - 8) left = rect.right - rootRect.left - menuWidth + 6;
      left = Math.max(8, Math.min(left, rootRect.width - menuWidth - 8));
      let top = rect.top - rootRect.top - 6;
      if (top + menuHeight > rootRect.height - 8) top = rootRect.height - menuHeight - 8;
      top = Math.max(8, top);
      sessionMenuEl.style.left = `${Math.round(left)}px`;
      sessionMenuEl.style.top = `${Math.round(top)}px`;
      sessionMenuEl.style.visibility = '';
    }

    function startRename(id) {
      if (!sessionById(id)) return;
      closeSessionMenu();
      state.renamingId = id;
      renderSessions();
    }

    function commitRename() {
      const id = state.renamingId;
      if (!id) return;
      const input = sessionsEl.querySelector('[data-rename-input]');
      const session = sessionById(id);
      if (input && session) {
        const title = input.value.replace(/\s+/g, ' ').trim().slice(0, 60);
        if (title) session.title = title;
        storeSessions(state.sessions);
        if (state.activeId === id) titleEl.textContent = session.title;
      }
      state.renamingId = null;
      renderSessions();
    }

    function cancelRename() {
      if (!state.renamingId) return;
      state.renamingId = null;
      renderSessions();
    }

    function deleteSingleSession(id) {
      const session = sessionById(id);
      if (!session) return;
      abortSessionStream(id);
      state.sessions = state.sessions.filter((item) => item.id !== id);
      void pruneTtsCache();
      storeSessions(state.sessions);
      const activeDeleted = state.activeId === id;
      closeSessionMenu();
      if (activeDeleted) {
        state.activeId = null;
        state.messages = [];
        syncBusy();
        setView('welcome');
        clearComposers();
      }
      renderSessions();
      showToast('已删除 1 个对话');
    }

    function setSidebar(mode) {
      if (state.sidebar === mode) return;
      if (sidebarTimer) {
        clearTimeout(sidebarTimer);
        timers.delete(sidebarTimer);
        sidebarTimer = null;
      }
      state.sidebar = mode;
      root.dataset.sidebar = mode;
      root.dataset.sidebarPhase = mode === 'collapsed' ? 'closing' : 'opening';
      remember(sidebarKey, mode);
      const toggle = $('[data-act="toggle-sidebar"]', $('.dsc-sidebar'));
      if (toggle) toggle.setAttribute('aria-label', mode === 'collapsed' ? '展开侧栏' : '收起侧栏');
      sidebarTimer = setTimeout(() => {
        timers.delete(sidebarTimer);
        sidebarTimer = null;
        root.dataset.sidebarPhase = 'idle';
      }, 240);
      timers.add(sidebarTimer);
    }

    function thinkLabel(level) {
      return THINK_LEVELS.find((item) => item.value === level)?.label || 'High';
    }

    function renderThinkOptions() {
      thinkOptions.innerHTML = THINK_LEVELS.map((item) => `
        <button class="dsc-think-option" role="menuitemradio" aria-checked="${state.thinking === item.value}" data-think-option="${item.value}">
          <span class="dsc-opt-text"><span class="dsc-opt-main">${item.label}</span></span>
          ${state.thinking === item.value ? `<span class="dsc-opt-check">${icon('check', 16)}</span>` : ''}
        </button>`).join('');
    }

    function setThinking(level) {
      const normalized = ['off', 'low', 'high', 'max'].includes(level) ? level : 'high';
      state.thinking = normalized;
      remember('dsc.thinking', normalized);
      const label = thinkLabel(normalized);
      $$('.dsc-think-trigger').forEach((btn) => {
        btn.setAttribute('aria-label', `思考强度：${label}`);
        btn.dataset.off = normalized === 'off' ? '1' : '0';
        btn.classList.toggle('active', normalized !== 'off' && isOfficialDeepSeekProvider(state.api.provider));
      });
      renderThinkOptions();
    }

    function positionThinkPop(trigger) {
      thinkPop.hidden = false;
      thinkPop.style.left = '0px';
      thinkPop.style.top = '0px';
      const rootRect = root.getBoundingClientRect();
      const rect = trigger.getBoundingClientRect();
      const popW = thinkPop.offsetWidth;
      const popH = thinkPop.offsetHeight;
      let left = rect.left - rootRect.left;
      left = Math.min(Math.max(8, left), Math.max(8, rootRect.width - popW - 8));
      let top = rect.top - rootRect.top - popH - 8;
      if (top < 8) top = rect.bottom - rootRect.top + 8;
      thinkPop.style.left = `${Math.round(left)}px`;
      thinkPop.style.top = `${Math.round(top)}px`;
    }

    function openThinkMenu(trigger) {
      if (thinkTrigger === trigger && !thinkPop.hidden) {
        closeThinkMenu();
        return;
      }
      closeModelMenu();
      closeSearchMenu();
      closeThinkMenu();
      thinkTrigger = trigger;
      trigger.setAttribute('aria-expanded', 'true');
      renderThinkOptions();
      positionThinkPop(trigger);
    }

    function closeThinkMenu() {
      if (thinkTrigger) thinkTrigger.setAttribute('aria-expanded', 'false');
      thinkTrigger = null;
      thinkPop.hidden = true;
    }

    function availableModels() {
      const models = (Array.isArray(state.api.models) ? state.api.models : [])
        .filter((model) => model && typeof model.id === 'string')
        .map((model) => ({
          id: model.id,
          name: model.name || model.id,
          description: model.description || '',
          provider: model.provider || '',
          providerName: model.providerName || '',
          reasoning: model.reasoning,
          inputModalities: Array.isArray(model.inputModalities) ? model.inputModalities : undefined,
        }));
      if (state.api.model && !models.some((model) => model.id === state.api.model)) {
        models.push({ id: state.api.model, name: modelLabel(state.api.model), provider: '', providerName: '当前配置' });
      }
      if (models.length === 0) {
        return MODEL_OPTIONS.map((model) => ({
          id: model.id, name: model.label, description: model.desc, provider: 'fallback', providerName: 'DeepSeek',
        }));
      }
      return models;
    }

    function modelName(id, provider = state.api.provider) {
      const models = availableModels();
      return (models.find((model) => model.id === id && model.provider === provider)
        || models.find((model) => model.id === id))?.name || modelLabel(id);
    }

    function renderModelLabel() {
      const label = modelName(state.api.model, state.api.provider);
      $$('[data-role="model-label"]').forEach((node) => {
        node.textContent = label;
      });
      $$('[data-act="model-menu"]').forEach((btn) => {
        btn.setAttribute('aria-label', `选择模型：${label}`);
      });
    }

    function renderModelOptions() {
      const groups = new Map();
      for (const model of availableModels()) {
        const key = model.providerName || '';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(model);
      }
      modelOptions.innerHTML = [...groups.entries()].map(([providerName, models]) => `
        ${providerName ? `<div class="dsc-model-group-label">${escapeHtml(providerName)}</div>` : ''}
        ${models.map((model) => {
          const imageCapable = Array.isArray(model.inputModalities) && model.inputModalities.includes('image');
          return `
          <button class="dsc-think-option" role="menuitemradio"
            aria-checked="${state.api.model === model.id && state.api.provider === model.provider}"
            data-model-option="${escapeHtml(model.id)}" data-model-provider="${escapeHtml(model.provider)}">
            <span class="dsc-opt-text"><span class="dsc-opt-main">${escapeHtml(model.name)}</span></span>
            ${imageCapable ? '<span class="dsc-model-badge">识图</span>' : ''}
            ${state.api.model === model.id && state.api.provider === model.provider ? `<span class="dsc-opt-check">${icon('check', 16)}</span>` : ''}
          </button>`;
        }).join('')}`).join('');
    }

    function positionModelPop(trigger) {
      modelPop.hidden = false;
      modelPop.style.left = '0px';
      modelPop.style.top = '0px';
      const rootRect = root.getBoundingClientRect();
      const rect = trigger.getBoundingClientRect();
      const popW = modelPop.offsetWidth;
      const popH = modelPop.offsetHeight;
      let left = rect.left - rootRect.left;
      left = Math.min(Math.max(8, left), Math.max(8, rootRect.width - popW - 8));
      let top = rect.top - rootRect.top - popH - 8;
      if (top < 8) top = rect.bottom - rootRect.top + 8;
      modelPop.style.left = `${Math.round(left)}px`;
      modelPop.style.top = `${Math.round(top)}px`;
    }

    function openModelMenu(trigger) {
      if (modelTrigger === trigger && !modelPop.hidden) {
        closeModelMenu();
        return;
      }
      closeThinkMenu();
      closeSearchMenu();
      closeModelMenu();
      modelTrigger = trigger;
      trigger.setAttribute('aria-expanded', 'true');
      renderModelOptions();
      positionModelPop(trigger);
    }

    function closeModelMenu() {
      if (modelTrigger) modelTrigger.setAttribute('aria-expanded', 'false');
      modelTrigger = null;
      modelPop.hidden = true;
    }

    function findAvailableModel(provider, model) {
      const models = availableModels();
      return models.find((item) => item.id === model && (!provider || item.provider === provider))
        || models.find((item) => item.id === model)
        || null;
    }

    function applyModelChoice(provider, model) {
      const selected = findAvailableModel(provider, model);
      if (!selected) return false;
      state.api.model = selected.id;
      state.api.provider = selected.provider;
      updateThinkSupport();
      updateSearchAvailability();
      renderModelLabel();
      return true;
    }

    function defaultModelChoice() {
      const candidates = [
        [state.lastUsedProvider, state.lastUsedModel],
        [state.api.provider, state.api.model],
      ];
      for (const [provider, model] of candidates) {
        if (!model) continue;
        const selected = findAvailableModel(provider, model);
        if (selected) return selected;
      }
      return availableModels()[0] || null;
    }

    function applyDefaultModel() {
      const selected = defaultModelChoice();
      if (selected) applyModelChoice(selected.provider, selected.id);
    }

    function applySessionModel(session) {
      if (session?.model && applyModelChoice(session.provider, session.model)) return;
      applyDefaultModel();
    }

    function commitSessionModel(session) {
      if (!session || !state.api.model) return;
      session.model = state.api.model;
      session.provider = state.api.provider || '';
      state.lastUsedModel = session.model;
      state.lastUsedProvider = session.provider;
      remember('dsc.lastModel', session.model);
      remember('dsc.lastProvider', session.provider);
    }

    async function selectModel(id, provider) {
      const next = String(id || '').trim();
      if (!next) return;
      state.api.model = next;
      state.api.provider = String(provider || '');
      updateThinkSupport();
      updateSearchAvailability();
      renderModelLabel();
      closeModelMenu();
      if (state.api.available) {
        try {
          const response = await fetch(new URL('config', API_BASE), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: next, provider: state.api.provider }),
            signal,
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(apiErrorMessage(data));
          Object.assign(state.api, data, { loaded: true, available: true });
          updateSearchAvailability();
          renderModelLabel();
          showToast(`已切换：${modelName(next, state.api.provider)}`);
        } catch (error) {
          showToast('模型已切换，但保存失败');
        }
      } else {
        showToast(`已切换：${modelName(next, state.api.provider)}`);
      }
    }

    function renderSearchOptions() {
      if (!searchOptionsEl) return;
      const items = [
        { id: 'off', label: '关闭', desc: '不联网，直接回答' },
        { id: 'fast', label: '快速', desc: '应用式检索，使用摘要' },
        { id: 'precise', label: '精确', desc: '读取前几篇网页全文，较慢但更准' },
      ];
      searchOptionsEl.innerHTML = items.map((item) => {
        const disabled = item.id === 'precise' && !state.api.fetchSupported;
        return `<button class="dsc-think-option" role="menuitemradio" aria-checked="${state.searchMode === item.id}" data-search-mode="${item.id}"${disabled ? ' disabled' : ''}>
          <span class="dsc-opt-text"><span class="dsc-opt-main">${item.label}</span><span class="dsc-opt-desc">${disabled ? '当前组合未加载网页读取' : item.desc}</span></span>
          ${state.searchMode === item.id ? `<span class="dsc-opt-check">${icon('check', 16)}</span>` : ''}
        </button>`;
      }).join('');
    }

    function setSearchMode(mode) {
      const normalized = mode === 'off' ? 'off' : 'on';
      state.searchMode = normalized;
      state.searchOn = normalized !== 'off';
      remember('dsc.searchMode', normalized);
      remember('dsc.searchOn', state.searchOn ? '1' : '0');
      $$('[data-act="toggle-search"]').forEach((btn) => {
        btn.classList.toggle('active', state.searchOn);
        btn.setAttribute('aria-pressed', state.searchOn ? 'true' : 'false');
        btn.dataset.mode = normalized;
        btn.dataset.tip = '按需搜索网页';
      });
      updateSearchAvailability();
    }

    function positionSearchPop(trigger) {
      searchPop.hidden = false;
      searchPop.style.left = '0px';
      searchPop.style.top = '0px';
      const rootRect = root.getBoundingClientRect();
      const rect = trigger.getBoundingClientRect();
      const popW = searchPop.offsetWidth;
      const popH = searchPop.offsetHeight;
      let left = rect.left - rootRect.left;
      left = Math.min(Math.max(8, left), Math.max(8, rootRect.width - popW - 8));
      let top = rect.top - rootRect.top - popH - 8;
      if (top < 8) top = rect.bottom - rootRect.top + 8;
      searchPop.style.left = `${Math.round(left)}px`;
      searchPop.style.top = `${Math.round(top)}px`;
    }

    function openSearchMenu(trigger) {
      if (searchTrigger === trigger && !searchPop.hidden) {
        closeSearchMenu();
        return;
      }
      closeThinkMenu();
      closeModelMenu();
      closeSearchMenu();
      searchTrigger = trigger;
      trigger.setAttribute('aria-expanded', 'true');
      renderSearchOptions();
      positionSearchPop(trigger);
    }

    function closeSearchMenu() {
      if (searchTrigger) searchTrigger.setAttribute('aria-expanded', 'false');
      searchTrigger = null;
      searchPop.hidden = true;
    }

    function setNotice() {
      $$('[data-role="notice"]').forEach((notice) => {
        notice.hidden = !state.quota;
      });
      if (heroTitle) {
        heroTitle.textContent = state.quota ? '你好，请等会儿来吧' : '你好，我是 DeepSeek';
      }
      $$('[data-role="notice-text"]').forEach((node) => {
        node.textContent = '服务器繁忙，使用额度已达上限，请稍后再试';
      });
    }

    function syncComposerHeights() {
      $$('.dsc-composer textarea').forEach((area) => {
        area.style.height = 'auto';
        area.style.height = `${Math.min(area.scrollHeight, 336)}px`;
      });
    }

    function currentText() {
      const area = $$('.dsc-composer textarea').find((item) => item.offsetParent !== null)
        || $('.dsc-composer textarea');
      return area ? area.value.trim() : '';
    }

    function clearComposers() {
      $$('.dsc-composer textarea').forEach((area) => {
        area.value = '';
        area.style.height = 'auto';
      });
      updateSendState();
    }

    function findButtonVisible() {
      return state.view === 'chat' && (state.messages.length > 0 || state.findOn);
    }

    function updateFindAvailability() {
      const visible = findButtonVisible();
      $$('.dsc-find').forEach((button) => {
        button.hidden = !visible;
        button.disabled = !visible;
        button.classList.toggle('active', state.findOn);
        button.setAttribute('aria-pressed', state.findOn ? 'true' : 'false');
      });
      $$('[data-role="find-count"]').forEach((el) => {
        el.hidden = !state.findOn;
      });
    }

    function findCountText() {
      if (!state.findQuery.trim()) return '';
      return state.findMatches.length ? `${state.findSel + 1}/${state.findMatches.length}` : '无结果';
    }

    function updateFindCount() {
      $$('[data-role="find-count"]').forEach((el) => {
        el.hidden = !state.findOn;
        el.textContent = state.findOn ? findCountText() : '';
      });
    }

    function applyFindHighlight(scroll = true) {
      if (!state.findOn) return;
      const match = state.findMatches[state.findSel];
      $$('.dsc-msg.is-find-current').forEach((el) => el.classList.remove('is-find-current'));
      if (match) {
        const article = messagesEl.querySelector(`[data-message-index="${match.index}"]`);
        if (article) {
          article.classList.add('is-find-current');
          if (scroll) article.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      }
      updateFindCount();
    }

    function updateFindQuery(query) {
      state.findQuery = String(query || '');
      const needle = state.findQuery.trim().toLowerCase();
      state.findMatches = [];
      if (needle) {
        state.messages.forEach((message, index) => {
          const text = String(messageText(message) || '');
          const lower = text.toLowerCase();
          let from = 0;
          while (state.findMatches.length < 500) {
            const pos = lower.indexOf(needle, from);
            if (pos < 0) break;
            state.findMatches.push({ index, pos });
            from = pos + Math.max(1, needle.length);
          }
        });
      }
      state.findSel = 0;
      applyFindHighlight(false);
      updateSendState();
    }

    function refreshFindMatches() {
      if (!state.findOn) return;
      const previous = state.findSel;
      const needle = state.findQuery.trim().toLowerCase();
      state.findMatches = [];
      if (needle) {
        state.messages.forEach((message, index) => {
          const text = String(messageText(message) || '');
          const lower = text.toLowerCase();
          let from = 0;
          while (state.findMatches.length < 500) {
            const pos = lower.indexOf(needle, from);
            if (pos < 0) break;
            state.findMatches.push({ index, pos });
            from = pos + Math.max(1, needle.length);
          }
        });
      }
      state.findSel = state.findMatches.length ? Math.min(previous, state.findMatches.length - 1) : 0;
      applyFindHighlight(false);
      updateFindCount();
    }

    function findNext(direction = 1) {
      if (!state.findMatches.length) return;
      state.findSel = (state.findSel + direction + state.findMatches.length) % state.findMatches.length;
      applyFindHighlight(true);
    }

    function visibleComposerArea() {
      return $$('.dsc-composer textarea').find((area) => area.offsetParent !== null)
        || $$('.dsc-composer textarea')[0]
        || null;
    }

    function enterFind() {
      if (state.view !== 'chat' || !state.messages.length) {
        showToast('当前对话没有可搜索的内容');
        return;
      }
      if (state.findOn) return;
      state.findDraft = currentText();
      state.findOn = true;
      state.findQuery = '';
      state.findMatches = [];
      state.findSel = 0;
      root.dataset.find = '1';
      $$('.dsc-composer textarea').forEach((area) => {
        area.value = '';
        area.placeholder = '搜索当前对话…';
        area.disabled = false;
      });
      updateFindAvailability();
      updateFindQuery('');
      updateSendState();
      syncComposerHeights();
      visibleComposerArea()?.focus({ preventScroll: true });
    }

    function exitFind() {
      if (!state.findOn) return;
      state.findOn = false;
      state.findQuery = '';
      state.findMatches = [];
      state.findSel = 0;
      root.dataset.find = '0';
      $$('.dsc-msg.is-find-current').forEach((el) => el.classList.remove('is-find-current'));
      $$('.dsc-composer textarea').forEach((area) => {
        area.value = state.findDraft;
        area.placeholder = '给 DeepSeek 发送消息';
        area.disabled = state.busy;
      });
      state.findDraft = '';
      updateFindAvailability();
      updateFindCount();
      updateSendState();
      syncComposerHeights();
      visibleComposerArea()?.focus({ preventScroll: true });
    }

    function toggleFind() {
      if (state.findOn) exitFind();
      else enterFind();
    }

    function updateSendState() {
      if (state.findOn) {
        const hasQuery = state.findQuery.trim().length > 0;
        $$('[data-act="send"]').forEach((btn) => {
          btn.disabled = !hasQuery;
          btn.classList.remove('is-stop');
          btn.innerHTML = icon('sendArrow', 20);
          btn.setAttribute('aria-label', '下一个命中');
        });
        $$('.dsc-send-wrap').forEach((wrap) => { wrap.dataset.tip = '下一个命中'; });
        $$('.dsc-composer textarea').forEach((area) => { area.disabled = false; });
        return;
      }
      const stream = activeStream();
      const canStop = Boolean(stream && stream.controller);
      const reading = pendingAttachments.some((item) => item.status === 'reading');
      const hasReady = pendingAttachments.some((item) => item.status === 'ready');
      const enabled = (currentText().length > 0 || hasReady) && !reading && !state.busy;
      $$('[data-act="send"]').forEach((btn) => {
        btn.disabled = canStop ? false : !enabled;
        btn.classList.toggle('is-stop', canStop);
        btn.innerHTML = canStop ? icon('stop', 18) : icon('sendArrow', 20);
        btn.setAttribute('aria-label', canStop ? '停止生成' : '发送');
      });
      $$('.dsc-composer textarea').forEach((area) => {
        area.disabled = state.busy;
      });
      const tip = canStop ? '停止生成' : state.busy ? '正在生成…' : reading ? '附件读取中…' : enabled ? '发送' : '请输入你的问题';
      $$('.dsc-send-wrap').forEach((wrap) => {
        wrap.dataset.tip = tip;
      });
    }

    function computeBranchInfo(session) {
      const map = new Map();
      if (!session || !Array.isArray(session.tree)) return map;
      const groups = new Map();
      for (const node of session.tree) {
        if (!node) continue;
        const key = `${node.parentId ?? 'root'}|${node.role}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(node);
      }
      for (const nodes of groups.values()) {
        if (nodes.length < 2) continue;
        nodes.forEach((node, index) => {
          map.set(node.id, {
            index: index + 1,
            count: nodes.length,
            prev: nodes[index - 1]?.id || null,
            next: nodes[index + 1]?.id || null,
          });
        });
      }
      return map;
    }

    function preferredLeaf(session, startId) {
      const byParent = new Map();
      for (const node of session.tree || []) {
        const key = node.parentId ?? 'root';
        if (!byParent.has(key)) byParent.set(key, []);
        byParent.get(key).push(node);
      }
      let current = startId;
      const seen = new Set();
      while (current && !seen.has(current)) {
        seen.add(current);
        const children = byParent.get(current) || [];
        if (!children.length) break;
        current = children[children.length - 1].id;
      }
      return current || startId;
    }

    function openEditMessage(index) {
      const message = state.messages[index];
      if (!message) return;
      if (isRoundLocked(sessionById(state.activeId), message)) {
        showToast('本轮已有 TTS 语音，先删除语音或重新生成后再修改');
        return;
      }
      if (activeStream()) {
        showToast('正在生成，稍后再编辑');
        return;
      }
      editMessageState = {
        sessionId: state.activeId,
        nodeId: message.id,
        index,
        role: message.role,
      };
      editTitle.textContent = message.role === 'user' ? '编辑提问' : '编辑回答';
      editHint.textContent = message.role === 'user'
        ? '保存后会从这条消息开启新分支，原分支保留，并自动生成新回答。'
        : '保存后直接改写这条回答，后续消息会基于新内容。';
      editText.value = message.text || '';
      editOverlay.hidden = false;
      editOverlay.classList.remove('show');
      requestAnimationFrame(() => requestAnimationFrame(() => {
        editOverlay.classList.add('show');
        editText.focus();
        editText.select();
      }));
      setTimeout(() => editOverlay.classList.add('show'), 80);
    }

    function closeEditMessage() {
      if (!editOverlay || editOverlay.hidden) return;
      editOverlay.classList.remove('show');
      const timer = setTimeout(() => {
        timers.delete(timer);
        editOverlay.hidden = true;
        editMessageState = null;
      }, 140);
      timers.add(timer);
    }

    async function saveEditMessage() {
      const editing = editMessageState;
      if (!editing) return;
      const value = editText.value.trim();
      if (!value) {
        showToast('内容不能为空');
        editText.focus();
        return;
      }
      const session = sessionById(editing.sessionId);
      if (!session) {
        closeEditMessage();
        return;
      }
      ensureSessionTree(session);
      const node = (session.tree || []).find((entry) => entry.id === editing.nodeId);
      if (!node) {
        closeEditMessage();
        return;
      }
      if (editing.role === 'assistant') {
        node.text = value;
        node.html = renderMarkdown(value);
        node.streaming = false;
        delete node.tts;
        session.updatedAt = Date.now();
        storeSessions(state.sessions);
        closeEditMessage();
        if (state.activeId === session.id) renderMessages();
        return;
      }
      const newId = `m${session.nextMessageId++}`;
      const branchNode = {
        ...node,
        id: newId,
        parentId: node.parentId ?? null,
        text: value,
        html: undefined,
        streaming: false,
      };
      delete branchNode.tts;
      session.tree.push(branchNode);
      session.currentId = newId;
      if (session.summary) delete session.summary;
      ensureSessionTree(session);
      state.activeId = session.id;
      state.messages = session.messages;
      storeSessions(state.sessions);
      closeEditMessage();
      renderSessions();
      setView('chat');
      renderMessages();
      commitSessionModel(session);
      await maybeCompressContext();
      startReply(apiHistory(), Date.now(), { query: value });
    }

    function requestDeleteMessage(index) {
      const message = state.messages[index];
      if (!message) return;
      if (activeStream()) {
        showToast('正在生成，稍后再删除');
        return;
      }
      pendingMessageDelete = { sessionId: state.activeId, nodeId: message.id };
      if (dialogCloseTimer) {
        clearTimeout(dialogCloseTimer);
        dialogCloseTimer = null;
      }
      dialogMode = 'delete-message';
      dialogIds = [message.id];
      dialogBatchId = null;
      dialogTitle.textContent = message.role === 'user' ? '删除这条提问?' : '删除这条回答?';
      dialogDesc.textContent = '删除后该消息从上下文中移除；剩余的另一半会作为孤儿轮保留，仍可在导航轨中找到。';
      dialogDesc.hidden = false;
      dialogConfirm.textContent = '删除';
      dialogConfirm.classList.remove('is-primary');
      dialogConfirm.classList.add('is-danger');
      if (dialogCancel) dialogCancel.textContent = '取消';
      dialogEl.hidden = false;
      dialogEl.classList.remove('show');
      requestAnimationFrame(() => requestAnimationFrame(() => {
        dialogEl.classList.add('show');
        dialogConfirm.focus({ preventScroll: true });
      }));
      setTimeout(() => dialogEl.classList.add('show'), 80);
    }

    function deleteMessageNode(sessionId, nodeId) {
      const session = sessionById(sessionId);
      if (!session || !Array.isArray(session.tree)) return;
      const node = session.tree.find((entry) => entry.id === nodeId);
      if (!node) return;
      const children = session.tree.filter((entry) => entry.parentId === nodeId);
      session.tree = session.tree.filter((entry) => entry.id !== nodeId);
      for (const child of children) child.parentId = node.parentId ?? null;
      void pruneTtsCache();
      if (!session.tree.some((entry) => entry.id === session.currentId)) {
        const parent = node.parentId != null
          ? session.tree.find((entry) => entry.id === node.parentId)
          : null;
        const fallback = parent || children[children.length - 1] || session.tree[session.tree.length - 1];
        session.currentId = fallback?.id || null;
      }
      if (session.currentId) session.currentId = preferredLeaf(session, session.currentId);
      if (session.summary) delete session.summary;
      session.updatedAt = Date.now();
      // An emptied tree must not be rebuilt from the stale branch view:
      // ensureSessionTree falls back to session.messages, which would
      // resurrect the node just deleted (and persist it again on save).
      if (!session.tree.length) session.messages = [];
      ensureSessionTree(session);
      if (state.activeId === session.id) {
        state.messages = session.messages;
        renderSessions();
        storeSessions(state.sessions);
        if (state.messages.length) {
          setView('chat');
          renderMessages();
        } else {
          setView('welcome');
        }
      } else {
        storeSessions(state.sessions);
        renderSessions();
      }
    }

    function switchBranch(targetId) {
      const session = sessionById(state.activeId);
      if (!session || !targetId) return;
      if (streams.has(session.id)) {
        showToast('正在生成，稍后再切换分支');
        return;
      }
      const byId = new Map((session.tree || []).map((node) => [node.id, node]));
      if (!byId.has(targetId)) return;
      stopSpeech();
      session.currentId = preferredLeaf(session, targetId);
      if (session.summary) delete session.summary;
      ensureSessionTree(session);
      state.messages = session.messages;
      storeSessions(state.sessions);
      syncBusy();
      if (state.view !== 'chat') setView('chat');
      renderMessages();
    }

    let railItems = [];
    let railHover = -1;
    let railPinned = '';
    let railTipTimer = null;
    let railVisible = new Set();
    let railFrame = 0;

    function railText(value) {
      return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function buildRailItems(session) {
      const items = [];
      const tree = Array.isArray(session?.tree) ? session.tree : [];
      const pushRound = (user, userIndex, assistant, assistantIndex) => {
        const primary = assistant || user;
        if (!primary) return;
        const assistantSibs = assistant
          ? tree.filter((entry) => entry && entry.role === 'assistant' && entry.parentId === assistant.parentId)
          : [];
        const userSibs = user
          ? tree.filter((entry) => entry && entry.role === 'user' && entry.parentId === user.parentId)
          : [];
        const sibs = [];
        const seen = new Set();
        for (const entry of assistantSibs) {
          if (seen.has(entry.id)) continue;
          seen.add(entry.id);
          sibs.push({ nid: entry.id, label: `答 · ${railText(entry.text).slice(0, 46)}` });
        }
        const userAlternatives = assistant
          ? userSibs.filter((entry) => entry.id !== user?.id)
          : userSibs;
        for (const entry of userAlternatives) {
          if (seen.has(entry.id)) continue;
          seen.add(entry.id);
          sibs.push({ nid: entry.id, label: `问 · ${railText(entry.text).slice(0, 46)}` });
        }
        items.push({
          nid: primary.id,
          activeNid: primary.id,
          user: railText(user?.text).slice(0, 80),
          assistant: railText(assistant?.text).slice(0, 80),
          userIndex,
          assistantIndex,
          sibs,
        });
      };
      let pendingUser = null;
      let pendingIndex = -1;
      state.messages.forEach((message, index) => {
        if (message.role === 'user') {
          if (pendingUser) pushRound(pendingUser, pendingIndex, null, -1);
          pendingUser = message;
          pendingIndex = index;
        } else if (message.role === 'assistant') {
          if (pendingUser) {
            pushRound(pendingUser, pendingIndex, message, index);
            pendingUser = null;
            pendingIndex = -1;
          } else {
            pushRound(null, -1, message, index);
          }
        }
      });
      if (pendingUser) pushRound(pendingUser, pendingIndex, null, -1);
      return items;
    }

    function renderRail() {
      if (!railWrap || !railList) return;
      if (state.view !== 'chat' || !state.messages.length) {
        railWrap.hidden = true;
        railList.innerHTML = '';
        railItems = [];
        railVisible = new Set();
        return;
      }
      const items = buildRailItems(sessionById(state.activeId));
      railItems = items.slice(-32);
      railHover = -1;
      if (!railItems.length) {
        railWrap.hidden = true;
        railList.innerHTML = '';
        return;
      }
      railList.innerHTML = railItems.map((item, index) => {
        const branches = item.sibs.length;
        const branchHtml = branches >= 2
          ? `<span class="dsc-rail-dot" aria-hidden="true"></span>${branches >= 3 ? `<span class="dsc-rail-count">${branches}</span>` : ''}`
          : '';
        return `<div class="dsc-rail-row" data-rail-index="${index}" data-rail-nid="${escapeHtml(item.nid)}" role="button" tabindex="0" aria-label="跳转到第 ${index + 1} 轮">
          <span class="dsc-rail-bar"></span>
          <span class="dsc-rail-branch">${branchHtml}</span>
        </div>`;
      }).join('');
      if (!railItems.some((item) => item.nid === railPinned)) railPinned = '';
      railWrap.hidden = false;
      paintRail();
      updateRailVisible();
      requestAnimationFrame(() => updateRailVisible());
      const railTimer = setTimeout(() => {
        timers.delete(railTimer);
        updateRailVisible();
      }, 60);
      timers.add(railTimer);
      if (railPinned) syncRailTip();
      else hideRailTip();
    }

    function paintRail() {
      if (!railList) return;
      const dark = state.theme === 'dark';
      const base = dark ? '255, 255, 255' : '17, 24, 39';
      railList.querySelectorAll('.dsc-rail-row').forEach((row, index) => {
        const bar = row.querySelector('.dsc-rail-bar');
        const item = railItems[index];
        if (!bar || !item) return;
        const distance = railHover < 0 ? -1 : Math.abs(index - railHover);
        const grow = distance === 0 ? 1 : distance === 1 ? 0.72 : distance === 2 ? 0.45 : distance === 3 ? 0.2 : 0;
        bar.style.width = `${10 + grow * 14}px`;
        if (item.nid === railPinned) {
          bar.style.backgroundColor = '#F59E0B';
        } else if (railVisible.has(item.nid)) {
          bar.style.backgroundColor = state.theme === 'dark' ? '#5686fe' : '#3964fe';
        } else {
          bar.style.backgroundColor = `rgba(${base}, ${(0.16 + grow * 0.3).toFixed(3)})`;
        }
      });
    }

    function updateRailVisible() {
      if (!railWrap || railWrap.hidden || !stageEl) return;
      const stageRect = stageEl.getBoundingClientRect();
      const next = new Set();
      for (const item of railItems) {
        // A round is in view when either half is: a long answer can keep the
        // round on screen after its question scrolled away (and vice versa).
        const indexes = [item.userIndex, item.assistantIndex].filter((index) => index >= 0);
        const inView = indexes.some((index) => {
          const article = messagesEl.querySelector(`[data-message-index="${index}"]`);
          if (!article) return false;
          const rect = article.getBoundingClientRect();
          return rect.bottom >= stageRect.top && rect.top <= stageRect.bottom;
        });
        if (inView) next.add(item.nid);
      }
      railVisible = next;
      paintRail();
    }

    function scheduleRailVisible() {
      if (railFrame) return;
      railFrame = requestAnimationFrame(() => {
        railFrame = 0;
        updateRailVisible();
      });
    }

    function hideRailTip() {
      if (!railTip) return;
      railTip.hidden = true;
      railTip.innerHTML = '';
    }

    function showRailTip(index) {
      const item = railItems[index];
      if (!railTip || !item) return;
      const sibs = item.sibs.length >= 2
        ? `<div class="dsc-rail-tip-sibs">${item.sibs.map((sib) => `
            <button class="dsc-rail-sib${sib.nid === item.activeNid ? ' active' : ''}" type="button" data-rail-sib="${escapeHtml(sib.nid)}">
              ${escapeHtml(sib.label || '（空消息）')}
            </button>`).join('')}</div>`
        : '';
      railTip.innerHTML = `
        <div class="dsc-rail-tip-user">${escapeHtml(item.user || '（无提问）')}</div>
        <div class="dsc-rail-tip-assistant">${escapeHtml(item.assistant || '（无回答）')}</div>
        ${sibs}`;
      railTip.hidden = false;
      requestAnimationFrame(() => {
        const row = railList.querySelector(`[data-rail-index="${index}"]`);
        if (!row || !railWrap) return;
        const rowRect = row.getBoundingClientRect();
        const wrapRect = railWrap.getBoundingClientRect();
        const tipHeight = railTip.offsetHeight;
        let top = rowRect.top - wrapRect.top - 8;
        top = Math.max(0, Math.min(top, Math.max(0, railWrap.clientHeight - tipHeight - 4)));
        railTip.style.top = `${Math.round(top)}px`;
      });
    }

    function syncRailTip() {
      if (railHover >= 0) {
        showRailTip(railHover);
        return;
      }
      if (railPinned) {
        const index = railItems.findIndex((item) => item.nid === railPinned);
        if (index >= 0) {
          showRailTip(index);
          return;
        }
      }
      hideRailTip();
    }

    function scheduleRailTipHide() {
      if (railPinned) return;
      if (railTipTimer) clearTimeout(railTipTimer);
      railTipTimer = setTimeout(() => {
        railTipTimer = null;
        if (railHover < 0 && !railPinned) hideRailTip();
      }, 160);
    }

    function jumpToRail(item) {
      if (!item) return;
      const index = item.userIndex >= 0 ? item.userIndex : item.assistantIndex;
      const article = messagesEl.querySelector(`[data-message-index="${index}"]`);
      if (article) article.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }

    function renderMessages() {
      const lastAssistantIndex = state.messages.reduce(
        (last, message, index) => (message.role === 'assistant' ? index : last),
        -1,
      );
      const activeSession = sessionById(state.activeId);
      const branchMap = computeBranchInfo(activeSession);
      const roundLocks = computeRoundLocks(activeSession);
      messagesEl.innerHTML = state.messages
        .map((message, index) => messageHTML(
          message,
          index,
          lastAssistantIndex,
          branchMap.get(message.id),
          roundLocks.has(message.id),
        ))
        .join('');
      scheduleCodeUpgrade();
      if (state.findOn) refreshFindMatches();
      updateFindAvailability();
      renderRail();
      updateSendState();
      requestAnimationFrame(() => {
        if (stageEl && stickToBottom) stageEl.scrollTop = stageEl.scrollHeight;
        updateRailVisible();
      });
    }

    // Streaming updates mutate text nodes instead of rebuilding the message
    // list: rebuilding every animation frame drops :hover from the thinking
    // row (flicker) and swallows mousedown/mouseup clicks on it.
    function updateStreamingMessage(message) {
      const index = state.messages.indexOf(message);
      if (index < 0) return;
      const article = messagesEl.querySelector(`[data-message-index="${index}"]`);
      if (!article) {
        renderMessages();
        return;
      }
      const previews = article.querySelectorAll('.dsc-act-preview');
      let previewIndex = 0;
      for (const item of message.activity || []) {
        if (!item.preview) continue;
        const node = previews[previewIndex];
        previewIndex += 1;
        if (node && node.textContent !== item.preview) node.textContent = item.preview;
      }
      const reasoningBody = article.querySelector('.dsc-reasoning-body');
      if (reasoningBody && message.reasoning) {
        const reasoningHtml = renderMarkdown(message.reasoning);
        if (reasoningBody.dataset.streamHtml !== reasoningHtml) {
          reasoningBody.innerHTML = reasoningHtml;
          reasoningBody.dataset.streamHtml = reasoningHtml;
        }
      }
      if (message.html) {
        let md = article.querySelector('.dsc-md');
        if (!md) {
          // First text of the stream: create the markdown container in place
          // and drop the "running" row, leaving the activity row untouched.
          md = document.createElement('div');
          md.className = 'dsc-md';
          const running = article.querySelector('.dsc-run');
          if (running) running.before(md);
          else article.appendChild(md);
          if (running) running.remove();
        }
        const html = `${message.html}${message.streaming ? '<span class="dsc-stream-cursor" aria-hidden="true"></span>' : ''}`;
        if (md.dataset.streamHtml !== html) {
          md.innerHTML = html;
          md.dataset.streamHtml = html;
          scheduleCodeUpgrade();
        }
      }
      updateSendState();
      requestAnimationFrame(() => {
        if (stageEl && stickToBottom) stageEl.scrollTop = stageEl.scrollHeight;
      });
    }

    function toggleReasoning(index) {
      const message = state.messages[index];
      if (!message || !message.reasoning) return;
      const previousScroll = stageEl ? stageEl.scrollTop : 0;
      message.reasoningOpen = message.reasoningOpen !== true;
      renderMessages();
      requestAnimationFrame(() => {
        if (stageEl) stageEl.scrollTop = Math.min(previousScroll, stageEl.scrollHeight);
      });
    }

    function toggleSources(index) {
      const message = state.messages[index];
      if (!message || !Array.isArray(message.sources) || !message.sources.length) return;
      const previousScroll = stageEl ? stageEl.scrollTop : 0;
      message.sourcesOpen = message.sourcesOpen !== true;
      renderMessages();
      requestAnimationFrame(() => {
        if (stageEl) stageEl.scrollTop = Math.min(previousScroll, stageEl.scrollHeight);
      });
    }

    function sessionById(id) {
      return state.sessions.find((session) => session.id === id) || null;
    }

    function ensureActiveSession(text) {
      let session = sessionById(state.activeId);
      if (!session) {
        const id = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
        session = {
          id,
          title: titleFromText(text),
          createdAt: Date.now(),
          updatedAt: Date.now(),
          pinned: false,
          messages: [],
          tree: [],
          currentId: null,
          nextMessageId: 1,
        };
        state.sessions.unshift(session);
        state.activeId = id;
        state.messages = session.messages;
      } else {
        if (state.messages !== session.messages) state.messages = session.messages;
        if (!session.title || session.title === '新对话') session.title = titleFromText(text);
      }
      return session;
    }

    function syncActiveSession() {
      const session = sessionById(state.activeId);
      if (!session) return;
      session.messages = state.messages;
      syncSession(session.id);
    }

    // Persist a session even when it is not the one on screen (background
    // streams finish while the user reads another conversation).
    function syncSession(sessionId) {
      const session = sessionById(sessionId);
      if (!session) return;
      session.updatedAt = Date.now();
      storeSessions(state.sessions);
      renderSessions();
    }

    // ---- context compression -----------------------------------------
    // When a conversation approaches the model's window, the oldest turns
    // are summarized once and stored with the session. The transcript on disk
    // stays complete; only the request context gets the summary prefix.

    function estimateTextTokens(text) {
      let tokens = 0;
      for (const ch of String(text)) {
        tokens += ch.codePointAt(0) >= 0x2e80 ? 1 : 0.25;
      }
      return Math.ceil(tokens);
    }

    function activeContextWindow() {
      const models = state.api.models || [];
      const model = models.find((item) => item.id === state.api.model
        && (!state.api.provider || item.provider === state.api.provider))
        || models.find((item) => item.id === state.api.model);
      return Number(model?.contextWindow) || 0;
    }

    async function maybeCompressContext() {
      const session = sessionById(state.activeId);
      if (!session || !state.api.available) return;
      const contextWindow = activeContextWindow();
      if (!contextWindow || contextWindow < 4096) return;
      const messages = session.messages || [];
      if (messages.length < 6) return;
      const previous = session.summary;
      const previousCut = previous
        ? Math.min(Math.max(0, Number(previous.throughIndex) || 0), messages.length)
        : 0;
      // Only the context we would actually send counts: the existing summary
      // plus everything after its cut. This keeps a long conversation from
      // re-compressing on every single turn.
      let effective = previous?.text ? estimateTextTokens(previous.text) + 8 : 0;
      for (let index = previousCut; index < messages.length; index += 1) {
        effective += estimateTextTokens(messageText(messages[index])) + 8;
      }
      if (effective <= contextWindow * 0.6) return;

      const keepBudget = Math.floor(contextWindow * 0.35);
      let cut = messages.length;
      let keep = 0;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const cost = estimateTextTokens(messageText(messages[index])) + 8;
        if (keep + cost > keepBudget && cut < messages.length) break;
        keep += cost;
        cut = index;
      }
      if (cut <= previousCut) return;
      const from = previousCut;
      const lines = [];
      if (from > 0 && previous?.text) lines.push(`[此前摘要]
${previous.text}`);
      for (let index = from; index < cut; index += 1) {
        const text = messageText(messages[index]).trim();
        if (!text) continue;
        lines.push(`${messages[index].role === 'user' ? '用户' : '助手'}：${text.slice(0, 4000)}`);
      }
      const transcript = lines.join('\n\n').slice(0, 180_000);
      if (!transcript.trim()) return;

      showToast('正在压缩较早的上下文…');
      try {
        const response = await fetch(new URL('compress', API_BASE), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: transcript }),
        });
        if (!response.ok) return;
        const data = await response.json();
        const summary = typeof data.summary === 'string' ? data.summary.trim() : '';
        if (!summary) return;
        const current = sessionById(session.id);
        if (!current) return;
        current.summary = { text: summary.slice(0, 12_000), throughIndex: cut, at: Date.now() };
        storeSessions(state.sessions);
        showToast('已压缩较早的上下文');
      } catch {
        /* keep full history; the host still trims to the model window */
      }
    }

    // After the first completed exchange, replace the 30-char fallback title
    // with a short model-generated one. Quietly keeps the fallback on failure.
    async function maybeGenerateTitle(sessionId) {
      const session = sessionById(sessionId);
      if (!session || session.autoTitle) return;
      const messages = session.messages || [];
      const users = messages.filter((message) => message.role === 'user');
      if (users.length !== 1) return;
      const first = users[0];
      const answer = messages.find((message) => message.role === 'assistant' && message.text);
      if (!first || !answer) return;
      const fallback = titleFromText(first.text);
      if (session.title !== fallback) return;
      try {
        const response = await fetch(new URL('title', API_BASE), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: `${first.text}\n\n${answer.text}`.slice(0, 3000) }),
        });
        if (!response.ok) return;
        const data = await response.json();
        const title = typeof data.title === 'string' ? data.title.trim() : '';
        if (!title) return;
        const current = sessionById(sessionId);
        if (!current || current.autoTitle || current.title !== fallback) return;
        current.title = title.slice(0, 60);
        current.autoTitle = true;
        storeSessions(state.sessions);
        renderSessions();
        if (state.activeId === current.id && state.view === 'chat') {
          titleEl.textContent = current.title;
        }
      } catch { /* keep the fallback title */ }
    }

    function setView(view) {
      if (view === 'chat' && state.view !== 'chat') stickToBottom = true;
      if (view === 'chat' && state.activeId && state.messages.length) stickToBottom = true;
      state.view = view;
      root.dataset.view = view;
      const welcome = $('.dsc-welcome');
      welcome.hidden = view !== 'welcome';
      messagesEl.hidden = view !== 'chat';
      dockEl.hidden = view !== 'chat';
      titleEl.textContent = view === 'chat' && state.activeId ? (sessionById(state.activeId)?.title || '新对话') : '';
      if (view === 'chat') renderMessages();
      else updateSendState();
      updateFindAvailability();
      renderRail();
    }

    function openSession(id) {
      if (state.selectMode) return;
      const session = sessionById(id);
      if (!session) return;
      stopSpeech();
      if (state.findOn) exitFind();
      clearAttachments();
      state.activeId = id;
      // Live reference: a stream running in this session keeps updating the
      // same message objects even while another conversation is on screen.
      state.messages = session.messages;
      applySessionModel(session);
      syncBusy();
      renderSessions();
      setView(state.messages.length ? 'chat' : 'welcome');
    }

    // Pull the durable copy from the host once per mount. An empty host file
    // migrates the current localStorage sessions; a busy/fresh window keeps
    // anything it just wrote instead of losing it to a stale response.
    async function hydrateHostSessions() {
      try {
        await hydrateHostSessionsInner();
      } finally {
        hostHydrated = true;
        backfillTtsFlags();
      }
    }

    async function hydrateHostSessionsInner() {
      let data;
      try {
        const response = await fetch(new URL('sessions', API_BASE), { cache: 'no-store' });
        if (!response.ok) return;
        data = await response.json();
      } catch {
        return;
      }
      hostSessionsAvailable = true;
      const remote = (Array.isArray(data.sessions) ? data.sessions : [])
        .map(normalizeSessionRecord)
        .filter(Boolean);
      if (!remote.length) {
        if (state.sessions.length) scheduleHostSave(state.sessions);
        return;
      }
      const cutoff = Date.now() - 10_000;
      const merged = new Map(remote.map((session) => [session.id, session]));
      for (const session of state.sessions) {
        const fresh = Number(session.updatedAt) > cutoff || Number(session.importedAt) > cutoff;
        if (fresh && !merged.has(session.id)) merged.set(session.id, session);
      }
      const next = [...merged.values()]
        .sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt));
      state.sessions = next;
      if (sessionsTextSize(next) > LOCAL_MIRROR_LIMIT) {
        localMirrorDisabled = true;
        try { localStorage.removeItem(SESSIONS_KEY); } catch { /* ignore */ }
      }
      const active = state.activeId ? sessionById(state.activeId) : null;
      if (state.activeId && !active) {
        state.activeId = null;
        state.messages = [];
        setView('welcome');
      } else if (active && !state.busy) {
        state.messages = active.messages;
        setView(state.messages.length ? 'chat' : 'welcome');
      }
      renderSessions();
    }

    function newChat() {
      if (state.selectMode) exitSelectMode();
      stopSpeech();
      if (state.findOn) exitFind();
      state.activeId = null;
      state.messages = [];
      applyDefaultModel();
      clearAttachments();
      syncBusy();
      renderSessions();
      setView('welcome');
      clearComposers();
      const area = $('.dsc-welcome textarea');
      if (area) area.focus({ preventScroll: true });
    }

    function apiHistory() {
      const session = sessionById(state.activeId);
      const from = Math.max(0, Number(session?.summary?.throughIndex) || 0);
      return state.messages
        .slice(from)
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .map((message) => {
          const content = message.role === 'assistant'
            ? (message.text || stripTags(message.html || ''))
            : (message.text || '');
          const images = message.role === 'user' && !message.imagesDelegated && Array.isArray(message.images)
            ? message.images.slice(0, 20)
            : [];
          return {
            role: message.role,
            content: content.slice(0, 120_000),
            ...message.role === 'user' && message.attachmentText
              ? { attachmentText: String(message.attachmentText).slice(0, 400_000) }
              : {},
            ...images.length ? { images } : {},
          };
        })
        .filter((message) => message.content.trim() || (message.images && message.images.length));
    }

    function isOfficialDeepSeekProvider(provider) {
      return !provider || /^deepseek-(official|account)$/.test(provider);
    }

    function updateThinkSupport() {
      const supported = isOfficialDeepSeekProvider(state.api.provider);
      state.thinkingSupported = supported;
      $$('.dsc-think-trigger').forEach((btn) => {
        btn.classList.toggle('is-unsupported', !supported);
        btn.setAttribute('aria-disabled', supported ? 'false' : 'true');
        btn.dataset.tip = supported ? '先思考后回答，解决推理问题' : '当前模型使用自身的思考策略';
        btn.classList.toggle('active', supported && state.thinking !== 'off');
      });
    }

    function effortForApi() {
      if (!isOfficialDeepSeekProvider(state.api.provider)) return undefined;
      return ['off', 'low', 'high', 'max'].includes(state.thinking) ? state.thinking : 'high';
    }

    async function runSearch(query, signal, mode) {
      const response = await fetch(new URL('search', API_BASE), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, mode }),
        signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiErrorMessage(data));
      return data;
    }

    async function runSearchAgent(query, config, signal) {
      const response = await fetch(new URL('search/agent', API_BASE), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query,
          provider: config.provider,
          model: config.model,
        }),
        signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiErrorMessage(data) || `搜索子 Agent 失败（HTTP ${response.status}）`);
      return data;
    }

    function buildAgentSearchSystem(query, brief, sources) {
      const lines = (Array.isArray(sources) ? sources : [])
        .filter((source) => source && safeHttpUrl(source.url))
        .slice(0, 10)
        .map((source, index) => `[${index + 1}] ${source.title || source.url}\n${source.url}`);
      return [
        '以下是联网搜索子 Agent 的检索结果。请据此回答用户问题；引用时使用 Markdown 链接，并在末尾列出参考来源。若资料不足，请明确说明，不要编造。',
        `用户问题：${query}`,
        brief ? `检索简报：\n${String(brief).slice(0, 8000)}` : '',
        lines.length ? `参考来源：\n${lines.join('\n\n')}` : '',
      ].filter(Boolean).join('\n\n');
    }

    function buildSearchSystem(query, result) {
      const sources = (Array.isArray(result.sources) ? result.sources : [])
        .filter((source) => safeHttpUrl(source.url))
        .slice(0, 8);
      const lines = sources.map((source, index) => {
        const excerpt = source.summary || source.snippet || '';
        return `[${index + 1}] ${source.title || source.url}\n${source.url}${excerpt ? `\n${excerpt}` : ''}`;
      });
      if (!lines.length && !result.content) return '';
      return [
        '以下是联网搜索得到的资料。请优先依据这些资料回答，引用时使用 Markdown 链接，并在末尾给出参考来源。',
        `用户问题：${query}`,
        result.content ? `搜索摘要：${result.content}` : '',
        lines.length ? `来源：\n${lines.join('\n\n')}` : '',
        '如果资料不足以回答，请明确说明，不要编造。',
      ].filter(Boolean).join('\n\n');
    }

    async function sendDemoMessage(text) {
      let payload;
      try {
        payload = await collectAttachmentPayload(text);
      } catch (error) {
        showToast(error instanceof Error ? error.message : String(error));
        return;
      }
      const session = ensureActiveSession(text || payload.attachments[0]?.name || '附件');
      const sessionId = state.activeId;
      const messages = state.messages;
      appendMessageNode(session, {
        role: 'user',
        text,
        ...payload.attachments.length ? { attachments: payload.attachments } : {},
        ...payload.attachmentText ? { attachmentText: payload.attachmentText } : {},
        ...payload.images.length ? { images: payload.images } : {},
        ...payload.delegated ? { imagesDelegated: true } : {},
      });
      clearAttachments();
      syncActiveSession();
      const startedAt = Date.now();
      const activity = [];
      if (state.searchOn) activity.push({ type: 'search', label: '网页搜索', preview: '正在检索相关网页…' });
      if (state.thinking !== 'off') activity.push({ type: 'think', label: '思考', preview: '正在分析问题与上下文…' });
      const assistant = { role: 'assistant', html: '', activity, startedAt, streaming: true };
      appendMessageNode(session, assistant);
      const stream = { controller: null, assistant, frame: 0, tick: null, demoTimer: null };
      streams.set(sessionId, stream);
      syncBusy();
      setView('chat');
      clearComposers();
      renderMessages();

      const tick = setInterval(() => {
        if (state.activeId !== sessionId || assistant.html) return;
        const node = messagesEl.querySelector('[data-run-seconds]');
        if (node) node.textContent = String(Math.max(1, Math.round((Date.now() - startedAt) / 1000)));
      }, 500);
      stream.tick = tick;
      timers.add(tick);

      const html = /公式|成本|价格|latex|数学/i.test(text || payload.attachmentText) ? REPLY_LATEX : GENERIC_HTML;
      const timer = setTimeout(() => {
        timers.delete(timer);
        clearInterval(tick);
        timers.delete(tick);
        assistant.activity = [
          ...(state.searchOn ? [{ type: 'search', label: '网页搜索', preview: '已检索 12 个网页' }] : []),
          ...(state.thinking !== 'off' ? [{ type: 'think', label: '思考', preview: '已完成分析' }] : []),
        ];
        assistant.html = html;
        assistant.streaming = false;
        if (state.searchOn) assistant.cite = '12 个网页';
        streams.delete(sessionId);
        syncBusy();
        syncSession(sessionId);
        if (state.activeId === sessionId) renderMessages();
        showToast('演示回复：DSH 内会使用真实 DeepSeek API');
      }, 1400);
      stream.demoTimer = timer;
      timers.add(timer);
    }

    function reasoningSummary(text, running) {
      const cleaned = String(text || '').replaceAll('**', '').trim();
      if (!cleaned) return '';
      const paragraphs = cleaned.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
      const source = running ? (paragraphs[paragraphs.length - 1] || cleaned) : cleaned;
      const firstLine = source.split('\n')[0].trim();
      return firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;
    }

    function refreshActivity(message) {
      const think = (message.activity || []).find((item) => item.type === 'think');
      if (!think) return;
      think.preview = reasoningSummary(message.reasoning, true) || '正在分析问题与上下文…';
    }

    async function startReply(messages, startedAt, options = {}) {
      const sessionId = state.activeId;
      const searchConfig = selectedSearchProvider();
      const searchReady = state.searchOn && searchModelReady();
      const officialSearch = searchReady && searchConfig.kind === 'official';
      const agentSearch = searchReady && searchConfig.kind === 'agent';
      const wantsThinking = !isOfficialDeepSeekProvider(state.api.provider) || state.thinking !== 'off';
      const assistant = {
        role: 'assistant',
        text: '',
        html: '',
        reasoning: '',
        activity: [
          ...(agentSearch ? [{
            type: 'search',
            label: '搜索子 Agent',
            preview: '正在判断是否需要联网…',
          }] : []),
          ...(wantsThinking ? [{ type: 'think', label: '思考', preview: '正在分析问题与上下文…' }] : []),
        ],
        sources: [],
        startedAt,
        streaming: true,
      };
      const session = sessionById(sessionId);
      if (session) appendMessageNode(session, assistant);
      else state.messages.push(assistant);
      const stream = { controller: null, assistant, frame: 0, tick: null };
      streams.set(sessionId, stream);
      syncBusy();
      setView('chat');
      clearComposers();
      renderMessages();

      const tick = setInterval(() => {
        if (!assistant.streaming || state.activeId !== sessionId) return;
        const node = messagesEl.querySelector('[data-run-seconds]');
        if (node) node.textContent = String(Math.max(1, Math.round((Date.now() - startedAt) / 1000)));
      }, 500);
      stream.tick = tick;
      timers.add(tick);

      const scheduleRender = () => {
        if (stream.frame) return;
        stream.frame = requestAnimationFrame(() => {
          stream.frame = 0;
          refreshActivity(assistant);
          if (assistant.text) assistant.html = renderMarkdown(assistant.text, { streaming: true });
          if (state.activeId === sessionId) updateStreamingMessage(assistant);
        });
      };

      const controller = new AbortController();
      stream.controller = controller;
      updateSendState();
      try {
        const summaryText = sessionById(sessionId)?.summary?.text;
        const systemParts = [];
        if (summaryText) {
          systemParts.push(`以下是本对话较早部分的摘要，请在回答时延续其中的事实、数字与约定：
${summaryText}`);
        }
        const query = String(
          options.query
          || [...messages].reverse().find((message) => message.role === 'user')?.content
          || '',
        ).slice(0, 500);
        if (agentSearch) {
          const searchActivity = assistant.activity.find((item) => item.type === 'search');
          try {
            const result = await runSearchAgent(query, searchConfig, controller.signal);
            if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
            if (result.used) {
              const sources = Array.isArray(result.sources)
                ? result.sources.filter((source) => source && safeHttpUrl(source.url)).slice(0, 10)
                : [];
              assistant.sources = sources;
              if (searchActivity) {
                searchActivity.preview = Array.isArray(result.queries) && result.queries.length
                  ? result.queries.join(' · ').slice(0, 120)
                  : `已检索 ${sources.length} 个来源`;
              }
              systemParts.push(buildAgentSearchSystem(query, result.brief, sources));
            } else if (searchActivity) {
              searchActivity.preview = '无需联网';
            }
            if (state.activeId === sessionId) renderMessages();
          } catch (error) {
            if (controller.signal.aborted) throw error;
            if (searchActivity) searchActivity.preview = '搜索子 Agent 失败，直接回答';
            if (state.activeId === sessionId) renderMessages();
            showToast('联网搜索子 Agent 失败，已直接回答');
          }
        }
        const system = systemParts.join('\n\n');

        const response = await fetch(new URL('chat', API_BASE), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            provider: state.api.provider || undefined,
            model: state.api.model || 'deepseek-flash',
            effort: effortForApi(),
            messages,
            ...system ? { system } : {},
            ...officialSearch ? { search: true } : {},
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          if (response.status === 401) {
            state.api.configured = false;
          }
          throw new Error(apiErrorMessage(payload) || `请求失败（HTTP ${response.status}）`);
        }
        if (!response.body) throw new Error('服务器没有返回内容');

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        const toolActivities = new Map();
        const handleEvent = (block) => {
          const data = block
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n')
            .trim();
          if (!data || data === '[DONE]') return;
          let event;
          try {
            event = JSON.parse(data);
          } catch {
            return;
          }
          if (event.type === 'error') {
            throw new Error(apiErrorMessage(event));
          }
          if (event.type === 'content_block_start') {
            const blockValue = event.content_block || {};
            if (blockValue.type === 'server_tool_use') {
              const inputValue = blockValue.input && typeof blockValue.input === 'object' ? blockValue.input : {};
              const action = String(inputValue.action || '');
              let label = '联网搜索';
              let preview = '';
              if (action === 'search') {
                const queries = Array.isArray(inputValue.queries)
                  ? inputValue.queries.filter((query) => typeof query === 'string') : [];
                label = String(blockValue.kind || '').includes('deep') ? '深度搜索' : '联网搜索';
                preview = queries.slice(0, 4).join(' · ');
              } else if (action === 'open_page') {
                label = '打开网页';
                preview = String(inputValue.url || '');
              } else if (action === 'find_in_page') {
                label = '页内查找';
                preview = String(inputValue.pattern || inputValue.url || '');
              } else if (action === 'read_link') {
                label = '读取链接';
                preview = String(inputValue.url || '');
              }
              const item = { type: 'search', label, preview: preview.slice(0, 120) };
              const searchCount = assistant.activity.filter((entry) => entry.type === 'search').length;
              const previous = searchCount >= 10
                ? [...assistant.activity].reverse().find((entry) => entry.type === 'search')
                : null;
              if (previous) {
                previous.label = label;
                previous.preview = item.preview;
                if (typeof blockValue.id === 'string') toolActivities.set(blockValue.id, previous);
              } else {
                assistant.activity.push(item);
                if (typeof blockValue.id === 'string') toolActivities.set(blockValue.id, item);
              }
              scheduleRender();
              return;
            }
            if (blockValue.type === 'web_search_tool_result') {
              const results = Array.isArray(blockValue.content) ? blockValue.content : [];
              let added = 0;
              for (const result of results) {
                if (!result || result.type !== 'web_search_result') continue;
                const url = safeHttpUrl(result.url);
                if (!url || assistant.sources.some((source) => source.url === url)) continue;
                if (assistant.sources.length >= 12) break;
                assistant.sources.push({
                  url,
                  title: String(result.title || result.site_name || url).slice(0, 200),
                  snippet: String(result.snippet || '').slice(0, 300),
                });
                added += 1;
              }
              const activity = toolActivities.get(blockValue.tool_use_id);
              if (activity) activity.preview = results.length ? `找到 ${results.length} 个结果` : '未找到结果';
              if (added) scheduleRender();
              return;
            }
            if (blockValue.type === 'web_fetch_tool_result') {
              const content = blockValue.content && typeof blockValue.content === 'object' ? blockValue.content : {};
              if (content.type === 'web_fetch_result' && content.url) {
                const url = safeHttpUrl(content.url);
                if (url && !assistant.sources.some((source) => source.url === url) && assistant.sources.length < 12) {
                  assistant.sources.push({
                    url,
                    title: String(content.content?.title || content.title || url).slice(0, 200),
                    snippet: '',
                  });
                }
              }
              const activity = toolActivities.get(blockValue.tool_use_id);
              if (activity) activity.preview = String(content.content?.title || content.url || '已读取网页').slice(0, 120);
              scheduleRender();
              return;
            }
            if (blockValue.type === 'thinking' && typeof blockValue.thinking === 'string' && blockValue.thinking) {
              assistant.reasoning += blockValue.thinking;
              scheduleRender();
            }
            if (blockValue.type === 'text' && typeof blockValue.text === 'string' && blockValue.text) {
              assistant.text += blockValue.text;
              scheduleRender();
            }
            return;
          }
          if (event.type === 'content_block_delta') {
            const delta = event.delta || {};
            if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
              assistant.reasoning += delta.thinking;
              scheduleRender();
            } else if (delta.type === 'text_delta' && typeof delta.text === 'string') {
              assistant.text += delta.text;
              scheduleRender();
            }
          }
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          buffer = buffer.replace(/\r\n/g, '\n');
          let boundary = buffer.indexOf('\n\n');
          while (boundary !== -1) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            handleEvent(block);
            boundary = buffer.indexOf('\n\n');
          }
        }
        if (buffer.trim()) handleEvent(buffer);
        if (!assistant.text.trim()) throw new Error('模型没有返回文本内容');
        assistant.html = renderMarkdown(assistant.text);
        assistant.streaming = false;
        const searchActivities = (assistant.activity || []).filter((item) => item.type === 'search');
        assistant.activity = [
          ...searchActivities,
          ...(wantsThinking ? [{ type: 'think', label: '思考', preview: reasoningSummary(assistant.reasoning, false) || '已完成分析' }] : []),
        ];
        streams.delete(sessionId);
        syncBusy();
        syncSession(sessionId);
        if (state.activeId === sessionId) renderMessages();
        void maybeGenerateTitle(sessionId);
      } catch (error) {
        const aborted = error instanceof DOMException && error.name === 'AbortError';
        assistant.streaming = false;
        if (aborted) {
          // Stop means keep whatever already streamed in; no error styling.
          assistant.stopped = true;
          assistant.error = '';
        } else {
          assistant.error = error instanceof Error ? error.message : String(error);
        }
        assistant.html = assistant.text ? renderMarkdown(assistant.text) : '';
        streams.delete(sessionId);
        syncBusy();
        syncSession(sessionId);
        if (state.activeId === sessionId) renderMessages();
        if (!aborted) showToast('请求失败，请查看消息中的错误');
      } finally {
        clearInterval(tick);
        timers.delete(tick);
        if (stream.frame) {
          cancelAnimationFrame(stream.frame);
          stream.frame = 0;
        }
        streams.delete(sessionId);
        syncBusy();
        updateSendState();
      }
    }

    async function sendRealMessage(text) {
      if (!state.api.loaded) await loadApiState();
      if (!state.api.configured) {
        showToast('请先在 DSH 设置中配置 DeepSeek 凭据');
        return;
      }
      let payload;
      try {
        payload = await collectAttachmentPayload(text);
      } catch (error) {
        showToast(error instanceof Error ? error.message : String(error));
        return;
      }
      if (payload.attachments.some((item) => item.kind === 'image' && item.unsupported)) {
        showToast('当前模型不支持图片输入，已仅发送文字与文档');
      }
      const session = ensureActiveSession(text || payload.attachments[0]?.name || '附件');
      commitSessionModel(session);
      appendMessageNode(session, {
        role: 'user',
        text,
        ...payload.attachments.length ? { attachments: payload.attachments } : {},
        ...payload.attachmentText ? { attachmentText: payload.attachmentText } : {},
        ...payload.images.length ? { images: payload.images } : {},
        ...payload.delegated ? { imagesDelegated: true } : {},
      });
      clearAttachments();
      syncActiveSession();
      await maybeCompressContext();
      await startReply(apiHistory(), Date.now(), {
        query: text || payload.attachmentText.slice(0, 500),
      });
    }

    function sendMessage() {
      if (state.findOn) {
        findNext(1);
        return;
      }
      const text = currentText();
      if (activeStream()) return;
      if (pendingAttachments.some((item) => item.status === 'reading')) {
        showToast('附件仍在读取中');
        return;
      }
      const hasReady = pendingAttachments.some((item) => item.status === 'ready');
      if (!text && !hasReady) return;
      if (state.api.available) {
        sendRealMessage(text);
        return;
      }
      sendDemoMessage(text);
    }

    async function regenerateMessage(index) {
      if (activeStream()) return;
      const session = sessionById(state.activeId);
      const node = state.messages[index];
      if (!session || !node || node.role !== 'assistant') return;
      ensureSessionTree(session);
      const parent = (session.tree || []).find((entry) => entry.id === node.parentId);
      if (!parent || parent.role !== 'user') {
        showToast('找不到对应的提问，无法重新生成');
        return;
      }
      session.currentId = parent.id;
      if (session.summary) delete session.summary;
      ensureSessionTree(session);
      state.messages = session.messages;
      storeSessions(state.sessions);
      renderMessages();
      commitSessionModel(session);
      await maybeCompressContext();
      startReply(apiHistory(), Date.now(), { query: parent.text || '' });
    }

    async function regenerateReply() {
      if (activeStream()) return;
      let lastUserIndex = -1;
      for (let index = state.messages.length - 1; index >= 0; index -= 1) {
        if (state.messages[index].role === 'user') {
          lastUserIndex = index;
          break;
        }
      }
      if (lastUserIndex < 0) return;
      if (state.api.available && !state.api.configured) {
        showToast('请先在 DSH 设置中配置 DeepSeek 凭据');
        return;
      }
      const query = state.messages[lastUserIndex].text || '';
      // Truncate in place so the active session keeps the same array identity.
      state.messages.length = lastUserIndex + 1;
      const session = sessionById(state.activeId);
      if (session) {
        const userNode = state.messages[lastUserIndex];
        if (userNode?.id) session.currentId = userNode.id;
        ensureSessionTree(session);
        commitSessionModel(session);
      }
      if (session?.summary && Number(session.summary.throughIndex) > lastUserIndex) {
        delete session.summary;
        storeSessions(state.sessions);
      }
      if (state.api.available) {
        await maybeCompressContext();
        startReply(apiHistory(), Date.now(), { query });
        return;
      }
      const sessionId = state.activeId;
      const messages = state.messages;
      const stream = { controller: null, assistant: null, demoTimer: null };
      streams.set(sessionId, stream);
      syncBusy();
      renderMessages();
      const timer = setTimeout(() => {
        timers.delete(timer);
        appendMessageNode(session, { role: 'assistant', html: GENERIC_HTML });
        streams.delete(sessionId);
        syncBusy();
        syncSession(sessionId);
        if (state.activeId === sessionId) renderMessages();
      }, 600);
      stream.demoTimer = timer;
      timers.add(timer);
    }

    function messageText(message) {
      if (!message) return '';
      if (message.role === 'user') {
        const images = Array.isArray(message.attachments)
          ? message.attachments.filter((item) => item.kind === 'image').map((item) => `[图片：${item.name}]`)
          : [];
        return [message.text, message.attachmentText, ...images].filter(Boolean).join('\n\n');
      }
      return message.text || stripTags(message.html || '');
    }

    function searchSnippet(text, needle, fallbackIndex) {
      const clean = String(text).replace(/\s+/g, ' ').trim();
      const found = clean.toLowerCase().indexOf(needle);
      const at = found >= 0 ? found : Math.max(0, Math.min(fallbackIndex, clean.length - 1));
      const start = Math.max(0, at - 28);
      const end = Math.min(clean.length, at + needle.length + 48);
      return `${start > 0 ? '…' : ''}${clean.slice(start, end)}${end < clean.length ? '…' : ''}`;
    }

    function resultTime(timestamp) {
      const date = new Date(Number(timestamp) || Date.now());
      const now = new Date();
      const sameDay = date.getFullYear() === now.getFullYear()
        && date.getMonth() === now.getMonth()
        && date.getDate() === now.getDate();
      if (sameDay) {
        return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
      }
      return `${date.getMonth() + 1}月${date.getDate()}日`;
    }

    // Official search traverses conversation titles and every message body,
    // then lists hits by conversation recency (newest first).
    function searchMatches(query) {
      const needle = query.trim().toLowerCase();
      if (!needle) return [];
      const results = [];
      for (const session of state.sessions) {
        const title = session.title || '';
        const titleHit = title.toLowerCase().includes(needle);
        let snippet = null;
        const messages = session.messages || [];
        for (let i = messages.length - 1; i >= 0; i--) {
          const text = messageText(messages[i]);
          const pos = text.toLowerCase().indexOf(needle);
          if (pos >= 0) {
            snippet = searchSnippet(text, needle, pos);
            break;
          }
        }
        if (!titleHit && snippet == null) continue;
        results.push({ session, title, snippet, time: Number(session.updatedAt) || 0 });
      }
      return results.sort((a, b) => b.time - a.time);
    }

    let searchCloseTimer = null;

    function renderSearchResults() {
      const query = searchInput.value.trim();
      if (!query) {
        searchResults.hidden = true;
        searchResults.innerHTML = '';
        return;
      }
      const items = searchMatches(query);
      searchResults.hidden = false;
      if (!items.length) {
        searchResults.innerHTML = '<div class="dsc-search-empty">没有找到相关对话</div>';
        return;
      }
      searchResults.innerHTML = items.map(({ session, title, snippet, time }) => `
        <button class="dsc-search-result" data-search-session="${escapeHtml(session.id)}">
          <span class="dsc-search-avatar" aria-hidden="true">${icon('chat', 18)}</span>
          <span class="dsc-search-body">
            <span class="dsc-search-head">
              <span class="dsc-search-title">${escapeHtml(title)}</span>
              <span class="dsc-search-time">${resultTime(time)}</span>
            </span>
            ${snippet ? `<span class="dsc-search-snippet">${escapeHtml(snippet)}</span>` : ''}
          </span>
        </button>`).join('');
    }

    function openSearch() {
      closeThinkMenu();
      if (searchCloseTimer) {
        clearTimeout(searchCloseTimer);
        searchCloseTimer = null;
      }
      overlayEl.hidden = false;
      overlayEl.classList.remove('show');
      searchInput.value = '';
      renderSearchResults();
      // Two frames so the closed styles are committed before the transition.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        overlayEl.classList.add('show');
        searchInput.focus();
      }));
    }

    function closeSearch() {
      if (overlayEl.hidden) return;
      overlayEl.classList.remove('show');
      if (searchCloseTimer) clearTimeout(searchCloseTimer);
      searchCloseTimer = setTimeout(() => {
        searchCloseTimer = null;
        overlayEl.hidden = true;
      }, 200);
    }

    function onClick(event) {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      const actionEl = target.closest('[data-act]');
      const sessionEl = target.closest('[data-session]');
      const searchSessionEl = target.closest('[data-search-session]');
      const thinkOptionEl = target.closest('[data-think-option]');
      const modelOptionEl = target.closest('[data-model-option]');
      const searchModeEl = target.closest('[data-search-mode]');
      const ttsVoiceEl = target.closest('[data-tts-voice]');
      const menuActEl = target.closest('[data-menu-act]');

      if (!thinkPop.hidden && !target.closest('[data-role="think-pop"]') && !target.closest('[data-act="think-menu"]')) {
        closeThinkMenu();
      }
      if (!modelPop.hidden && !target.closest('[data-role="model-pop"]') && !target.closest('[data-act="model-menu"]')) {
        closeModelMenu();
      }
      if (!searchPop.hidden && !target.closest('[data-role="search-pop"]') && !target.closest('[data-act="toggle-search"]')) {
        closeSearchMenu();
      }
      if (capabilityPop && !capabilityPop.hidden
        && !target.closest('[data-role="capability-pop"]')
        && !target.closest('[data-act="open-capabilities"]')) {
        closeCapabilities();
      }
      if (!sessionMenuEl.hidden && !target.closest('[data-role="session-menu"]') && !target.closest('[data-act="session-menu"]') && !target.closest('[data-act="account-menu"]')) {
        closeSessionMenu();
      }
      if (target.closest('[data-rename-input]')) return;

      if (menuActEl) {
        const id = state.sessionMenuId;
        const menuAct = menuActEl.dataset.menuAct;
        if (menuAct === 'import-sessions') {
          closeSessionMenu();
          importFileEl.click();
          return;
        }
        const session = id ? sessionById(id) : null;
        if (!session) return;
        if (menuAct === 'rename') {
          startRename(id);
          return;
        }
        if (menuAct === 'pin') {
          session.pinned = true;
          storeSessions(state.sessions);
          closeSessionMenu();
          renderSessions();
          showToast('已置顶');
          return;
        }
        if (menuAct === 'multi') {
          closeSessionMenu();
          enterSelectMode(id);
          return;
        }
        if (menuAct === 'delete') {
          if (!state.menuDeleteArmed) {
            state.menuDeleteArmed = true;
            menuActEl.classList.add('armed');
            const label = menuActEl.querySelector('span');
            if (label) label.textContent = '确认删除';
            if (menuDeleteTimer) clearTimeout(menuDeleteTimer);
            menuDeleteTimer = setTimeout(() => {
              menuDeleteTimer = null;
              state.menuDeleteArmed = false;
              const item = sessionMenuEl.querySelector('[data-menu-act="delete"]');
              item?.classList.remove('armed');
              const text = item?.querySelector('span');
              if (text) text.textContent = '删除';
            }, 3000);
            return;
          }
          deleteSingleSession(id);
          return;
        }
        return;
      }

      if (actionEl) {
        const act = actionEl.dataset.act;
        if (act === 'toggle-sidebar') {
          setSidebar(state.sidebar === 'expanded' ? 'collapsed' : 'expanded');
          return;
        }
        if (act === 'new-chat') {
          newChat();
          return;
        }
        if (act === 'home') {
          event.preventDefault();
          newChat();
          return;
        }
        if (act === 'open-search') {
          openSearch();
          return;
        }
        if (act === 'close-search') {
          closeSearch();
          return;
        }
        if (act === 'toggle-search') {
          if (!searchModelReady()) {
            showToast(selectedSearchProvider().kind === 'official'
              ? '联网搜索需要 DeepSeek-V4.1-Flash（官方 API）'
              : '联网搜索子 Agent 不可用');
            return;
          }
          setSearchMode(state.searchOn ? 'off' : 'on');
          return;
        }
        if (act === 'think-menu') {
          if (state.thinkingSupported === false) {
            showToast('当前模型使用自身的思考策略，不支持档位选择');
            return;
          }
          openThinkMenu(actionEl);
          return;
        }
        if (act === 'model-menu') {
          openModelMenu(actionEl);
          return;
        }
        if (act === 'send') {
          if (state.findOn) {
            findNext(1);
            return;
          }
          const stream = activeStream();
          if (stream?.controller) stream.controller.abort();
          else if (!state.busy) sendMessage();
          return;
        }
        if (act === 'toggle-find') {
          toggleFind();
          return;
        }
        if (act === 'attach') {
          attachFileEl.click();
          return;
        }
        if (act === 'open-image') {
          const image = actionEl.querySelector('img');
          if (image) openImageViewer(image.src, image.alt);
          return;
        }
        if (act === 'remove-attachment') {
          const id = actionEl.dataset.attachId;
          const index = pendingAttachments.findIndex((item) => item.id === id);
          if (index >= 0) {
            const [item] = pendingAttachments.splice(index, 1);
            recordAttachAction({ type: 'remove', item, index });
            renderAttachmentStrips();
          }
          return;
        }
        if (act === 'session-menu') {
          event.stopPropagation();
          const row = actionEl.closest('[data-session]');
          if (row) openSessionMenu(row.dataset.session, actionEl);
          return;
        }
        if (act === 'select-mode') {
          enterSelectMode();
          return;
        }
        if (act === 'exit-select') {
          exitSelectMode();
          return;
        }
        if (act === 'pin-selected') {
          requestPinSelected();
          return;
        }
        if (act === 'delete-selected') {
          requestDeleteSelected();
          return;
        }
        if (act === 'dialog-cancel') {
          closeDialog();
          return;
        }
        if (act === 'dialog-confirm') {
          confirmDialog();
          return;
        }
        if (act === 'select-work') {
          if (state.selectMode) exitSelectMode();
          if (typeof opts.onSelectWork === 'function') opts.onSelectWork();
          return;
        }
        if (act === 'copy') {
          const index = Number(actionEl.dataset.messageIndex);
          const message = Number.isInteger(index) ? state.messages[index] : null;
          let text = '';
          if (message) {
            text = message.role === 'assistant'
              ? (message.text || stripTags(message.html || ''))
              : (message.text || '');
          } else {
            const msgs = $$('.dsc-msg-assistant .dsc-md');
            text = msgs.length ? stripTags(msgs[msgs.length - 1].innerHTML) : '';
          }
          navigator.clipboard?.writeText?.(text).then(() => showToast('已复制')).catch(() => showToast('复制失败'));
          return;
        }
        if (act === 'copy-code') {
          const code = actionEl.closest('.dsc-code-block')?.querySelector('code');
          const text = code ? code.textContent : '';
          navigator.clipboard?.writeText?.(text).then(() => {
            // Inline confirmation like DSH: the label itself flips, no toast.
            actionEl.textContent = '已复制';
            if (actionEl.dscCopiedTimer) clearTimeout(actionEl.dscCopiedTimer);
            actionEl.dscCopiedTimer = setTimeout(() => {
              actionEl.textContent = '复制';
              actionEl.dscCopiedTimer = null;
            }, 1000);
          }).catch(() => showToast('复制失败'));
          return;
        }
        if (act === 'regenerate') {
          const index = Number(actionEl.dataset.messageIndex);
          if (Number.isInteger(index) && state.messages[index]?.role === 'assistant') {
            void regenerateMessage(index);
          } else {
            regenerateReply();
          }
          return;
        }
        if (act === 'edit-message') {
          openEditMessage(Number(actionEl.dataset.messageIndex));
          return;
        }
        if (act === 'delete-message') {
          requestDeleteMessage(Number(actionEl.dataset.messageIndex));
          return;
        }
        if (act === 'edit-cancel') {
          closeEditMessage();
          return;
        }
        if (act === 'edit-save') {
          void saveEditMessage();
          return;
        }
        if (act === 'branch-switch') {
          switchBranch(actionEl.dataset.branchTarget);
          return;
        }
        if (act === 'toggle-reasoning') {
          toggleReasoning(Number(actionEl.dataset.messageIndex));
          return;
        }
        if (act === 'toggle-sources') {
          toggleSources(Number(actionEl.dataset.messageIndex));
          return;
        }
        if (act === 'read') {
          toggleReadAloud(actionEl);
          return;
        }
        if (act === 'share') {
          showToast('单条分享链接需要 DeepSeek 服务端，暂不支持');
          return;
        }
        if (act === 'account-menu') {
          openSettings();
          return;
        }
        if (act === 'settings-import') {
          closeSettings();
          importFileEl.click();
          return;
        }
        if (act === 'settings-readme') {
          openReadme();
          return;
        }
        if (act === 'readme-close') {
          closeReadme();
          return;
        }
        if (act === 'settings-export') {
          openExportDialog();
          return;
        }
        if (act === 'export-close' || act === 'export-cancel') {
          closeExportDialog();
          return;
        }
        if (act === 'export-mode') {
          void exportAll(actionEl.dataset.exportMode);
          return;
        }
        if (act === 'import-link') {
          importFromLink();
          return;
        }
        if (act === 'open-capabilities') {
          openCapabilities();
          return;
        }
        if (act === 'undo-import') {
          requestUndoImport();
          return;
        }
        if (act === 'clear-legacy-import') {
          requestClearLegacy(actionEl);
          return;
        }
        if (act === 'import-preview-close' || act === 'import-preview-cancel') {
          closeImportPreview();
          return;
        }
        if (act === 'import-preview-confirm') {
          confirmImportPreview();
          return;
        }
        if (act === 'import-select-all') {
          setImportPreviewSelection(true);
          return;
        }
        if (act === 'import-select-none') {
          setImportPreviewSelection(false);
          return;
        }
        if (act === 'settings-close' || act === 'settings-cancel') {
          closeSettings();
          return;
        }
        return;
      }

      if (ttsVoiceEl) {
        setTtsVoice(ttsVoiceEl.dataset.ttsVoice);
        return;
      }
      if (searchModeEl) {
        setSearchMode(searchModeEl.dataset.searchMode);
        closeSearchMenu();
        return;
      }
      if (thinkOptionEl) {
        setThinking(thinkOptionEl.dataset.thinkOption);
        closeThinkMenu();
        return;
      }

      if (modelOptionEl) {
        selectModel(modelOptionEl.dataset.modelOption, modelOptionEl.dataset.modelProvider);
        return;
      }

      if (sessionEl) {
        if (state.selectMode) toggleSessionSelected(sessionEl.dataset.session);
        else openSession(sessionEl.dataset.session);
        return;
      }

      if (searchSessionEl) {
        closeSearch();
        if (state.selectMode) exitSelectMode();
        openSession(searchSessionEl.dataset.searchSession);
        return;
      }

      if (target === editOverlay) closeEditMessage();
      if (target === exportPreviewEl) closeExportDialog();
      if (target === importPreviewEl) closeImportPreview();
      if (target === overlayEl) closeSearch();
      if (target === readmeEl) closeReadme();
      if (target === settingsEl) closeSettings();
      if (target === dialogEl) closeDialog();
    }

    function onInput(event) {
      const target = event.target;
      if (!(target instanceof HTMLTextAreaElement)) return;
      if (state.findOn) {
        updateFindQuery(target.value);
        syncComposerHeights();
        return;
      }
      // Keep both composers in sync.
      $$('.dsc-composer textarea').forEach((area) => {
        if (area !== target) area.value = target.value;
      });
      syncComposerHeights();
      updateSendState();
    }

    function onKeyDown(event) {
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'z') {
        const editing = event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement;
        if (!editing || !event.target.value) {
          if (undoAttachmentAction()) {
            event.preventDefault();
            return;
          }
        }
      }
      if (event.key === 'Escape') {
        if (editOverlay && !editOverlay.hidden) {
          closeEditMessage();
          return;
        }
        if (state.findOn) {
          event.preventDefault();
          exitFind();
          return;
        }
        if (imageViewerEl && !imageViewerEl.hidden) {
          closeImageViewer();
          return;
        }
        if (exportPreviewEl && !exportPreviewEl.hidden) {
          closeExportDialog();
          return;
        }
        if (importPreviewEl && !importPreviewEl.hidden) {
          closeImportPreview();
          return;
        }
        if (capabilityPop && !capabilityPop.hidden) {
          closeCapabilities();
          return;
        }
        if (dialogEl && !dialogEl.hidden) {
          closeDialog();
          return;
        }
        if (!sessionMenuEl.hidden) {
          closeSessionMenu();
          return;
        }
        if (readmeEl && !readmeEl.hidden) {
          closeReadme();
          return;
        }
        if (settingsEl && !settingsEl.hidden) {
          closeSettings();
          return;
        }
        if (!modelPop.hidden) {
          closeModelMenu();
          return;
        }
        if (!searchPop.hidden) {
          closeSearchMenu();
          return;
        }
        if (!thinkPop.hidden) {
          closeThinkMenu();
          return;
        }
        if (!overlayEl.hidden) {
          closeSearch();
          return;
        }
        if (state.selectMode) {
          exitSelectMode();
          return;
        }
      }
      if (event.target instanceof HTMLInputElement && event.target.matches('[data-rename-input]')) {
        if (event.key === 'Enter') {
          event.preventDefault();
          commitRename();
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          cancelRename();
          return;
        }
      }
      if (event.key === 'Enter' && event.target instanceof HTMLTextAreaElement) {
        if (editOverlay && !editOverlay.hidden) return;
        if (state.findOn) {
          event.preventDefault();
          findNext(event.shiftKey ? -1 : 1);
          return;
        }
        if (!event.shiftKey) {
          event.preventDefault();
          sendMessage();
        }
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        openSearch();
      }
    }

    root.addEventListener('click', onClick, { signal });
    root.addEventListener('input', onInput, { signal });
    root.addEventListener('keydown', onKeyDown, { signal });
    searchInput.addEventListener('input', renderSearchResults, { signal });
    // The root click handler already dispatches data-act="select-work".
    window.addEventListener('resize', closeThinkMenu, { signal });
    railList?.addEventListener('mousemove', (event) => {
      const row = event.target.closest('[data-rail-index]');
      if (!row) return;
      const index = Number(row.dataset.railIndex);
      if (index === railHover) return;
      railHover = index;
      if (railTipTimer) {
        clearTimeout(railTipTimer);
        railTipTimer = null;
      }
      paintRail();
      syncRailTip();
    }, { signal });
    railList?.addEventListener('mouseleave', () => {
      railHover = -1;
      paintRail();
      scheduleRailTipHide();
    }, { signal });
    railList?.addEventListener('click', (event) => {
      const row = event.target.closest('[data-rail-index]');
      if (!row) return;
      const item = railItems[Number(row.dataset.railIndex)];
      if (!item) return;
      if (railPinned === item.nid) {
        railPinned = '';
        hideRailTip();
        paintRail();
        return;
      }
      railPinned = item.nid;
      jumpToRail(item);
      paintRail();
      showRailTip(Number(row.dataset.railIndex));
    }, { signal });
    railTip?.addEventListener('mouseenter', () => {
      if (railTipTimer) {
        clearTimeout(railTipTimer);
        railTipTimer = null;
      }
    }, { signal });
    railTip?.addEventListener('mouseleave', scheduleRailTipHide, { signal });
    railTip?.addEventListener('click', (event) => {
      const sib = event.target.closest('[data-rail-sib]');
      if (!sib) return;
      switchBranch(sib.dataset.railSib);
      railPinned = '';
      hideRailTip();
      renderRail();
    }, { signal });
    stageEl.addEventListener('scroll', scheduleRailVisible, { passive: true, signal });
    window.addEventListener('resize', scheduleRailVisible, { signal });
    stageEl.addEventListener('scroll', closeThinkMenu, { signal });
    stageEl.addEventListener('scroll', () => {
      if (!stageEl) return;
      stickToBottom = stageEl.scrollHeight - stageEl.scrollTop - stageEl.clientHeight <= 24;
    }, { signal });
    sessionsEl.addEventListener('scroll', closeSessionMenu, { signal });
    importFileEl.addEventListener('change', handleImportFile, { signal });
    importListEl?.addEventListener('change', (event) => {
      const input = event.target.closest('input[data-import-id]');
      if (!input || !importPreviewState) return;
      if (input.checked) importPreviewState.selected.add(input.dataset.importId);
      else importPreviewState.selected.delete(input.dataset.importId);
      updateImportPreviewCount();
    }, { signal });
    let importSearchTimer = null;
    importSearchEl?.addEventListener('input', () => {
      if (importSearchTimer) clearTimeout(importSearchTimer);
      importSearchTimer = setTimeout(() => {
        importSearchTimer = null;
        if (!importPreviewState) return;
        importPreviewState.query = importSearchEl.value;
        renderImportPreview();
      }, 120);
    }, { signal });
    $('.dsc-settings-card')?.addEventListener('scroll', () => closeCapabilities(true), { passive: true, signal });
    window.addEventListener('resize', () => {
      if (capabilityPop && !capabilityPop.hidden) positionCapabilityPop();
    }, { signal });
    editText?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void saveEditMessage();
      }
    }, { signal });
    toastActionEl?.addEventListener('click', () => {
      const handler = toastActionHandler;
      hideToast();
      if (handler) handler();
    }, { signal });
    importUrlEl?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        importFromLink();
      }
    }, { signal });
    attachFileEl.addEventListener('change', (event) => {
      // Snapshot first: resetting value empties the live FileList.
      const files = event.target.files ? [...event.target.files] : [];
      event.target.value = '';
      if (files.length) void addAttachmentFiles(files);
    }, { signal });
    $$('[data-setting]').forEach((select) => select.addEventListener('change', () => {
      const key = select.dataset.setting;
      if (key === 'vision') {
        state.visionModel = select.value;
        remember('dsc.visionModel', select.value);
        return;
      }
      if (key === 'asr') {
        state.asrModel = select.value;
        remember('dsc.asrModel', select.value);
        return;
      }
      if (key === 'tts') {
        state.ttsModel = select.value;
        remember('dsc.ttsModel', select.value);
        return;
      }
      if (key === 'search') {
        state.searchProvider = select.value;
        remember('dsc.searchProvider', select.value);
        updateSearchAvailability();
      }
    }, { signal }));
    imageViewerEl.addEventListener('click', (event) => {
      if (event.target === imageViewerEl) closeImageViewer();
    }, { signal });
    $$('.dsc-composer textarea').forEach((area) => area.addEventListener('paste', onComposerPaste, { signal }));
    $$('.dsc-composer-wrap').forEach(bindComposerDrop);
    // Never let a stray file drop navigate the whole app to the file.
    const preventFileDrop = (event) => {
      if (Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault();
    };
    root.addEventListener('dragover', preventFileDrop, { signal });
    root.addEventListener('drop', preventFileDrop, { signal });
    window.addEventListener('dsc:new-chat', () => newChat(), { signal });
    window.addEventListener('dsc:account', (event) => {
      state.account = event.detail || null;
      renderAccount();
    }, { signal });
    window.addEventListener('dsc:theme', (event) => {
      state.theme = event.detail === 'dark' ? 'dark' : 'light';
      root.dataset.theme = state.theme;
      renderRail();
    }, { signal });
    let hostSaveWarnedAt = 0;
    window.addEventListener('dsc:host-save-failed', () => {
      const now = Date.now();
      if (now - hostSaveWarnedAt < 30_000) return;
      hostSaveWarnedAt = now;
      showToast('会话保存失败：刷新后改动可能丢失');
    }, { signal });
    $('[data-act="select-work"]').addEventListener('click', () => opts.onSelectWork?.(), { signal });

    renderSessions();
    renderAccount();
    updateThinkSupport();
    renderModelLabel();
    setThinking(state.thinking);
    ttsVoiceGlobal = state.ttsVoice;
    setSearchMode(state.searchMode);
    setNotice();
    setView('welcome');
    updateSendState();
    loadApiState();
    renderTtsVoice();
    void loadTtsCacheKeys();
    void hydrateHostSessions();


    return {
      dispose() {
        timers.forEach((timer) => clearTimeout(timer));
        timers.clear();
        if (sidebarTimer) clearTimeout(sidebarTimer);
        [...streams.keys()].forEach((id) => abortSessionStream(id));

        controller.abort();
        root.remove();
      },
      openSearch,
      newChat,
    };
  }

  window.DSChat = { mount, version: '2.26.1' };
})();
