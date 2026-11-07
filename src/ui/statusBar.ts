import * as vscode from 'vscode';
import type { SpecRecord } from '../core/repository';
import { nextAction } from '../core/spec';

export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100,
    );
    this.item.name = 'cc-sdd';
    this.item.command = 'ccSdd.pickSpec';
  }

  update(record: SpecRecord | undefined): void {
    if (!record) {
      this.item.hide();
      return;
    }

    const feature = record.spec?.feature_name?.trim() || record.id;
    const action = record.spec
      ? nextAction(record.spec)
      : { label: 'spec.json missing' };

    this.item.text = `$(beaker) ${feature} · ${action.label}`;
    this.item.tooltip = [
      `Feature: ${feature}`,
      `Path: ${record.dir}`,
      `Phase: ${record.spec?.phase ?? 'unknown'}`,
      `Next: ${action.label}`,
    ].join('\n');
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
