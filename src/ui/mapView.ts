import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { MapTracker } from '../map/tracker';

export interface MapSource {
  extensionUri: vscode.Uri;
  tracker: MapTracker;
  getTheme: () => 'dark' | 'light';
  getLanguage: () => string;
  getAccent: () => string;
}

/** The same assets serve the sidebar view and the editor panel. */
export const mapWebviewHtml = (
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  language: string,
): string => {
  const root = vscode.Uri.joinPath(extensionUri, 'out');
  const nonce = randomBytes(16).toString('hex');
  const asset = (name: string): string =>
    webview.asWebviewUri(vscode.Uri.joinPath(root, name)).toString();
  return `<!DOCTYPE html><html lang="${language}"><head>
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
    <link rel="stylesheet" href="${asset('map.css')}">
    <title>cc-sdd Work map</title></head>
    <body><div id="root" aria-live="polite"></div>
    <script nonce="${nonce}" src="${asset('map.js')}"></script></body></html>`;
};

export const postMapState = (webview: vscode.Webview, source: MapSource): void => {
  void webview.postMessage({
    type: 'state',
    board: source.tracker.snapshot(),
    theme: source.getTheme(),
    language: source.getLanguage(),
    accent: source.getAccent(),
  });
};

/** The optional sidebar form of the map. The editor panel is the default. */
export class MapView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private timer?: NodeJS.Timeout;
  private readonly subscription: { dispose: () => void };

  constructor(private readonly source: MapSource) {
    this.subscription = source.tracker.onDidChange(() => this.schedule());
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.source.extensionUri, 'out')],
    };
    view.webview.html = mapWebviewHtml(
      view.webview,
      this.source.extensionUri,
      this.source.getLanguage(),
    );
    view.webview.onDidReceiveMessage((message: unknown) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        (message as { type?: unknown }).type === 'ready'
      ) {
        this.push();
      }
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.push();
      }
    });
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
      }
    });
  }

  /** Redraw even without a tracker change, such as a theme switch. */
  refresh(): void {
    this.push();
  }

  private schedule(): void {
    if (this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.push();
    }, 60);
  }

  private push(): void {
    const view = this.view;
    if (!view?.visible) {
      return;
    }
    postMapState(view.webview, this.source);
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.subscription.dispose();
    this.view = undefined;
  }
}
