import * as vscode from 'vscode';
import type { RunState } from '../run/claudeRunner';

/** Small always-on signal for local runs; click opens the Runs console. */
export class RunsStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    this.item.name = 'cc-sdd Runs';
    this.item.command = 'ccSdd.runs';
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
    this.item.text = `$(console) ${parts.join(' · ')}`;
    this.item.tooltip = [
      `Running workers: ${running}`,
      `Waiting for you: ${waiting}`,
      'Click to open the cc-sdd Runs console.',
    ].join('\n');
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
