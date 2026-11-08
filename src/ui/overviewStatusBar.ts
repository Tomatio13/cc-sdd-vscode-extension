import * as vscode from 'vscode';
import type { RunState } from '../run/claudeRunner';

/** Small always-on signal for leaders: how many workers need attention. */
export class OverviewStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    this.item.name = 'cc-sdd Overview';
    this.item.command = 'ccSdd.overview';
  }

  update(runs: RunState[]): void {
    const running = runs.filter((run) => run.status === 'running').length;
    const waiting = runs.filter((run) => run.pending !== undefined).length;
    if (running === 0) {
      this.item.hide();
      return;
    }

    const parts = [];
    if (waiting > 0) {
      parts.push(`$(bell) ${waiting} waiting`);
    }
    parts.push(`${running} running`);
    this.item.text = `$(dashboard) ${parts.join(' · ')}`;
    this.item.tooltip = [
      `Running workers: ${running}`,
      `Waiting for you: ${waiting}`,
      'Click to open the cc-sdd Overview board.',
    ].join('\n');
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
