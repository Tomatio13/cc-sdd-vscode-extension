import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PHASE_META } from './phases';
import {
  PHASES,
  parseSpecJson,
  serializeSpecJson,
  withApproval,
  type PhaseKey,
  type SpecJson,
} from './spec';
import { toggleTaskInMarkdown } from './tasks';

export interface SpecRecord {
  id: string;
  dir: string;
  specJsonPath: string;
  artifacts: Record<PhaseKey, string>;
  exists: Record<PhaseKey, boolean>;
  /** Artifact mtimes by phase, used for "last updated" in the Overview. */
  artifactUpdatedAtMs?: Record<PhaseKey, number | undefined>;
  spec: SpecJson | null;
  specError?: string;
  /** spec.json filesystem timestamps, used when metadata has no dates. */
  createdAtMs?: number;
  updatedAtMs?: number;
}

const isNotFound = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as NodeJS.ErrnoException).code === 'ENOENT';

const isFile = async (filePath: string): Promise<boolean> => {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch (error) {
    if (isNotFound(error)) {
      return false;
    }
    throw error;
  }
};

const assertSafeSpecId = (id: string): void => {
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id === '.' || id === '..') {
    throw new Error(`Invalid spec id: ${id}`);
  }
};

const writeAtomically = async (filePath: string, content: string): Promise<void> => {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );

  await fs.writeFile(temporaryPath, content, 'utf8');
  try {
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
};

export const resolveKiroDir = (workspaceRoot: string, configured: string): string => {
  const value = configured.trim() || '.kiro';
  return path.isAbsolute(value) ? value : path.join(workspaceRoot, value);
};

export const specsDir = (workspaceRoot: string, kiroDir: string): string =>
  path.join(resolveKiroDir(workspaceRoot, kiroDir), 'specs');

const readRecord = async (specsRoot: string, id: string): Promise<SpecRecord> => {
  const dir = path.join(specsRoot, id);
  const specJsonPath = path.join(dir, 'spec.json');
  const artifacts = {} as Record<PhaseKey, string>;
  const exists = {} as Record<PhaseKey, boolean>;
  const artifactUpdatedAtMs = {} as Record<PhaseKey, number | undefined>;

  for (const phase of PHASES) {
    const artifactPath = path.join(dir, PHASE_META[phase].file);
    artifacts[phase] = artifactPath;
    const artifactStat = await fs.stat(artifactPath).catch((error: unknown) => {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    });
    const isArtifactFile = artifactStat?.isFile() === true;
    exists[phase] = isArtifactFile;
    artifactUpdatedAtMs[phase] = isArtifactFile ? artifactStat.mtimeMs : undefined;
  }

  let spec: SpecJson | null = null;
  let specError: string | undefined;

  try {
    const text = await fs.readFile(specJsonPath, 'utf8');
    const parsed = parseSpecJson(text);
    if (parsed.ok) {
      spec = parsed.spec;
    } else {
      specError = parsed.error;
    }
  } catch (error) {
    if (!isNotFound(error)) {
      specError = error instanceof Error ? error.message : String(error);
    }
  }

  const specStat = await fs.stat(specJsonPath).catch((error: unknown) => {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  });

  return {
    id,
    dir,
    specJsonPath,
    artifacts,
    exists,
    artifactUpdatedAtMs,
    spec,
    specError,
    createdAtMs: specStat
      ? specStat.birthtimeMs || specStat.ctimeMs || specStat.mtimeMs
      : undefined,
    updatedAtMs: specStat?.mtimeMs,
  };
};

export const listSpecs = async (
  workspaceRoot: string,
  kiroDir: string,
): Promise<SpecRecord[]> => {
  const root = specsDir(workspaceRoot, kiroDir);

  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) {
      return [];
    }
    throw error;
  }

  const records = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => readRecord(root, entry.name)),
  );

  return records.sort((left, right) => left.id.localeCompare(right.id));
};

const parseTimestamp = (value: string | undefined): number | undefined => {
  if (!value) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** Creation time used for newest-first ordering in both the tree and overview. */
export const specCreatedAt = (record: SpecRecord): number =>
  parseTimestamp(record.spec?.created_at) ??
  parseTimestamp(record.spec?.updated_at) ??
  record.createdAtMs ??
  record.updatedAtMs ??
  0;

/** Latest update time from spec.json and its artifacts. */
export const specUpdatedAt = (record: SpecRecord): number | undefined => {
  const artifactUpdatedAt = record.artifactUpdatedAtMs
    ? Math.max(0, ...PHASES.map((phase) => record.artifactUpdatedAtMs?.[phase] ?? 0))
    : 0;
  const candidates = [
    parseTimestamp(record.spec?.updated_at),
    record.updatedAtMs,
    artifactUpdatedAt,
    parseTimestamp(record.spec?.created_at),
    record.createdAtMs,
  ].filter((value): value is number => typeof value === 'number' && value > 0);
  return candidates.length > 0 ? Math.max(...candidates) : undefined;
};

export const readArtifact = async (
  record: SpecRecord,
  phase: PhaseKey,
): Promise<string | undefined> => {
  try {
    return await fs.readFile(record.artifacts[phase], 'utf8');
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }
};

export const updateApproval = async (
  workspaceRoot: string,
  kiroDir: string,
  id: string,
  phase: PhaseKey,
  approved: boolean,
): Promise<SpecJson> => {
  assertSafeSpecId(id);
  const specJsonPath = path.join(specsDir(workspaceRoot, kiroDir), id, 'spec.json');

  let text: string;
  try {
    text = await fs.readFile(specJsonPath, 'utf8');
  } catch (error) {
    if (isNotFound(error)) {
      throw new Error(`spec.json not found for "${id}".`);
    }
    throw error;
  }

  const parsed = parseSpecJson(text);
  if (!parsed.ok) {
    throw new Error(`Cannot update ${id}/spec.json: ${parsed.error}`);
  }

  const updated = withApproval(parsed.spec, phase, approved);
  await writeAtomically(specJsonPath, serializeSpecJson(updated));
  return updated;
};

export const toggleTaskCheckbox = async (
  record: SpecRecord,
  line: number,
): Promise<string> => {
  const content = await readArtifact(record, 'tasks');
  if (content === undefined) {
    throw new Error(`tasks.md not found for "${record.id}".`);
  }

  const updated = toggleTaskInMarkdown(content, line);
  await writeAtomically(record.artifacts.tasks, updated);
  return updated;
};

export interface SteeringStatus {
  generated: boolean;
  missing: string[];
  files: { name: string; path: string; exists: boolean }[];
}

export const readSteering = async (
  workspaceRoot: string,
  kiroDir: string,
): Promise<SteeringStatus> => {
  const steeringRoot = path.join(resolveKiroDir(workspaceRoot, kiroDir), 'steering');
  const names = ['product.md', 'tech.md', 'structure.md'];

  const files = [];
  for (const name of names) {
    const filePath = path.join(steeringRoot, name);
    files.push({ name, path: filePath, exists: await isFile(filePath) });
  }

  return {
    generated: files.every((file) => file.exists),
    missing: files.filter((file) => !file.exists).map((file) => file.name),
    files,
  };
};

export interface RoadmapInfo {
  path: string;
  /** Feature names in roadmap order, excluding completed ones ([x]? still listed). */
  order: string[];
  deps: Record<string, string[]>;
}

const ROADMAP_SECTION_RE = /^##\s+Specs \(dependency order\)\s*$/im;
const ROADMAP_ITEM_RE =
  /^[-*]\s+\[([ xX])\]\s+([A-Za-z0-9._-]+)\s*--\s*(.*?)(?:[.\s]*)Dependencies:\s*(.*)$/im;

/**
 * Parse the "## Specs (dependency order)" section of roadmap.md.
 * Format: `- [ ] feature-name -- one-line description. Dependencies: none | a, b`
 */
export const parseRoadmap = (
  content: string,
): { order: string[]; deps: Record<string, string[]> } => {
  const sectionMatch = ROADMAP_SECTION_RE.exec(content);
  if (!sectionMatch) {
    return { order: [], deps: {} };
  }

  const bodyStart = sectionMatch.index + sectionMatch[0].length;
  const nextSection = /^##\s+/im;
  const nextMatch = nextSection.exec(content.slice(bodyStart));
  const body = nextMatch
    ? content.slice(bodyStart, bodyStart + nextMatch.index)
    : content.slice(bodyStart);

  const order: string[] = [];
  const deps: Record<string, string[]> = {};

  for (const line of body.split(/\r?\n/)) {
    const lineMatch = ROADMAP_ITEM_RE.exec(line);
    if (!lineMatch) {
      continue;
    }

    const name = lineMatch[2];
    const depText = lineMatch[4].trim();
    const depends =
      /^(none|n\/a|-|—)?$/i.test(depText)
        ? []
        : depText.split(/[,;]\s*/).map((item) => item.trim()).filter(Boolean);

    if (!order.includes(name)) {
      order.push(name);
      deps[name] = depends;
    }
  }

  return { order, deps };
};

export const readRoadmap = async (
  workspaceRoot: string,
  kiroDir: string,
): Promise<RoadmapInfo | undefined> => {
  const roadmapPath = path.join(resolveKiroDir(workspaceRoot, kiroDir), 'steering', 'roadmap.md');
  const content = await isFile(roadmapPath)
    ? await fs.readFile(roadmapPath, 'utf8')
    : undefined;
  if (content === undefined) {
    return undefined;
  }

  const parsed = parseRoadmap(content);
  return { path: roadmapPath, ...parsed };
};
