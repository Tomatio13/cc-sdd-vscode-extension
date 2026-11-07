import { describe, expect, it } from 'vitest';
import { parseRoadmap } from '../src/core/repository';

const SAMPLE = `# Roadmap

## Overview
Build a small app.

## Approach Decision
- **Chosen**: decompose into specs

## Scope
- **In**: the app
- **Out**: nothing

## Constraints
Standard library only.

## Boundary Strategy
- **Why this split**: independence

## Specs (dependency order)
- [ ] feature-a -- Foundation for the app. Dependencies: none
- [ ] feature-b -- Editor UI. Dependencies: feature-a
- [ ] feature-c -- Export. Dependencies: feature-a, feature-b
- [x] feature-done -- Already finished earlier. Dependencies: none

## Existing Spec Updates
- [ ] existing-a -- Extension work. Dependencies: none

## Direct Implementation Candidates
- [ ] small-item-a -- too small for a spec
`;

describe('parseRoadmap', () => {
  it('parses the dependency-order section only', () => {
    const parsed = parseRoadmap(SAMPLE);

    expect(parsed.order).toEqual(['feature-a', 'feature-b', 'feature-c', 'feature-done']);
    expect(parsed.deps['feature-a']).toEqual([]);
    expect(parsed.deps['feature-b']).toEqual(['feature-a']);
    expect(parsed.deps['feature-c']).toEqual(['feature-a', 'feature-b']);
    expect(parsed.deps['feature-done']).toEqual([]);
  });

  it('ignores items in other sections', () => {
    const parsed = parseRoadmap(SAMPLE);
    expect(parsed.order).not.toContain('existing-a');
    expect(parsed.order).not.toContain('small-item-a');
  });

  it('returns empty when the section is missing', () => {
    expect(parseRoadmap('# Some other document\n\nNo specs here.\n')).toEqual({
      order: [],
      deps: {},
    });
  });

  it('tolerates dependency text variants', () => {
    const parsed = parseRoadmap(
      `## Specs (dependency order)
- [ ] solo -- standalone. Dependencies: none
- [ ] pair -- needs a friend. Dependencies: solo
- [ ] trio -- needs both. Dependencies: solo, pair
`,
    );

    expect(parsed.order).toEqual(['solo', 'pair', 'trio']);
    expect(parsed.deps.trio).toEqual(['solo', 'pair']);
  });
});
