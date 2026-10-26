import type { Extension } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { python } from '@codemirror/lang-python';
import { markdown } from '@codemirror/lang-markdown';
import { sql } from '@codemirror/lang-sql';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import { rust } from '@codemirror/lang-rust';
import { cpp } from '@codemirror/lang-cpp';

const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'tiff',
  'mp4', 'mov', 'webm', 'avi', 'mkv',
  'mp3', 'wav', 'ogg', 'flac', 'aac',
  'zip', 'tar', 'gz', '7z', 'rar', 'tgz',
  'exe', 'bin', 'dll', 'so', 'dylib', 'wasm',
  'pdf', 'woff', 'woff2', 'ttf', 'eot', 'otf',
  'dmg', 'iso', 'pkg', 'deb', 'rpm',
]);

export interface LanguageResolution {
  readonly languageId: string;
  readonly displayName: string;
  readonly isBinary: boolean;
  readonly support: Extension | null;
}

export function resolveEditorLanguage(filePath: string): LanguageResolution {
  const clean = filePath.trim().toLowerCase();
  const baseName = clean.split(/[/\\]/).pop() || clean;
  const ext = baseName.includes('.') ? baseName.split('.').pop() || '' : '';

  // 1. Binary guard
  if (BINARY_EXTENSIONS.has(ext)) {
    return {
      languageId: 'binary',
      displayName: 'Binary',
      isBinary: true,
      support: null,
    };
  }

  // 2. Exact file names
  if (baseName === 'package.json' || baseName === 'tsconfig.json' || baseName.endsWith('.json')) {
    return { languageId: 'json', displayName: 'JSON', isBinary: false, support: json() };
  }
  if (baseName === 'dockerfile' || baseName.startsWith('dockerfile.')) {
    return { languageId: 'dockerfile', displayName: 'Dockerfile', isBinary: false, support: null };
  }
  if (baseName === 'makefile' || baseName === 'gnumakefile') {
    return { languageId: 'makefile', displayName: 'Makefile', isBinary: false, support: null };
  }

  // 3. Extension matching
  switch (ext) {
    case 'ts':
    case 'mts':
    case 'cts':
      return { languageId: 'typescript', displayName: 'TypeScript', isBinary: false, support: javascript({ typescript: true }) };
    case 'tsx':
      return { languageId: 'typescript-jsx', displayName: 'TypeScript JSX', isBinary: false, support: javascript({ typescript: true, jsx: true }) };
    case 'js':
    case 'mjs':
    case 'cjs':
      return { languageId: 'javascript', displayName: 'JavaScript', isBinary: false, support: javascript() };
    case 'jsx':
      return { languageId: 'javascript-jsx', displayName: 'JavaScript JSX', isBinary: false, support: javascript({ jsx: true }) };
    case 'json':
    case 'jsonc':
    case 'json5':
      return { languageId: 'json', displayName: 'JSON', isBinary: false, support: json() };
    case 'html':
    case 'htm':
      return { languageId: 'html', displayName: 'HTML', isBinary: false, support: html() };
    case 'css':
    case 'scss':
    case 'sass':
    case 'less':
      return { languageId: 'css', displayName: 'CSS', isBinary: false, support: css() };
    case 'md':
    case 'mdx':
    case 'markdown':
      return { languageId: 'markdown', displayName: 'Markdown', isBinary: false, support: markdown() };
    case 'py':
    case 'pyw':
      return { languageId: 'python', displayName: 'Python', isBinary: false, support: python() };
    case 'sql':
      return { languageId: 'sql', displayName: 'SQL', isBinary: false, support: sql() };
    case 'xml':
    case 'svg':
      return { languageId: 'xml', displayName: 'XML', isBinary: false, support: xml() };
    case 'yaml':
    case 'yml':
      return { languageId: 'yaml', displayName: 'YAML', isBinary: false, support: yaml() };
    case 'rs':
      return { languageId: 'rust', displayName: 'Rust', isBinary: false, support: rust() };
    case 'c':
    case 'h':
    case 'cpp':
    case 'hpp':
    case 'cc':
    case 'cxx':
      return { languageId: 'cpp', displayName: 'C/C++', isBinary: false, support: cpp() };
    case 'sh':
    case 'bash':
    case 'zsh':
      return { languageId: 'shell', displayName: 'Shell', isBinary: false, support: null };
    case 'java':
      return { languageId: 'java', displayName: 'Java', isBinary: false, support: null };
    case 'go':
      return { languageId: 'go', displayName: 'Go', isBinary: false, support: null };
    case 'swift':
      return { languageId: 'swift', displayName: 'Swift', isBinary: false, support: null };
    case 'kt':
    case 'kts':
      return { languageId: 'kotlin', displayName: 'Kotlin', isBinary: false, support: null };
    case 'php':
      return { languageId: 'php', displayName: 'PHP', isBinary: false, support: null };
    case 'rb':
      return { languageId: 'ruby', displayName: 'Ruby', isBinary: false, support: null };
    default:
      return { languageId: 'plaintext', displayName: 'Plain Text', isBinary: false, support: null };
  }
}
