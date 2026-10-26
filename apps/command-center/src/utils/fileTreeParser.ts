import JSZip from 'jszip';
import { FileNode } from '../types';

/**
 * Builds a nested FileNode tree from an array of relative file paths.
 */
export function buildTreeFromPaths(
  paths: { path: string; name: string; isFolder?: boolean; content?: string }[]
): FileNode[] {
  const root: FileNode[] = [];

  for (const item of paths) {
    const cleanPath = item.path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!cleanPath) continue;

    const segments = cleanPath.split('/');
    let currentLevel = root;
    let accumulatedPath = '';

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const isLast = i === segments.length - 1;
      accumulatedPath = accumulatedPath ? `${accumulatedPath}/${segment}` : segment;

      let existing = currentLevel.find((node) => node.name === segment);

      if (!existing) {
        if (isLast && !item.isFolder) {
          // It's a file
          const fileNode: FileNode = {
            name: segment,
            type: 'file',
            path: accumulatedPath,
            content: item.content,
          };
          currentLevel.push(fileNode);
        } else {
          // It's a folder
          const folderNode: FileNode = {
            name: segment,
            type: 'folder',
            path: accumulatedPath,
            children: [],
          };
          currentLevel.push(folderNode);
          currentLevel = folderNode.children!;
        }
      } else {
        if (existing.type === 'folder') {
          if (!existing.children) existing.children = [];
          currentLevel = existing.children;
        }
      }
    }
  }

  // Sort: folders first alphabetically, then files alphabetically
  const sortNodes = (nodes: FileNode[]): FileNode[] => {
    return nodes
      .sort((a, b) => {
        if (a.type === b.type) {
          return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        }
        return a.type === 'folder' ? -1 : 1;
      })
      .map((node) => {
        if (node.children) {
          return { ...node, children: sortNodes(node.children) };
        }
        return node;
      });
  };

  return sortNodes(root);
}

/**
 * Parses FileList from standard directory/multi-file upload
 */
export async function parseFileListToTree(files: FileList | File[]): Promise<{ folderName: string; tree: FileNode[] }> {
  const fileArray = Array.from(files);
  if (fileArray.length === 0) {
    return { folderName: 'Opened Folder', tree: [] };
  }

  const firstRel = fileArray[0].webkitRelativePath || fileArray[0].name;
  const folderName = firstRel.includes('/') ? firstRel.split('/')[0] : 'Project Workspace';

  const paths: { path: string; name: string; isFolder?: boolean }[] = [];

  for (const file of fileArray) {
    const relPath = file.webkitRelativePath || file.name;
    // Strip root folder name if present for cleaner inside-tree navigation
    const cleanedPath = relPath.includes('/') ? relPath.split('/').slice(1).join('/') || relPath : relPath;
    paths.push({
      path: cleanedPath,
      name: file.name,
      isFolder: false,
    });
  }

  const tree = buildTreeFromPaths(paths);
  return { folderName, tree };
}

/**
 * Parses a ZIP archive file into a FileNode tree using JSZip
 */
export async function parseZipToTree(zipFile: File): Promise<{ folderName: string; tree: FileNode[] }> {
  const zip = new JSZip();
  const loadedZip = await zip.loadAsync(zipFile);
  const folderName = zipFile.name.replace(/\.zip$/i, '');

  const paths: { path: string; name: string; isFolder?: boolean }[] = [];

  loadedZip.forEach((relativePath, entry) => {
    // Ignore internal Mac metadata folders
    if (relativePath.startsWith('__MACOSX/') || relativePath.includes('/.DS_Store')) return;

    paths.push({
      path: relativePath,
      name: relativePath.split('/').filter(Boolean).pop() || '',
      isFolder: entry.dir,
    });
  });

  const tree = buildTreeFromPaths(paths);
  return { folderName, tree };
}

/**
 * Recursively parses FileSystemDirectoryHandle (Modern showDirectoryPicker API)
 */
export async function parseDirectoryHandle(dirHandle: any): Promise<{ folderName: string; tree: FileNode[] }> {
  const folderName = dirHandle.name || 'Workspace';

  async function getEntries(handle: any, currentPath: string): Promise<FileNode[]> {
    const nodes: FileNode[] = [];

    for await (const entry of handle.values()) {
      const nodePath = currentPath ? `${currentPath}/${entry.name}` : entry.name;
      if (entry.kind === 'directory') {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        const children = await getEntries(entry, nodePath);
        nodes.push({
          name: entry.name,
          type: 'folder',
          path: nodePath,
          children,
        });
      } else if (entry.kind === 'file') {
        nodes.push({
          name: entry.name,
          type: 'file',
          path: nodePath,
        });
      }
    }

    return nodes.sort((a, b) => {
      if (a.type === b.type) return a.name.localeCompare(b.name);
      return a.type === 'folder' ? -1 : 1;
    });
  }

  const tree = await getEntries(dirHandle, '');
  return { folderName, tree };
}
