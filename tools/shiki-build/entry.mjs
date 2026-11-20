// Offline Shiki runtime for the DSH chat plugin.
//
// Mirrors the DSH chat renderer's setup: Shiki core with the `css-variables`
// theme (so token colors come from the host's --shiki-* palette) and the
// JavaScript regex engine with forgiving patterns. Languages are loaded on
// demand as separate chunks so opening the chat never parses every grammar.
//
// The language set and the alias table below are the set the DSH chat surface
// supports (extracted from its web frontend); keep them in sync.
import { createHighlighterCore, createCssVariablesTheme } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

export const LANGS = {
  asciidoc: () => import('@shikijs/langs/asciidoc'),
  bat: () => import('@shikijs/langs/bat'),
  bibtex: () => import('@shikijs/langs/bibtex'),
  c: () => import('@shikijs/langs/c'),
  clojure: () => import('@shikijs/langs/clojure'),
  cmake: () => import('@shikijs/langs/cmake'),
  cpp: () => import('@shikijs/langs/cpp'),
  csharp: () => import('@shikijs/langs/csharp'),
  css: () => import('@shikijs/langs/css'),
  csv: () => import('@shikijs/langs/csv'),
  dart: () => import('@shikijs/langs/dart'),
  diff: () => import('@shikijs/langs/diff'),
  dotenv: () => import('@shikijs/langs/dotenv'),
  elixir: () => import('@shikijs/langs/elixir'),
  erlang: () => import('@shikijs/langs/erlang'),
  fish: () => import('@shikijs/langs/fish'),
  fsharp: () => import('@shikijs/langs/fsharp'),
  go: () => import('@shikijs/langs/go'),
  graphql: () => import('@shikijs/langs/graphql'),
  groovy: () => import('@shikijs/langs/groovy'),
  haskell: () => import('@shikijs/langs/haskell'),
  hcl: () => import('@shikijs/langs/hcl'),
  html: () => import('@shikijs/langs/html'),
  http: () => import('@shikijs/langs/http'),
  ini: () => import('@shikijs/langs/ini'),
  java: () => import('@shikijs/langs/java'),
  json: () => import('@shikijs/langs/json'),
  julia: () => import('@shikijs/langs/julia'),
  kotlin: () => import('@shikijs/langs/kotlin'),
  latex: () => import('@shikijs/langs/latex'),
  less: () => import('@shikijs/langs/less'),
  log: () => import('@shikijs/langs/log'),
  lua: () => import('@shikijs/langs/lua'),
  make: () => import('@shikijs/langs/make'),
  markdown: () => import('@shikijs/langs/markdown'),
  mdx: () => import('@shikijs/langs/mdx'),
  nix: () => import('@shikijs/langs/nix'),
  perl: () => import('@shikijs/langs/perl'),
  php: () => import('@shikijs/langs/php'),
  powershell: () => import('@shikijs/langs/powershell'),
  proto: () => import('@shikijs/langs/proto'),
  python: () => import('@shikijs/langs/python'),
  r: () => import('@shikijs/langs/r'),
  rst: () => import('@shikijs/langs/rst'),
  ruby: () => import('@shikijs/langs/ruby'),
  rust: () => import('@shikijs/langs/rust'),
  scala: () => import('@shikijs/langs/scala'),
  scss: () => import('@shikijs/langs/scss'),
  shellscript: () => import('@shikijs/langs/shellscript'),
  sql: () => import('@shikijs/langs/sql'),
  svelte: () => import('@shikijs/langs/svelte'),
  swift: () => import('@shikijs/langs/swift'),
  'system-verilog': () => import('@shikijs/langs/system-verilog'),
  toml: () => import('@shikijs/langs/toml'),
  typescript: () => import('@shikijs/langs/typescript'),
  vb: () => import('@shikijs/langs/vb'),
  verilog: () => import('@shikijs/langs/verilog'),
  vue: () => import('@shikijs/langs/vue'),
  xml: () => import('@shikijs/langs/xml'),
  yaml: () => import('@shikijs/langs/yaml'),
};

// Fence info string -> grammar id, exactly the DSH alias table.
const ALIASES = {
  typescript: 'typescript', ts: 'typescript', tsx: 'typescript',
  javascript: 'typescript', js: 'typescript', jsx: 'typescript',
  shellscript: 'shellscript', bash: 'shellscript', sh: 'shellscript',
  shell: 'shellscript', zsh: 'shellscript',
  json: 'json', jsonc: 'json',
  py: 'python', python: 'python',
  rb: 'ruby', ruby: 'ruby',
  go: 'go', rs: 'rust', rust: 'rust',
  java: 'java', c: 'c', cpp: 'cpp',
  cs: 'csharp', csharp: 'csharp',
  kotlin: 'kotlin', swift: 'swift', php: 'php',
  yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini',
  md: 'markdown', markdown: 'markdown', mdx: 'mdx',
  html: 'html', css: 'css', scss: 'scss', less: 'less',
  sql: 'sql', xml: 'xml', lua: 'lua',
  bat: 'bat', batch: 'bat',
  powershell: 'powershell', ps1: 'powershell', ps: 'powershell',
  fish: 'fish', properties: 'ini', dotenv: 'dotenv', env: 'dotenv',
  log: 'log', csv: 'csv',
  diff: 'diff', patch: 'diff', http: 'http', rst: 'rst',
  latex: 'latex', tex: 'latex', bibtex: 'bibtex', bib: 'bibtex',
  asciidoc: 'asciidoc', adoc: 'asciidoc',
  r: 'r', julia: 'julia', jl: 'julia', dart: 'dart', scala: 'scala',
  clojure: 'clojure', clj: 'clojure', erlang: 'erlang', erl: 'erlang',
  elixir: 'elixir', ex: 'elixir', exs: 'elixir',
  haskell: 'haskell', hs: 'haskell',
  fsharp: 'fsharp', fs: 'fsharp', fsi: 'fsharp', fsx: 'fsharp',
  vb: 'vb', vbnet: 'vb',
  perl: 'perl', pl: 'perl', pm: 'perl',
  verilog: 'verilog', v: 'verilog',
  'system-verilog': 'system-verilog', systemverilog: 'system-verilog',
  sv: 'system-verilog', svh: 'system-verilog',
  graphql: 'graphql', gql: 'graphql',
  proto: 'proto', protobuf: 'proto',
  hcl: 'hcl', tf: 'hcl', tfvars: 'hcl', nix: 'nix',
  vue: 'vue', svelte: 'svelte',
  make: 'make', makefile: 'make', mk: 'make', cmake: 'cmake',
  groovy: 'groovy', gradle: 'groovy',
};

// Languages worth paying for up front: they cover the overwhelming majority
// of chat fenced blocks, so a freshly opened conversation rarely flashes
// unhighlighted.
const PRELOAD = ['typescript', 'shellscript', 'json', 'python', 'html', 'css', 'markdown', 'yaml', 'xml', 'sql', 'diff'];

const theme = createCssVariablesTheme({
  name: 'css-variables',
  variablePrefix: '--shiki-',
  fontStyle: true,
});

export function resolveLang(name) {
  if (typeof name !== 'string') return undefined;
  const key = name.trim().toLowerCase();
  if (!key) return undefined;
  return ALIASES[key];
}

export class ShikiRuntime {
  constructor(core) {
    this.core = core;
    this.pending = new Map();
    this.failed = new Set();
  }

  static async create() {
    const core = await createHighlighterCore({
      themes: [theme],
      langs: [],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
    return new ShikiRuntime(core);
  }

  status(name) {
    const id = resolveLang(name);
    if (!id) return 'unsupported';
    if (this.failed.has(id)) return 'unsupported';
    return this.core.getLoadedLanguages().includes(id) ? 'ready' : 'loading';
  }

  load(name) {
    const id = resolveLang(name);
    if (!id) return Promise.resolve(null);
    if (this.core.getLoadedLanguages().includes(id)) return Promise.resolve(id);
    if (this.pending.has(id)) return this.pending.get(id);
    const job = LANGS[id]()
      .then((mod) => this.core.loadLanguage(mod.default ?? mod))
      .then(() => id)
      .catch(() => {
        this.failed.add(id);
        return null;
      })
      .finally(() => {
        this.pending.delete(id);
      });
    this.pending.set(id, job);
    return job;
  }

  preload() {
    return Promise.all(PRELOAD.map((name) => this.load(name)));
  }

  // Synchronous highlight. Returns null when the grammar is not loaded yet or
  // the language is unknown; callers render plain text and retry later.
  highlight(code, name) {
    const id = resolveLang(name);
    if (!id || !this.core.getLoadedLanguages().includes(id)) return null;
    try {
      return this.core.codeToHtml(code, { lang: id, theme: 'css-variables' });
    } catch {
      return null;
    }
  }
}

export async function createRuntime() {
  const runtime = await ShikiRuntime.create();
  await runtime.preload();
  return runtime;
}
