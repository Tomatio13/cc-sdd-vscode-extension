import * as vscode from 'vscode';
import { mapWebviewHtml, postMapState, type MapSource } from './mapView';

/**
 * The work map as an editor tab, like the Overview portfolio. This is the
 * default way to open the map; the sidebar view is opt-in.
 */
export class MapPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private timer?: NodeJS.Timeout;
  private readonly subscription: { dispose: () => void };

  constructor(private readonly source: MapSource) {
    this.subscription = source.tracker.onDidChange(() => this.schedule());
  }

  show(): void {
    if (this.panel) {
      if (!this.panel.visible) {
        this.panel.reveal(undefined, true);
      }
      this.push();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'ccSdd.map',
      'cc-sdd Work map',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.source.extensionUri, 'out')],
      },
    );
    panel.webview.html = mapWebviewHtml(
      panel.webview,
      this.source.extensionUri,
      this.source.getLanguage(),
    );
    panel.webview.onDidReceiveMessage((message: unknown) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        (message as { type?: unknown }).type === 'ready'
      ) {
        this.push();
      }
    });
    panel.onDidChangeViewState((event) => {
      if (event.webviewPanel.visible) {
        this.push();
      }
    });
    panel.onDidDispose(() => {
      this.panel = undefined;
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = undefined;
      }
    });
    this.panel = panel;
    this.push();
  }

  /** Redraw even without a tracker change, such as a theme or accent switch. */
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
    if (!this.panel?.visible) {
      return;
    }
    postMapState(this.panel.webview, this.source);
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.subscription.dispose();
    this.panel?.dispose();
    this.panel = undefined;
  }
}
