// Shared surface, type and control tokens for cc-sdd webviews.
// The Overview board builds its HTML from this string so the window keeps one
// palette, one type scale and one status lamp. The Runs console keeps its own
// styles.
export const webviewThemeCss = `
:root {
  color-scheme: light dark;
  --cc-accent: var(--vscode-textLink-foreground, #3794ff);
  --cc-accent-strong: var(--vscode-textLink-activeForeground, var(--cc-accent));
  --cc-success: var(--vscode-testing-iconPassed, #3fb950);
  --cc-error: var(--vscode-errorForeground, #f85149);
  --cc-warn: var(--vscode-editorWarning-foreground, #d29922);
  --cc-fg: var(--vscode-foreground, #c9d1d9);
  --cc-muted: var(--vscode-descriptionForeground, #8b949e);
  --cc-accent-ink: color-mix(in srgb, var(--cc-accent) 78%, var(--cc-fg));
  --cc-success-ink: color-mix(in srgb, var(--cc-success) 72%, var(--cc-fg));
  --cc-warn-ink: color-mix(in srgb, var(--cc-warn) 72%, var(--cc-fg));
  --cc-error-ink: color-mix(in srgb, var(--cc-error) 78%, var(--cc-fg));
  --cc-dim: color-mix(in srgb, var(--cc-muted) 90%, var(--cc-fg));
  --cc-bg: var(--vscode-panel-background, var(--vscode-editor-background, #1f1f1f));
  --cc-card: var(--vscode-editor-background, #1f1f1f);
  --cc-surface: color-mix(in srgb, var(--cc-fg) 4%, transparent);
  --cc-surface-strong: color-mix(in srgb, var(--cc-fg) 7%, transparent);
  --cc-surface-hover: color-mix(in srgb, var(--cc-fg) 9%, transparent);
  --cc-border: color-mix(in srgb, var(--cc-fg) 12%, transparent);
  --cc-border-strong: color-mix(in srgb, var(--cc-fg) 18%, transparent);
  --cc-mono: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Menlo, monospace);
  --cc-radius-sm: 6px;
  --cc-radius: 10px;
  --cc-radius-lg: 12px;
  --cc-ease: cubic-bezier(.2, 0, 0, 1);
}
* { box-sizing: border-box; }
html, body { min-height: 100%; }
body {
  margin: 0;
  padding: 20px;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size, 13px);
  line-height: 1.5;
  color: var(--cc-fg);
  background: var(--cc-bg);
}
button {
  font-family: var(--vscode-font-family);
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  color: var(--vscode-button-foreground, #ffffff);
  background: var(--vscode-button-background, #0e639c);
  border: 1px solid transparent;
  border-radius: var(--cc-radius-sm);
  padding: 0 12px;
  min-height: 28px;
  cursor: pointer;
  transition: background-color .12s var(--cc-ease), border-color .12s var(--cc-ease), color .12s var(--cc-ease);
}
button:hover {
  background: var(--vscode-button-hoverBackground, color-mix(in srgb, var(--vscode-button-background, #0e639c) 88%, #ffffff));
}
button:active {
  background: var(--vscode-button-hoverBackground, color-mix(in srgb, var(--vscode-button-background, #0e639c) 82%, #000000));
}
button:focus-visible, select:focus-visible, input:focus-visible, summary:focus-visible {
  outline: 2px solid var(--cc-accent);
  outline-offset: 1px;
}
button.secondary {
  color: var(--cc-fg);
  background: transparent;
  border-color: var(--cc-border);
}
button.secondary:hover { background: var(--cc-surface-strong); border-color: var(--cc-border-strong); }
button.icon-button {
  width: 28px;
  min-width: 28px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--cc-muted);
  background: transparent;
  border-color: transparent;
}
button.icon-button:hover { color: var(--cc-fg); background: var(--cc-surface-strong); }
button.text-button {
  min-height: 0;
  padding: 2px 4px;
  color: var(--cc-muted);
  background: transparent;
  border-color: transparent;
  font-weight: 400;
}
button.text-button:hover {
  color: var(--cc-fg);
  background: transparent;
  text-decoration: underline;
  text-underline-offset: 2px;
}
button.with-icon { display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
button.with-icon svg, button.icon-button svg { width: 14px; height: 14px; flex: none; }
select, input {
  font-family: var(--vscode-font-family);
  font-size: 12px;
  min-height: 28px;
  color: var(--vscode-dropdown-foreground, var(--cc-fg));
  background: var(--vscode-dropdown-background, var(--cc-surface-strong));
  border: 1px solid var(--cc-border);
  border-radius: var(--cc-radius-sm);
  padding: 0 8px;
}
input {
  color: var(--vscode-input-foreground, var(--cc-fg));
  background: var(--vscode-input-background, var(--cc-surface-strong));
}
input::placeholder { color: var(--cc-dim); }
.lamp {
  width: 6px;
  height: 6px;
  border-radius: 1px;
  flex: none;
  background: var(--cc-muted);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, #ffffff 16%, transparent);
}
.lamp.attention, .lamp.preview { background: var(--cc-accent); }
.lamp.running { background: var(--cc-warn); animation: lamp-breathe 2.4s ease-in-out infinite; }
.lamp.done { background: var(--cc-success); }
.lamp.failed, .lamp.error { background: var(--cc-error); }
.lamp.cancelled, .lamp.off { background: var(--cc-muted); }
@keyframes lamp-breathe {
  0%, 100% { opacity: 1; }
  50% { opacity: .45; }
}
@media (prefers-reduced-motion: reduce) {
  .lamp.running { animation: none; }
  * { transition-duration: 0s !important; }
}
.mono { font-family: var(--cc-mono); }
.muted { color: var(--cc-muted); }
.empty-state {
  padding: 24px;
  background: var(--cc-surface);
  border: 1px solid var(--cc-border);
  border-radius: var(--cc-radius-lg);
}
.empty-title { margin: 0; font-size: 14px; font-weight: 600; }
.empty-body { margin: 4px 0 16px; max-width: 56ch; font-size: 12px; color: var(--cc-muted); }
.empty-actions { display: flex; gap: 8px; flex-wrap: wrap; }
`;
