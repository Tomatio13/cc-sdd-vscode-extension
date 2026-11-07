import { describe, expect, it } from 'vitest';
import {
  allApproved,
  nextAction,
  parseSpecJson,
  phaseStatus,
  withApproval,
  type SpecJson,
} from '../src/core/spec';
import { validateArtifact } from '../src/core/validation';

const SPEC_TEXT = `{
  "feature_name": "alpha",
  "phase": "requirements-generated",
  "approvals": {
    "requirements": { "generated": true, "approved": false }
  },
  "ready_for_implementation": false,
  "custom_field": "keep-me"
}`;

const validSpec = (): SpecJson => ({
  feature_name: 'alpha',
  phase: 'tasks-generated',
  approvals: {
    requirements: { generated: true, approved: true },
    design: { generated: true, approved: true },
    tasks: { generated: true, approved: true },
  },
  ready_for_implementation: true,
});

describe('parseSpecJson', () => {
  it('normalizes missing approvals and preserves unknown fields', () => {
    const result = parseSpecJson(SPEC_TEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.spec.feature_name).toBe('alpha');
    expect(result.spec.approvals.requirements).toEqual({ generated: true, approved: false });
    expect(result.spec.approvals.design).toEqual({ generated: false, approved: false });
    expect(result.spec.custom_field).toBe('keep-me');
  });

  it('reports invalid JSON', () => {
    const result = parseSpecJson('{');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Invalid JSON/);
    }
  });

  it('rejects non-object JSON', () => {
    const result = parseSpecJson('[]');
    expect(result.ok).toBe(false);
  });
});

describe('withApproval', () => {
  it('records an approval, updates the timestamp, and recomputes readiness', () => {
    const result = parseSpecJson(SPEC_TEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const updated = withApproval(
      result.spec,
      'requirements',
      true,
      new Date('2026-01-02T03:04:05.000Z'),
    );

    expect(updated.approvals.requirements).toEqual({ generated: true, approved: true });
    expect(updated.updated_at).toBe('2026-01-02T03:04:05.000Z');
    expect(updated.ready_for_implementation).toBe(false);
    expect(updated.custom_field).toBe('keep-me');
  });

  it('marks the spec ready when every phase is approved', () => {
    const updated = withApproval(validSpec(), 'tasks', true);
    expect(allApproved(updated)).toBe(true);
    expect(updated.ready_for_implementation).toBe(true);
  });

  it('clears readiness when an approval is revoked', () => {
    const updated = withApproval(validSpec(), 'design', false);
    expect(updated.ready_for_implementation).toBe(false);
  });
});

describe('nextAction', () => {
  it('asks to generate a phase that is not generated yet', () => {
    const result = parseSpecJson(SPEC_TEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(nextAction(result.spec)).toMatchObject({
      kind: 'review',
      phase: 'requirements',
    });
  });

  it('asks to review a generated but unapproved phase', () => {
    const spec: SpecJson = {
      ...validSpec(),
      approvals: {
        ...validSpec().approvals,
        design: { generated: true, approved: false },
        tasks: { generated: false, approved: false },
      },
      ready_for_implementation: false,
    };

    expect(nextAction(spec)).toMatchObject({ kind: 'review', phase: 'design' });
  });

  it('reports implementation when every phase is approved', () => {
    expect(nextAction(validSpec())).toMatchObject({ kind: 'implement' });
  });
});

describe('phaseStatus', () => {
  it('distinguishes missing, draft, generated, and approved', () => {
    const spec = validSpec();
    expect(phaseStatus(spec, 'requirements', false)).toBe('missing');
    expect(
      phaseStatus(
        { ...spec, approvals: { ...spec.approvals, requirements: { generated: false, approved: false } } },
        'requirements',
        true,
      ),
    ).toBe('draft');
    expect(
      phaseStatus(
        { ...spec, approvals: { ...spec.approvals, requirements: { generated: true, approved: false } } },
        'requirements',
        true,
      ),
    ).toBe('generated');
    expect(phaseStatus(spec, 'requirements', true)).toBe('approved');
  });
});

const REQUIREMENTS = `# Requirements Document

## Introduction
Users need a login flow.

## Requirements

### Requirement 1: Login
**Objective:** As a user, I want to log in.

#### Acceptance Criteria
1. When a user submits valid credentials, the system shall create a session.
2. If the password is invalid, then the system shall reject the request.
`;

const DESIGN = `# Technical Design Document

## Overview
A small login service.

## Boundary Commitments

### This Spec Owns
- Session creation.

## Architecture
The service uses a session store.

## File Structure Plan

### Directory Structure
src/auth/session.ts

## Requirements Traceability
| Requirement | Component |
| --- | --- |
| 1 | SessionService |
`;

const TASKS = `# Implementation Plan

## Task List

- [ ] 1. Build the login flow
  - _Requirements: 1_
- [ ] 1.1 (P) Add the session store
  - _Boundary: auth_
  - _Requirements: 1_
`;

describe('validateArtifact', () => {
  it('rejects a missing artifact', () => {
    const result = validateArtifact('requirements', undefined);
    expect(result.errors[0]).toMatch(/does not exist/);
  });

  it('rejects template placeholders', () => {
    const result = validateArtifact(
      'requirements',
      REQUIREMENTS.replace('Users need a login flow.', '{{INTRODUCTION}}'),
    );
    expect(result.errors.join('\n')).toMatch(/placeholders/);
  });

  it('accepts a complete requirements document', () => {
    const result = validateArtifact('requirements', REQUIREMENTS);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('rejects requirements without numbered headings', () => {
    const result = validateArtifact('requirements', '# Requirements\n\n## Introduction\nText.');
    expect(result.errors.join('\n')).toMatch(/numbered requirement headings/);
  });

  it('accepts a complete design document', () => {
    const result = validateArtifact('design', DESIGN);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('warns when design lacks v3 boundary sections', () => {
    const result = validateArtifact(
      'design',
      '# Design\n\n## Overview\nText.\n\n## Architecture\nText.',
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings.join('\n')).toMatch(/File Structure Plan/);
    expect(result.warnings.join('\n')).toMatch(/Boundary Commitments/);
  });

  it('accepts a complete tasks document', () => {
    const result = validateArtifact('tasks', TASKS);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('accepts localized requirements using structural checks', () => {
    const japanese = `# Requirements Document

## 導入
ユーザーはログインできる必要がある。

## 要件

### 要件1: ログイン
#### 受け入れ基準
1. ユーザーが有効な資格情報を送信したとき、システムはセッションを作成すること。
`;
    const result = validateArtifact('requirements', japanese, 'ja');
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('accepts localized design documents using structural checks', () => {
    const japanese = `# Technical Design Document

## 概要
小さなログインサービス。

## アーキテクチャ
セッションストアを使う。

## コンポーネント
SessionService。

## データモデル
セッション。
`;
    const result = validateArtifact('design', japanese, 'ja');
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('warns about parallel tasks without boundaries', () => {
    const result = validateArtifact(
      'tasks',
      '# Implementation Plan\n\n- [ ] 1.1 (P) Parallel task\n  - _Requirements: 1_\n',
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings.join('\n')).toMatch(/without _Boundary:/);
  });

  it('only requires traceability metadata on leaf tasks', () => {
    const result = validateArtifact(
      'tasks',
      `# Implementation Plan

- [ ] 1. Major task
- [ ] 1.1 Leaf task
  - _Requirements: 1_
`,
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('warns when a leaf task has no traceability metadata', () => {
    const result = validateArtifact(
      'tasks',
      '# Implementation Plan\n\n- [ ] 1. Leaf task without metadata\n',
    );
    expect(result.warnings.join('\n')).toMatch(/leaf task\(s\) without _Requirements:/);
  });

  it('rejects tasks without checkbox tasks', () => {
    const result = validateArtifact('tasks', '# Implementation Plan\n\nNo tasks here.\n');
    expect(result.errors.join('\n')).toMatch(/no checkbox tasks/);
  });
});
