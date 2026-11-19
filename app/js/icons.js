(function () {
  // DSH 原生 16×16 图标，路径取自 dsh-client-ui-primitives 的
  // think-outline / globe-outline，保持与 DSH 工作区一致。
  const native = {
    deepThink: {
      viewBox: '0 0 16 16',
      strokeWidth: 1.2,
      body: '<path d="M10.2854 5.71481C12.9673 8.39663 14.1182 11.5938 12.8562 12.8559C11.5942 14.1179 8.39706 12.9669 5.71518 10.2851C3.03333 7.60323 1.88236 4.40608 3.14441 3.14403C4.40644 1.882 7.6036 3.03297 10.2854 5.71481Z" stroke="currentColor"></path><path d="M10.2854 10.2851C7.6036 12.9669 4.40644 14.1179 3.14441 12.8559C1.88236 11.5938 3.03333 8.39663 5.71518 5.71481C8.39706 3.03297 11.5942 1.882 12.8562 3.14403C14.1182 4.40608 12.9673 7.60323 10.2854 10.2851Z" stroke="currentColor"></path><path d="M8.86291 8.0002C8.86291 8.47549 8.47762 8.86087 8.00224 8.86087C7.52694 8.86087 7.1416 8.47549 7.1416 8.0002C7.1416 7.52485 7.52694 7.13953 8.00224 7.13953C8.47762 7.13953 8.86291 7.52485 8.86291 8.0002Z" fill="currentColor"></path>',
    },
    globe: {
      viewBox: '0 0 16 16',
      strokeWidth: 1.2,
      body: '<path d="M7.99986 14.0887C11.3626 14.0887 14.0886 11.3627 14.0886 7.99998C14.0886 4.63727 11.3626 1.91125 7.99986 1.91125C4.63715 1.91125 1.91113 4.63727 1.91113 7.99998C1.91113 11.3627 4.63715 14.0887 7.99986 14.0887Z" stroke="currentColor"></path><path d="M2.34619 8H13.6538" stroke="currentColor" stroke-linecap="square"></path><path d="M7.99976 14.0889C9.23509 14.0889 10.1743 11.3629 10.1743 8.00006C10.1743 4.63739 9.23509 1.91138 7.99976 1.91138" stroke="currentColor"></path><path d="M7.99973 14.0889C6.76445 14.0889 5.8252 11.3629 5.8252 8.00006C5.8252 4.63739 6.76445 1.91138 7.99973 1.91138" stroke="currentColor"></path>',
    },
    paperclip: {
      viewBox: '0 0 16 16',
      strokeWidth: 1.2,
      body: '<path d="M12.75 4.5V9.5C12.75 10.7598 12.2496 11.968 11.3588 12.8588C10.468 13.7496 9.25978 14.25 8 14.25C6.74022 14.25 5.53204 13.7496 4.64124 12.8588C3.75045 11.968 3.25 10.7598 3.25 9.5V5C3.25 4.13805 3.59241 3.3114 4.2019 2.7019C4.8114 2.09241 5.63805 1.75 6.5 1.75C7.36195 1.75 8.1886 2.09241 8.7981 2.7019C9.40759 3.3114 9.75 4.13805 9.75 5V9.5C9.75 9.96413 9.56563 10.4092 9.23744 10.7374C8.90925 11.0656 8.46413 11.25 8 11.25C7.53587 11.25 7.09075 11.0656 6.76256 10.7374C6.43437 10.4092 6.25 9.96413 6.25 9.5V5.5" stroke="currentColor"></path>',
    },
    newChat: {
      viewBox: '0 0 16 16',
      strokeWidth: 1.2,
      body: '<path d="M2.37091 11.2501C1.58745 9.89288 1.32067 8.29835 1.61969 6.76006C1.91872 5.22177 2.76342 3.8433 3.99826 2.87846C5.2331 1.91362 6.77494 1.42737 8.33988 1.50925C9.90482 1.59113 11.3875 2.23562 12.5149 3.32406C13.6425 4.41269 14.3387 5.87206 14.4754 7.4334C14.612 8.99474 14.18 10.5529 13.2587 11.8209C12.3375 13.0888 10.9891 13.9813 9.46194 14.3337C8.18691 14.628 6.85895 14.5294 5.64989 14.0605C5.1712 13.8748 4.76962 13.4932 4.26534 13.3967C3.67413 13.2835 2.95257 13.5598 2.03794 14.3337" stroke="currentColor"></path><path d="M8 5V11" stroke="currentColor"></path><path d="M5 8H11" stroke="currentColor"></path>',
    },
    chat: {
      // Same DSH conversation bubble as new-chat-outline, with two text lines
      // instead of the plus (official search-result avatar).
      viewBox: '0 0 16 16',
      strokeWidth: 1.2,
      body: '<path d="M2.37091 11.2501C1.58745 9.89288 1.32067 8.29835 1.61969 6.76006C1.91872 5.22177 2.76342 3.8433 3.99826 2.87846C5.2331 1.91362 6.77494 1.42737 8.33988 1.50925C9.90482 1.59113 11.3875 2.23562 12.5149 3.32406C13.6425 4.41269 14.3387 5.87206 14.4754 7.4334C14.612 8.99474 14.18 10.5529 13.2587 11.8209C12.3375 13.0888 10.9891 13.9813 9.46194 14.3337C8.18691 14.628 6.85895 14.5294 5.64989 14.0605C5.1712 13.8748 4.76962 13.4932 4.26534 13.3967C3.67413 13.2835 2.95257 13.5598 2.03794 14.3337" stroke="currentColor"></path><path d="M5.5 6.4H10.6" stroke="currentColor"></path><path d="M5.5 9.1H8.6" stroke="currentColor"></path>',
    },
    searchOutline: {
      viewBox: '0 0 16 16',
      strokeWidth: 1.2,
      body: '<path d="M6.58727 11.8586C9.55061 11.8586 11.9529 9.45637 11.9529 6.49304C11.9529 3.5297 9.55061 1.12744 6.58727 1.12744C3.62394 1.12744 1.22168 3.5297 1.22168 6.49304C1.22168 9.45637 3.62394 11.8586 6.58727 11.8586Z" stroke="currentColor"></path><path d="M10.2991 10.3933L14.7783 14.8725" stroke="currentColor"></path>',
    },
    panelLeft: {
      // Official DeepSeek web sidebar glyph: wider 16x15 frame with a much
      // larger corner radius than DSH's panel-left-outline (rx≈3.5 outer).
      viewBox: '0 0 16 16',
      strokeWidth: 1.2,
      body: '<rect x="0.9" y="0.9" width="14.2" height="14.2" rx="2.9" stroke="currentColor"></rect><path d="M5 0.9V15.1" stroke="currentColor"></path>',
    },
    pin: {
      viewBox: '0 0 16 16',
      strokeWidth: 1.2,
      body: '<path d="M9.96976 1.70572L13.1554 3.93629L10.9019 8.12317L11.5158 11.605L10.7192 12.7427L2.52767 7.00693L3.3243 5.86922L6.80612 5.25528L9.96976 1.70572Z" stroke="currentColor" stroke-linejoin="round"></path><path d="M6.05285 9.47511C6.27284 9.16094 6.70586 9.08458 7.02003 9.30457C7.3342 9.52455 7.41055 9.95757 7.19057 10.2717L3.98587 14.4708L3.21223 13.9291L6.05285 9.47511Z" fill="currentColor"></path>',
    },
    pinOff: {
      viewBox: '0 0 16 16',
      strokeWidth: 1.2,
      body: '<path d="M9.96976 1.70572L13.1554 3.93629L10.9019 8.12317L11.5158 11.605L10.7192 12.7427L2.52767 7.00693L3.3243 5.86922L6.80612 5.25528L9.96976 1.70572Z" stroke="currentColor" stroke-linejoin="round"></path><path d="M6.05285 9.47511C6.27284 9.16094 6.70586 9.08458 7.02003 9.30457C7.3342 9.52455 7.41055 9.95757 7.19057 10.2717L3.98587 14.4708L3.21223 13.9291L6.05285 9.47511Z" fill="currentColor"></path><path d="M2.2 2.2 13.8 13.8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"></path>',
    },
    trash: {
      viewBox: '0 0 16 16',
      strokeWidth: 1.2,
      body: '<path d="M1.28149 3.88831H14.7187" stroke="currentColor"></path><path d="M5.41602 3.88833V2.47962C5.41602 2.29282 5.52492 2.11366 5.71876 1.98157C5.9126 1.84948 6.17551 1.77527 6.44964 1.77527H9.55053C9.82466 1.77527 10.0876 1.84948 10.2814 1.98157C10.4753 2.11366 10.5842 2.29282 10.5842 2.47962V3.88833" stroke="currentColor"></path><path d="M2.57349 3.88831L3.19366 13.2943C3.21937 13.5502 3.33952 13.7872 3.53065 13.9593C3.72178 14.1313 3.97016 14.2259 4.22729 14.2246H11.7728C12.0299 14.2259 12.2783 14.1313 12.4694 13.9593C12.6605 13.7872 12.7807 13.5502 12.8064 13.2943L13.4266 3.88831" stroke="currentColor"></path><path d="M6.44946 6.98926V11.1238" stroke="currentColor"></path><path d="M9.55054 6.98926V11.1238" stroke="currentColor"></path>',
    },
  };

  const paths = {
    search: '<circle cx="11" cy="11" r="6.5"></circle><path d="m20 20-3.4-3.4"></path>',
    panel: '<rect x="3.5" y="4.5" width="17" height="15" rx="3"></rect><path d="M9 4.5v15"></path>',
    plus: '<path d="M12 5v14M5 12h14"></path>',
    plusCircle: '<circle cx="12" cy="12" r="8.5"></circle><path d="M12 8.5v7M8.5 12h7"></path>',
    more: '<circle cx="5" cy="12" r="1.2" fill="currentColor" stroke="none"></circle><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"></circle><circle cx="19" cy="12" r="1.2" fill="currentColor" stroke="none"></circle>',
    copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.5"></rect><path d="M15.5 8.5v-2A2.5 2.5 0 0 0 13 4H6.5A2.5 2.5 0 0 0 4 6.5V13a2.5 2.5 0 0 0 2.5 2.5h2"></path>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.2 6.3"></path><path d="M20 6v5h-5"></path>',
    thumbUp: '<path d="M7 10.5 10.2 4h.6c1.4 0 2.4 1.1 2.4 2.5V10h4.1c1.2 0 2.1 1.1 1.9 2.3l-1 6A2 2 0 0 1 16.2 20H7"></path><path d="M7 10.5H4.8A1.8 1.8 0 0 0 3 12.3v5.4A1.8 1.8 0 0 0 4.8 19.5H7z"></path>',
    thumbDown: '<path d="M7 13.5 10.2 20h.6c1.4 0 2.4-1.1 2.4-2.5V14h4.1c1.2 0 2.1-1.1 1.9-2.3l-1-6A2 2 0 0 0 16.2 4H7"></path><path d="M7 13.5H4.8A1.8 1.8 0 0 1 3 11.7V6.3A1.8 1.8 0 0 1 4.8 4.5H7z"></path>',
    volume: '<path d="M11 5.5 6.5 9H4v6h2.5L11 18.5z"></path><path d="M15 9.3a4 4 0 0 1 0 5.4M17.8 6.8a8 8 0 0 1 0 10.4"></path>',
    share: '<path d="M13.5 5.5h5v5"></path><path d="M18.5 5.5 11 13"></path><path d="M19 14.5v3A2.5 2.5 0 0 1 16.5 20h-10A2.5 2.5 0 0 1 4 17.5v-10A2.5 2.5 0 0 1 6.5 5h3"></path>',
    importFile: '<path d="M12 4v10"></path><path d="m7.5 9.5 4.5 4.5 4.5-4.5"></path><path d="M4.5 19.5h15"></path>',
    paperclip: '<path stroke-width="2.2" d="M18 5.5v10.5a6 6 0 0 1-12 0V6.5a3.5 3.5 0 0 1 7 0v9.5a1.5 1.5 0 0 1-3 0V8.5"></path>',
    arrowUp: '<path d="M12 19V5"></path><path d="m6 11 6-6 6 6"></path>',
    sendArrow: '<path stroke-width="2.4" d="M12 19V5"></path><path stroke-width="2.4" d="m6 11 6-6 6 6"></path>',
    stop: '<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none"></rect>',
    close: '<path d="m6 6 12 12M18 6 6 18"></path>',
    info: '<circle cx="12" cy="12" r="8.5"></circle><path d="M12 11v5.5"></path><circle cx="12" cy="8.1" r=".9" fill="currentColor" stroke="none"></circle>',
    brain: '<path d="M9.5 4.5A3 3 0 0 0 6.6 7a2.8 2.8 0 0 0-1.9 4.8A3 3 0 0 0 6 17a3 3 0 0 0 3.5 2.5V4.5z"></path><path d="M14.5 4.5A3 3 0 0 1 17.4 7a2.8 2.8 0 0 1 1.9 4.8A3 3 0 0 1 18 17a3 3 0 0 1-3.5 2.5V4.5z"></path><path d="M12 4v16"></path>',
    run: '<path d="M4 16c3.5-5.5 7-6 10-2.5 2 2.3 4.3 2.3 6-.5"></path><path d="M4 10c2.5-3 5-3.5 7-1.5"></path>',
    chevronDown: '<path d="m6 9 6 6 6-6"></path>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"></path>',
    trash: '<path d="M4.5 7h15"></path><path d="M9.5 4.5h5L15 7H9z"></path><path d="M6.5 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4l.8-12"></path>',
    listSelect: '<circle cx="7" cy="7.5" r="2.6"></circle><circle cx="7" cy="16.5" r="2.6"></circle><path d="M12.5 7.5H20M12.5 16.5H20"></path>',
    pin: '<path d="M12 17v5"></path><path d="M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.8a2 2 0 0 0-1.1-1.7l-1.8-.9A2 2 0 0 1 15 10.8V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"></path>',
    edit: '<path d="M13.5 6.5 17.5 10.5"></path><path d="m5 19 3.8-.8L19 8a2.1 2.1 0 0 0-3-3L5.8 15.2z"></path>',
    work: '<rect x="3.5" y="7.5" width="17" height="12" rx="2.5"></rect><path d="M9 7.5V6a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 6v1.5"></path>',
    eye: '<path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12Z"></path><circle cx="12" cy="12" r="3"></circle>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"></rect><path d="M5.5 11a6.5 6.5 0 0 0 13 0"></path><path d="M12 17.5V21"></path>',
  };

  function icon(name, size) {
    const s = size || 18;
    const nativeIcon = native[name];
    if (nativeIcon) {
      return `<svg class="dsc-icon" width="${s}" height="${s}" viewBox="${nativeIcon.viewBox}" fill="none" stroke="currentColor" stroke-width="${nativeIcon.strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${nativeIcon.body}</svg>`;
    }
    const body = paths[name] || '';
    return `<svg class="dsc-icon" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
  }

  window.DSCIcons = { icon, version: '16' };
})();
