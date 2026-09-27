import type { ChangedFile, GitFileStatus } from './types';

export interface FileNode {
  kind: 'file';
  name: string;
  path: string;
  status: GitFileStatus;
  additions?: number;
  deletions?: number;
  /** Renames only: the path at the comparison base — where the diff's old side is read from. */
  previousPath?: string;
  /** Flat-list layout only: the containing directory (`src/utils`), shown in the item's description. */
  directory?: string;
}

export interface FolderNode {
  kind: 'folder';
  name: string;
  path: string;
  children: TreeNode[];
}

export type TreeNode = FileNode | FolderNode;

/**
 * Builds a nested folder tree from a flat list of changed files, folders sorted before files
 * and both sorted alphabetically — matching how VSCode's own Explorer/SCM views order entries.
 */
export function buildChangedFilesTree(files: ChangedFile[]): TreeNode[] {
  const root: FolderNode = { kind: 'folder', name: '', path: '', children: [] };

  for (const file of files) {
    const segments = file.path.split('/');
    let current = root;

    for (let i = 0; i < segments.length - 1; i++) {
      const segment = segments[i];
      const segmentPath = segments.slice(0, i + 1).join('/');
      let next = current.children.find(
        (child): child is FolderNode => child.kind === 'folder' && child.name === segment,
      );
      if (!next) {
        next = { kind: 'folder', name: segment, path: segmentPath, children: [] };
        current.children.push(next);
      }
      current = next;
    }

    const fileName = segments[segments.length - 1];
    current.children.push(fileNode(file, fileName));
  }

  sortChildren(root);
  return root.children;
}

export type TreeLayout = 'tree' | 'list';

/**
 * The `chevron.treeLayout: "list"` form: every changed file at the top level, sorted by full path
 * (so files in the same directory stay together), each carrying its containing directory for the
 * item's description — the same shape as the built-in Source Control view's list mode.
 */
export function buildChangedFilesList(files: ChangedFile[]): FileNode[] {
  return files
    .map((file): FileNode => {
      const slash = file.path.lastIndexOf('/');
      const node = fileNode(file, slash < 0 ? file.path : file.path.slice(slash + 1));
      if (slash >= 0) {
        node.directory = file.path.slice(0, slash);
      }
      return node;
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Tree or flat list, per `chevron.treeLayout`. */
export function buildChangedFilesLayout(files: ChangedFile[], layout: TreeLayout): TreeNode[] {
  return layout === 'list' ? buildChangedFilesList(files) : buildChangedFilesTree(files);
}

function fileNode(file: ChangedFile, name: string): FileNode {
  const node: FileNode = {
    kind: 'file',
    name,
    path: file.path,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
  };
  if (file.previousPath !== undefined) {
    node.previousPath = file.previousPath;
  }
  return node;
}

function sortChildren(folder: FolderNode): void {
  folder.children.sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === 'folder' ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
  for (const child of folder.children) {
    if (child.kind === 'folder') {
      sortChildren(child);
    }
  }
}
