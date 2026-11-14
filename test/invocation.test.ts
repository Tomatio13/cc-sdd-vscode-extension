import { describe, expect, it } from 'vitest';
import { buildInvocation, type AgentConfig } from '../src/core/invocation';

const config = (agent: AgentConfig['agent'], customCommand = ''): AgentConfig => ({
  agent,
  customCommand,
});

describe('buildInvocation', () => {
  it('builds a Claude Code slash invocation', () => {
    const invocation = buildInvocation(config('claude'), 'kiro-spec-design', 'photo-albums');
    expect(invocation.prompt).toBe('/kiro-spec-design photo-albums');
    expect(invocation.command).toBe('claude "/kiro-spec-design photo-albums"');
  });

  it('builds a Codex dollar invocation', () => {
    const invocation = buildInvocation(config('codex'), 'kiro-spec-tasks', 'photo-albums');
    expect(invocation.prompt).toBe('$kiro-spec-tasks photo-albums');
    expect(invocation.command).toBe('codex "\\$kiro-spec-tasks photo-albums"');
  });

  it('builds an OpenCode run invocation', () => {
    const invocation = buildInvocation(config('opencode'), 'kiro-impl', 'photo-albums');
    expect(invocation.command).toBe('opencode run "/kiro-impl photo-albums"');
  });

  it('returns only the prompt for the Claude Code VS Code panel', () => {
    const invocation = buildInvocation(config('claude-vscode'), 'kiro-impl', 'alpha');
    expect(invocation.prompt).toBe('/kiro-impl alpha');
    expect(invocation.command).toBeUndefined();
  });

  it('returns only the prompt for the headless Runs console', () => {
    const invocation = buildInvocation(config('claude-console'), 'kiro-impl', 'alpha');
    expect(invocation.prompt).toBe('/kiro-impl alpha');
    expect(invocation.command).toBeUndefined();
  });

  it('only returns the prompt for Copilot and clipboard', () => {
    expect(buildInvocation(config('copilot'), 'kiro-impl', 'alpha').command).toBeUndefined();
    expect(buildInvocation(config('clipboard'), 'kiro-impl', 'alpha').command).toBeUndefined();
  });

  it('appends task args after the feature', () => {
    const invocation = buildInvocation(config('claude'), 'kiro-impl', 'alpha', '1.1 1.2');
    expect(invocation.prompt).toBe('/kiro-impl alpha 1.1 1.2');
    expect(invocation.command).toBe('claude "/kiro-impl alpha 1.1 1.2"');
  });

  it('expands a custom command template', () => {
    const invocation = buildInvocation(
      config('custom', 'agent --skill "${skill}" --feature "${feature}" -- "${prompt}"'),
      'kiro-impl',
      'alpha',
    );
    expect(invocation.command).toBe(
      'agent --skill "kiro-impl" --feature "alpha" -- "/kiro-impl alpha"',
    );
  });

  it('falls back to the prompt when the custom template is empty', () => {
    const invocation = buildInvocation(config('custom', '  '), 'kiro-impl', 'alpha');
    expect(invocation.prompt).toBe('/kiro-impl alpha');
    expect(invocation.command).toBeUndefined();
  });

  it('escapes shell-sensitive characters', () => {
    const invocation = buildInvocation(config('claude'), 'kiro-impl', 'a"b$c');
    expect(invocation.command).toBe('claude "/kiro-impl a\\"b\\$c"');
  });
});

describe('verification report contract', () => {
  it.each([
    'claude',
    'claude-vscode',
    'claude-console',
    'codex',
    'copilot',
    'opencode',
    'clipboard',
  ] as const)('includes report persistence instructions for %s', (agent) => {
    const invocation = buildInvocation(config(agent), 'kiro-validate-impl', 'add-readme');
    expect(invocation.prompt).toContain('.kiro/specs/add-readme/impl-validation.md');
    expect(invocation.prompt).toContain('DECISION: GO');
    expect(invocation.prompt).toContain('DECISION: NO-GO');
    expect(invocation.prompt).toContain('DECISION: MANUAL_VERIFY_REQUIRED');
    expect(invocation.prompt).toContain('report last');
    expect(invocation.prompt).toContain('do not claim completion');
  });
  it('honors a custom spec directory and quotes the full terminal prompt', () => {
    const invocation = buildInvocation(
      config('claude'),
      'kiro-validate-impl',
      'demo',
      '',
      '/work/specs elsewhere/demo/impl-validation.md',
    );
    expect(invocation.prompt).toContain('"/work/specs elsewhere/demo/impl-validation.md"');
    expect(invocation.command).toContain('\\"/work/specs elsewhere/demo/impl-validation.md\\"');
  });
});
