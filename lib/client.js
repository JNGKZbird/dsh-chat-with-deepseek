/**
 * Client half of dsh-chat-with-deepseek.
 *
 * A normal DSH sidebar entry opens a full-window overlay that renders the
 * shared web app (app/). The DSH work surface and its sidebar are never
 * selected, collapsed, reordered, or restyled by this plugin: the overlay
 * simply covers them, and closing the overlay reveals the untouched work UI.
 */
window.__ModuleLoader__.load({
  id: 'dsh-chat-with-deepseek',
  factory(require) {
    const React = require('react');
    const ReactDOM = require('react-dom');
    const h = React.createElement;
    const BASE = '/dsh-deepseek-chat';

    window.DSC_APP_BASE = `${BASE}/app/`;

    const APP_VERSION = '2.27.3';
    const ICON_VERSION = '16';
    const CSS_VERSION = '83';
    const KATEX_VERSION = '1';
    const VENDOR_VERSION = '3';
    let appPromise = null;
    function ensureApp() {
      const cssHref = `${BASE}/app/css/app.css?v=${CSS_VERSION}`;
      if (window.DSChat?.version === APP_VERSION
        && window.DSCIcons?.version === ICON_VERSION
        && document.querySelector(`link[data-dsc-style][href="${cssHref}"]`)) {
        return Promise.resolve(window.DSChat);
      }
      if (appPromise) return appPromise;
      const loadScript = (src) => new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.async = true;
        script.onload = resolve;
        script.onerror = () => reject(new Error(`${src} failed to load`));
        document.head.appendChild(script);
      });
      appPromise = Promise.resolve().then(async () => {
        const href = cssHref;
        if (!document.querySelector(`link[data-dsc-style][href="${href}"]`)) {
          const link = document.createElement('link');
          link.rel = 'stylesheet';
          link.href = href;
          link.dataset.dscStyle = '1';
          document.head.appendChild(link);
        }
        if (window.DSCIcons?.version !== ICON_VERSION) await loadScript(`${BASE}/app/js/icons.js?v=${ICON_VERSION}`);
        if (!window.markdownit) await loadScript(`${BASE}/app/vendor/markdown-it.min.js?v=3`);
        const katexCss = `${BASE}/app/vendor/katex/katex.min.css?v=${KATEX_VERSION}`;
        if (!document.querySelector(`link[data-dsc-katex][href="${katexCss}"]`)) {
          const link = document.createElement('link');
          link.rel = 'stylesheet';
          link.href = katexCss;
          link.dataset.dscKatex = '1';
          document.head.appendChild(link);
        }
        if (!window.katex) {
          await loadScript(`${BASE}/app/vendor/katex/katex.min.js?v=${KATEX_VERSION}`).catch(() => {});
        }
        if (!window.JSZip) {
          await loadScript(`${BASE}/app/vendor/jszip/jszip.min.js?v=${VENDOR_VERSION}`).catch(() => {});
        }
        if (!window.pdfjsLib) {
          await loadScript(`${BASE}/app/vendor/pdfjs/pdf.min.js?v=${VENDOR_VERSION}`).catch(() => {});
        }
        if (window.DSChat?.version !== APP_VERSION) await loadScript(`${BASE}/app/js/app.js?v=91`);
        if (window.DSChat?.version === APP_VERSION) return window.DSChat;
        throw new Error('DSChat missing after app.js load');
      });
      return appPromise;
    }

    let accountInfo = null;

    function readHostTheme() {
      return document.body?.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light';
    }

    let hostTheme = readHostTheme();

    // ---- full-window overlay state -------------------------------------

    let overlayPhase = 'closed';
    let overlayTimer = null;
    const overlayListeners = new Set();

    function publishOverlay() {
      for (const listener of overlayListeners) listener(overlayPhase);
    }

    function openChatOverlay() {
      if (overlayPhase === 'open' || overlayPhase === 'opening') return;
      clearTimeout(overlayTimer);
      overlayPhase = 'opening';
      publishOverlay();
      // 150ms cover + 100ms hand-off + 200ms reveal, plus a small margin.
      overlayTimer = setTimeout(() => {
        if (overlayPhase === 'opening') {
          overlayPhase = 'open';
          publishOverlay();
        }
      }, 320);
    }

    function closeChatOverlay() {
      if (overlayPhase !== 'open' && overlayPhase !== 'opening') return;
      clearTimeout(overlayTimer);
      overlayPhase = 'closing';
      publishOverlay();
      // 120ms content out + 100ms hand-off + 150ms cover out.
      overlayTimer = setTimeout(() => {
        if (overlayPhase === 'closing') {
          overlayPhase = 'closed';
          publishOverlay();
        }
      }, 280);
    }

    function ChatSurface(props) {
      const ref = React.useRef(null);
      React.useEffect(() => {
        let disposed = false;
        let handle = null;
        // Measure the three real host anchors independently: brand identity,
        // New Session button, and the "chat" panel row. Each of our matching
        // elements gets its own gap, so one host layout quirk cannot drag the
        // others down.
        const measureHost = () => {
          try {
            const host = ref.current;
            const overlay = host?.closest('.dsc-overlay');
            const visible = (el, minWidth = 0, minHeight = 0) => {
              const r = el?.getBoundingClientRect();
              return !!(r && r.width >= minWidth && r.height >= minHeight);
            };
            const firstTop = (els) => {
              const tops = els.filter((el) => visible(el)).map((el) => el.getBoundingClientRect().top);
              return tops.length ? Math.min(...tops) : null;
            };
            const overlayTop = overlay?.getBoundingClientRect().top;
            const brandTop = firstTop(
              [...document.querySelectorAll('[data-slot="sidebar.brand.name"]')]
                .map((el) => el.closest('[class*="brandIdentity"]') || el)
                .filter((el) => visible(el, 100, 20)),
            );
            // Only the expanded New Session button; the collapsed titlebar
            // variant is 28px and would skew the anchor.
            const newTop = firstTop(
              [...document.querySelectorAll('[class*="newSession"]')]
                .filter((el) => visible(el, 80, 30)),
            );
            const chatTop = firstTop(
              [...document.querySelectorAll('[data-slot="sidebar.panellist"]')]
                .map((el) => el.closest('button'))
                .filter((el) => el && visible(el, 80, 20)),
            );
            if (host && overlay && overlayTop != null && brandTop != null) {
              const pad = Math.max(0, Math.round(brandTop - overlayTop - 8));
              host.style.setProperty('--dsc-host-offset', `${pad}px`);
              if (newTop != null) {
                host.style.setProperty('--dsc-newchat-gap', `${Math.max(0, Math.round(newTop - overlayTop - pad - 40))}px`);
              }
              if (newTop != null && chatTop != null) {
                host.style.setProperty('--dsc-mode-gap', `${Math.max(0, Math.round(chatTop - newTop - 46))}px`);
              }
            }
          } catch { /* fall back to CSS defaults */ }
        };
        measureHost();
        const measureTimers = [80, 240, 500].map((ms) => setTimeout(measureHost, ms));
        window.addEventListener('resize', measureHost);
        ensureApp().then((app) => {
          if (disposed || !ref.current) return;
          handle = app.mount(ref.current, {
            surface: 'dsh',
            account: accountInfo,
            theme: hostTheme,
            onSelectWork: props.onSelectWork,
          });
        }).catch((error) => {
          if (ref.current) {
            ref.current.textContent = `聊天面板加载失败：${error.message}`;
          }
        });
        return () => {
          disposed = true;
          measureTimers.forEach((timer) => clearTimeout(timer));
          window.removeEventListener('resize', measureHost);
          handle?.dispose?.();
          handle = null;
        };
      }, []);
      return h('div', {
        ref,
        style: { height: '100%', width: '100%', minHeight: 0, overflow: 'hidden' },
      });
    }

    function mainRect() {
      const slot = document.querySelector('[data-slot="main"]');
      const el = slot?.parentElement ?? slot;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: Math.max(0, window.innerHeight - rect.top),
      };
    }

    function ChatOverlay() {
      const [phase, setPhase] = React.useState(overlayPhase);
      const [rect, setRect] = React.useState(mainRect);
      const [theme, setTheme] = React.useState(hostTheme);
      React.useEffect(() => {
        overlayListeners.add(setPhase);
        setPhase(overlayPhase);
        return () => { overlayListeners.delete(setPhase); };
      }, []);
      React.useEffect(() => {
        if (phase === 'closed') return undefined;
        const measure = () => setRect(mainRect());
        measure();
        // The host may still be finishing its startup layout on the first
        // open; re-measure until it settles so the overlay rect is stable.
        const timers = [80, 240, 500].map((ms) => setTimeout(measure, ms));
        window.addEventListener('resize', measure);
        return () => {
          timers.forEach((timer) => clearTimeout(timer));
          window.removeEventListener('resize', measure);
        };
      }, [phase]);
      React.useEffect(() => {
        const onChange = (event) => setTheme(event.detail === 'dark' ? 'dark' : 'light');
        window.addEventListener('dsc:theme', onChange);
        return () => window.removeEventListener('dsc:theme', onChange);
      }, []);
      if (phase === 'closed') return null;
      // Cover everything below the host titlebar: left sidebar + main column,
      // while the DSH top bar stays visible.
      const style = rect
        ? { inset: 'auto', left: 0, top: `${rect.top}px`, width: `${window.innerWidth}px`, height: `${rect.height}px` }
        : { inset: 0 };
      const overlay = h('div', { className: 'dsc-overlay', 'data-phase': phase, 'data-theme': theme, style },
        h('div', { className: 'dsc-overlay-bg' }),
        h('div', { className: 'dsc-overlay-content' },
          h(ChatSurface, { onSelectWork: closeChatOverlay })));
      // Main-column only: the DSH sidebar remains fully visible and untouched.
      return ReactDOM.createPortal(overlay, document.body);
    }

    // ---- plugin-manager bridge -----------------------------------------

    const openButtonStyle = {
      alignSelf: 'flex-start',
      padding: '8px 14px',
      borderRadius: '8px',
      border: 0,
      cursor: 'pointer',
      fontSize: '13px',
      background: 'var(--dsw-alias-button-primary-fill, #3964fe)',
      color: 'var(--dsw-alias-label-primary-foreground, #fff)',
    };

    function PluginManagerOpen({ view }) {
      if (view === 'summary') return '打开聊天面板';
      return h('div', {
        style: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '4px 0' },
      },
        h('p', {
          style: { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: '13px', lineHeight: '20px' },
        }, '侧栏入口被收起/取消固定后，可以从这里直接打开聊天面板。'),
        h('button', { type: 'button', onClick: openChatOverlay, style: openButtonStyle }, '打开聊天面板'));
    }

    // A top-level tab in the plugin manager: after the sidebar entry has been
    // unpinned, this remains reachable without digging into a row's config page.
    function PluginManagerTab() {
      return h('div', {
        style: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '28px 4px', maxWidth: '560px' },
      },
        h('h2', {
          style: { margin: 0, color: 'var(--dsw-alias-label-primary)', fontSize: '20px', lineHeight: '28px', fontWeight: 600 },
        }, 'DeepSeek 聊天'),
        h('p', {
          style: { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: '14px', lineHeight: '22px' },
        }, '使用 DSH 已配置的 DeepSeek 凭据，打开独立的流式聊天面板。侧栏入口被取消固定时，也可以从这里进入。'),
        h('button', { type: 'button', onClick: openChatOverlay, style: openButtonStyle }, '打开聊天面板'),
        h('p', {
          style: { margin: 0, color: 'var(--dsw-alias-label-caption, var(--dsw-alias-label-secondary))', fontSize: '12px', lineHeight: '18px' },
        }, '提示：DSH 的「取消固定」只影响当前窗口，重新加载或重启 DSH 后侧栏入口会恢复。'));
    }

    // ---- sidebar entry -------------------------------------------------

    function isChatEntry(target) {
      if (!(target instanceof Element)) return false;
      const button = target.closest('button');
      return !!(button && button.querySelector('img[data-dsc-entry="1"]'));
    }

    function ChatIcon() {
      return h('img', {
        src: `${BASE}/app/assets/whale.svg?v=3`,
        width: 16,
        height: 16,
        alt: '',
        draggable: false,
        'data-dsc-entry': '1',
        onClick: (event) => {
          event.preventDefault();
          event.stopPropagation();
          openChatOverlay();
        },
        style: { display: 'block', width: 16, height: 16, transform: 'translateY(1px)' },
      });
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const themeObserver = new MutationObserver(() => {
          const next = readHostTheme();
          if (next === hostTheme) return;
          hostTheme = next;
          window.dispatchEvent(new CustomEvent('dsc:theme', { detail: next }));
        });
        if (document.body) {
          themeObserver.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] });
        }
        ctx.effect(() => () => themeObserver.disconnect());
        // Document-level capture survives sidebar row re-renders and also
        // catches clicks on the row label, not just the 16px icon.
        const onPointerDown = (event) => {
          if (isChatEntry(event.target)) event.stopPropagation();
        };
        const onClick = (event) => {
          if (!isChatEntry(event.target)) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          openChatOverlay();
        };
        const onKeyDown = (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          if (!isChatEntry(document.activeElement)) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          openChatOverlay();
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('click', onClick, true);
        document.addEventListener('keydown', onKeyDown, true);
        ctx.effect(() => () => {
          document.removeEventListener('pointerdown', onPointerDown, true);
          document.removeEventListener('click', onClick, true);
          document.removeEventListener('keydown', onKeyDown, true);
        });
        ctx.inject(['remote', 'remote.account', 'locale'], (sub) => {
          const locale = sub.locale?.getSnapshot?.().active || 'zh_CN';
          const client = {
            version: '0.2.2-rc.3',
            locale,
            timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
          };
          Promise.resolve()
            .then(() => sub.remote.account.getProfile(client))
            .then((result) => {
              const value = result?.ok ? result.value : null;
              if (value?.status !== 'ready') return;
              const profile = value.value || {};
              accountInfo = {
                name: profile.name || profile.contact || null,
                avatarUrl: profile.avatarUrl || null,
              };
              window.dispatchEvent(new CustomEvent('dsc:account', { detail: accountInfo }));
            })
            .catch(() => { /* account is optional */ });
        });
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'deepseek-pc-chat',
          label: '聊天',
          order: -100,
        }, ChatIcon));
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'deepseek-pc-chat-overlay',
        }, ChatOverlay));
        ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: 'dsh-chat-with-deepseek#dsh-chat-with-deepseek',
        }, PluginManagerOpen));
        ctx.slots.inject('plugins.tab', () => ctx.slots.register({
          name: 'plugins.tab',
          id: 'deepseek-pc-chat',
          label: '聊天',
          order: 10,
        }, PluginManagerTab));
        ensureApp().catch(() => { /* surface the failure in the overlay instead */ });
      },
    };
  },
});
