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
