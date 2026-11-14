/* global acquireVsCodeApi */
(() => {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('timeline');
  const state = vscode.getState() || {};
  const expanded = state.expanded || {};
  let restoring = false;
  function save() {
    vscode.setState({ expanded, scroll: document.documentElement.scrollTop });
  }
  app.addEventListener(
    'toggle',
    (event) => {
      const details = event.target;
      if (restoring || !details.dataset.key || !details.isConnected) return;
      expanded[details.dataset.key] = details.open;
      save();
    },
    true,
  );
  document.addEventListener('scroll', save, { passive: true });
  app.addEventListener('click', (event) => {
    const spec = event.target.closest('.spec[data-select]');
    if (spec && spec.dataset.active !== 'true') {
      vscode.postMessage({ type: 'action', id: spec.dataset.select });
    }
    const button = event.target.closest('button[data-action]');
    if (button) vscode.postMessage({ type: 'action', id: button.dataset.action });
  });
  let initialized = false;
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'error') {
      let error = document.getElementById('error');
      if (!error) {
        error = document.createElement('p');
        error.id = 'error';
        error.setAttribute('role', 'status');
        app.prepend(error);
      }
      error.textContent = message.text;
      return;
    }
    if (message.type !== 'render') return;
    const scroll = initialized ? document.documentElement.scrollTop : state.scroll || 0;
    const focused = document.activeElement;
    const focusKey = focused?.dataset.focus;
    const sectionKey = focused?.closest('details[data-key]')?.dataset.key;
    const summaryKey =
      focused?.tagName === 'SUMMARY' ? focused.parentElement.dataset.key : undefined;
    // Capture live DOM state too: a refresh can arrive before the queued toggle event.
    if (initialized) {
      app.querySelectorAll('details[data-key]').forEach((details) => {
        expanded[details.dataset.key] = details.open;
      });
    }
    restoring = true;
    app.innerHTML = message.html;
    app.querySelectorAll('details[data-key]').forEach((details) => {
      if (Object.hasOwn(expanded, details.dataset.key))
        details.open = expanded[details.dataset.key];
    });
    if (focusKey || summaryKey) {
      const candidates = app.querySelectorAll('button[data-focus], summary');
      const target = [...candidates].find((element) =>
        summaryKey
          ? element.tagName === 'SUMMARY' && element.parentElement.dataset.key === summaryKey
          : element.dataset.focus === focusKey &&
            element.closest('details[data-key]')?.dataset.key === sectionKey,
      );
      target?.focus({ preventScroll: true });
    }
    document.documentElement.scrollTop = scroll;
    initialized = true;
    // Toggle events are queued by the browser after setting details.open.
    setTimeout(() => {
      restoring = false;
    }, 0);
  });
  vscode.postMessage({ type: 'ready' });
})();
