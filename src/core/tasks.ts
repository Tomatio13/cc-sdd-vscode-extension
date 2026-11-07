export interface ParsedTask {
  id: string;
  title: string;
  checked: boolean;
  parallel: boolean;
  /** 0-based line index in tasks.md */
  line: number;
  indent: number;
  boundary?: string;
  depends: string[];
  requirements: string[];
  parentId?: string;
  children: ParsedTask[];
}

const CHECKBOX_RE = /^(\s*)[-*]\s+\[([ xX])\]\*?\s+(.*)$/;
const TASK_ID_RE = /^(\d+(?:\.\d+)*)\.?\s+(.*)$/;
const META_RE = /^\s*[-*]\s+_?(Boundary|Depends|Requirements):?_?\s*(.*?)\s*$/i;
const HEADING_RE = /^\s*#{1,6}\s+/;

const cleanMetadataValue = (value: string): string => {
  let cleaned = value
    .trim()
    .replace(
      /\s+\((?:Only for|Omit when|IDs only|Include details|At least one|Do not add).*$/is,
      '',
    );
  cleaned = cleaned.replace(/_\s*$/, '').trim();
  return cleaned;
};

const splitList = (value: string): string[] =>
  value
    .split(/[,;]/)
    .map((item) => item.trim().replace(/^_+|_+$/g, ''))
    .filter((item) => item.length > 0 && !/^(?:none|n\/a|—|-)$/i.test(item));

/**
 * Parse the checkbox task list from tasks.md.
 * Metadata is read from the indented bullets that follow each task.
 */
export const parseTasks = (markdown: string): ParsedTask[] => {
  const eol = markdown.includes('\r\n') ? '\r\n' : '\n';
  const lines = markdown.split(eol);
  const tasks: ParsedTask[] = [];
  let current: ParsedTask | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const checkbox = CHECKBOX_RE.exec(line);

    if (checkbox) {
      const indent = checkbox[1].length;
      const checked = checkbox[2].toLowerCase() === 'x';
      const rest = checkbox[3].trim();

      const idMatch = TASK_ID_RE.exec(rest);
      const id = idMatch ? idMatch[1] : `line-${index + 1}`;
      let title = idMatch ? idMatch[2].trim() : rest;
      let parallel = false;

      if (/^\(P\)\s*/i.test(title)) {
        parallel = true;
        title = title.replace(/^\(P\)\s*/i, '').trim();
      } else if (/\s*\(P\)\s*$/i.test(title)) {
        parallel = true;
        title = title.replace(/\s*\(P\)\s*$/i, '').trim();
      }

      current = {
        id,
        title,
        checked,
        parallel,
        line: index,
        indent,
        depends: [],
        requirements: [],
        children: [],
      };
      tasks.push(current);
      continue;
    }

    if (HEADING_RE.test(line)) {
      current = undefined;
      continue;
    }

    if (!current) {
      continue;
    }

    const metadata = META_RE.exec(line);
    if (!metadata) {
      continue;
    }

    const key = metadata[1].toLowerCase();
    const value = cleanMetadataValue(metadata[2]);
    if (!value) {
      continue;
    }

    if (key === 'boundary') {
      current.boundary = value;
    } else if (key === 'depends') {
      current.depends.push(...splitList(value));
    } else {
      current.requirements.push(...splitList(value));
    }
  }

  return tasks;
};

/**
 * Build a parent/child tree from numeric task IDs (1 -> 1.1 -> 1.1.1).
 * IDs without a numeric prefix stay at the root.
 */
export const buildTaskTree = (tasks: ParsedTask[]): ParsedTask[] => {
  const byId = new Map<string, ParsedTask>();

  for (const task of tasks) {
    task.children = [];
    task.parentId = undefined;
    byId.set(task.id, task);
  }

  const roots: ParsedTask[] = [];

  for (const task of tasks) {
    const parts = task.id.split('.');
    let parent: ParsedTask | undefined;

    for (let length = parts.length - 1; length > 0; length -= 1) {
      parent = byId.get(parts.slice(0, length).join('.'));
      if (parent) {
        break;
      }
    }

    if (parent && parent !== task) {
      task.parentId = parent.id;
      parent.children.push(task);
    } else {
      roots.push(task);
    }
  }

  return roots;
};

export const flattenTasks = (tasks: ParsedTask[]): ParsedTask[] => {
  const flattened: ParsedTask[] = [];

  const visit = (nodes: ParsedTask[]): void => {
    for (const node of nodes) {
      flattened.push(node);
      visit(node.children);
    }
  };

  visit(tasks);
  return flattened;
};

export const toggleTaskInMarkdown = (markdown: string, line: number): string => {
  const eol = markdown.includes('\r\n') ? '\r\n' : '\n';
  const lines = markdown.split(eol);
  const target = lines[line];

  if (target === undefined) {
    throw new Error(`Line ${line + 1} is out of range.`);
  }

  const match = CHECKBOX_RE.exec(target);
  if (!match) {
    throw new Error(`Line ${line + 1} is not a task checkbox.`);
  }

  const checked = match[2].toLowerCase() === 'x';
  lines[line] = target.replace(/\[([ xX])\]/, checked ? '[ ]' : '[x]');
  return lines.join(eol);
};
