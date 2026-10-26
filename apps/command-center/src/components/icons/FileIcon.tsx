import React from 'react';
import {
  Folder,
  FolderOpen,
  FileCode,
  FileText,
  FileJson,
  FileSpreadsheet,
  Image as ImageIcon,
  Lock,
  Settings2,
  Terminal,
  File,
  Boxes,
  Layers,
  Database,
  Globe,
  FileType,
  Sparkles,
  Cpu,
  PackageOpen,
  GitBranch,
  ShieldAlert,
  Braces,
  FileDigit,
  Binary,
  Archive,
  Film,
  Music,
} from 'lucide-react';

export interface FileIconProps {
  filename: string;
  className?: string;
  size?: number;
}

export interface FolderIconProps {
  name: string;
  isOpen: boolean;
  className?: string;
  size?: number;
}

/**
 * VS Code / Antigravity styled high-fidelity SVG icon resolver for files.
 * Centralized icon engine ensuring exact filenames take precedence over generic extensions.
 */
export const FileIcon: React.FC<FileIconProps> = ({
  filename,
  className = 'w-3.5 h-3.5 shrink-0',
}) => {
  const cleanName = filename.trim();
  const lowerName = cleanName.toLowerCase();
  const baseName = lowerName.split(/[/\\]/).pop() || lowerName;
  const parts = baseName.split('.');
  const hasExt = parts.length > 1;
  const ext = hasExt ? parts.pop() || '' : '';
  const secondExt = parts.length > 1 ? parts.pop() || '' : '';

  // =========================================================================
  // 1. EXACT FILENAMES & SPECIAL MATCHES (HIGHEST PRECEDENCE)
  // =========================================================================

  // NPM Package Manifest
  if (baseName === 'package.json') {
    return (
      <svg viewBox="0 0 24 24" className={className} fill="none">
        <path d="M12 2L2 7l10 5 10-5-10-5z" fill="#CB3837" />
        <path d="M2 17l10 5 10-5M2 12l10 5 10-5" stroke="#CB3837" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  // TypeScript / JavaScript Configs
  if (
    baseName === 'tsconfig.json' ||
    baseName.startsWith('tsconfig.') ||
    baseName === 'jsconfig.json' ||
    baseName.startsWith('jsconfig.')
  ) {
    return (
      <svg viewBox="0 0 24 24" className={className} fill="none">
        <rect x="2" y="2" width="20" height="20" rx="4" fill="#3178C6" />
        <text x="12" y="16" fill="#ffffff" fontSize="11" fontWeight="bold" textAnchor="middle" fontFamily="monospace">
          TS
        </text>
      </svg>
    );
  }

  // Vite Configuration
  if (baseName.startsWith('vite.config.')) {
    return (
      <svg viewBox="0 0 24 24" className={className} fill="none">
        <path d="M19.5 3.5L12 21 4.5 3.5l15 0z" fill="url(#vite-grad)" />
        <path d="M14.5 4l-4 7.5h3L10 18l5.5-8.5h-3.5L14.5 4z" fill="#FFD62E" />
        <defs>
          <linearGradient id="vite-grad" x1="4.5" y1="3.5" x2="19.5" y2="21" gradientUnits="userSpaceOnUse">
            <stop stopColor="#41D1FF" />
            <stop offset="1" stopColor="#BD34FE" />
          </linearGradient>
        </defs>
      </svg>
    );
  }

  // Tailwind CSS Configuration
  if (baseName.startsWith('tailwind.config.') || baseName === 'tailwind.config') {
    return (
      <svg viewBox="0 0 24 24" className={className} fill="none">
        <path
          d="M12 6c-3.3 0-5.3 1.7-6 5 1.3-1.7 3-2.3 5-2 1.2.2 2 1.1 3 2.1C15.5 12.8 17.6 15 22 15c3.3 0 5.3-1.7 6-5-1.3 1.7-3 2.3-5 2-1.2-.2-2-1.1-3-2.1C18.5 8.2 16.4 6 12 6zm-10 9c-3.3 0-5.3 1.7-6 5 1.3-1.7 3-2.3 5-2 1.2.2 2 1.1 3 2.1C5.5 21.8 7.6 24 12 24c3.3 0 5.3-1.7 6-5-1.3 1.7-3 2.3-5 2-1.2-.2-2-1.1-3-2.1C8.5 17.2 6.4 15 2 15z"
          fill="#38BDF8"
          transform="scale(0.7) translate(2, 2)"
        />
      </svg>
    );
  }

  // Environment Files (.env, .env.local, .env.development, etc.)
  if (baseName === '.env' || baseName.startsWith('.env.')) {
    return (
      <svg viewBox="0 0 24 24" className={className} fill="none" stroke="#EAB308" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
    );
  }

  // Git System Files (.gitignore, .gitattributes, .gitmodules)
  if (baseName.startsWith('.git') || baseName === '.gitignore' || baseName === '.gitattributes') {
    return (
      <svg viewBox="0 0 24 24" className={className} fill="none">
        <path d="M21.6 10.9L13.1 2.4a1.7 1.7 0 00-2.4 0L8.3 4.8l3.1 3.1a2 2 0 012.6 2.6l3 3a2 2 0 11-1.2 1.2l-3-3v4.6a2 2 0 11-1.7 0V9.8a2 2 0 01-1.1-2.6L7.9 4.1 2.4 9.6a1.7 1.7 0 000 2.4l8.5 8.5a1.7 1.7 0 002.4 0l8.3-8.3a1.7 1.7 0 000-2.4z" fill="#F05032" />
      </svg>
    );
  }

  // Docker Container Files
  if (baseName === 'dockerfile' || baseName.startsWith('dockerfile.') || baseName.includes('docker-compose') || baseName === 'compose.yaml') {
    return (
      <svg viewBox="0 0 24 24" className={className} fill="none">
        <path d="M22 13.5c-.5-.3-1.5-.4-2.2-.2-.4-1.6-1.5-2.6-3-2.8-.2-.7-.6-1.4-1.2-1.9L15 8.2V5h-3v2H9V5H6v2H4.5A2.5 2.5 0 002 9.5V14c0 3.9 3.1 7 7 7 5.2 0 9.8-3.3 11-8.5.7.3 1.5.2 2-.5v-.5z" fill="#2496ED" />
      </svg>
    );
  }

  // Lock Files (pnpm-lock.yaml, package-lock.json, yarn.lock, bun.lockb, Cargo.lock, etc.)
  if (
    baseName === 'package-lock.json' ||
    baseName === 'pnpm-lock.yaml' ||
    baseName === 'yarn.lock' ||
    baseName === 'bun.lockb' ||
    baseName === 'cargo.lock' ||
    baseName === 'gemfile.lock' ||
    baseName === 'composer.lock' ||
    baseName.endsWith('.lock')
  ) {
    return <Lock className={`${className} text-amber-400`} strokeWidth={2} />;
  }

  // README & Documentation Files
  if (baseName.startsWith('readme')) {
    return (
      <svg viewBox="0 0 24 24" className={className} fill="none">
        <rect x="2" y="3" width="20" height="18" rx="3" fill="#0284C7" />
        <path d="M6 8l3 3 3-3v8H9v-5l-2 2-2-2v5H4V8h2zm11 0l-3 4.5h2V16h2v-3.5h2L17 8z" fill="#ffffff" />
      </svg>
    );
  }

  // License Files
  if (baseName.startsWith('license') || baseName.startsWith('licence')) {
    return <ShieldAlert className={`${className} text-amber-300`} strokeWidth={2} />;
  }

  // ESLint & Prettier
  if (baseName.startsWith('.eslintrc') || baseName.startsWith('eslint.config')) {
    return <Settings2 className={`${className} text-indigo-400`} strokeWidth={2} />;
  }
  if (baseName.startsWith('.prettierrc') || baseName.startsWith('prettier.config')) {
    return <Settings2 className={`${className} text-pink-400`} strokeWidth={2} />;
  }

  // Makefile / Procfile
  if (baseName === 'makefile' || baseName === 'gnumakefile') {
    return <Terminal className={`${className} text-amber-500`} strokeWidth={2} />;
  }
  if (baseName === 'procfile') {
    return <Terminal className={`${className} text-purple-400`} strokeWidth={2} />;
  }

  // =========================================================================
  // 2. EXTENSION-BASED MATCHING (SECOND PRECEDENCE)
  // =========================================================================

  switch (ext) {
    // React TypeScript
    case 'tsx':
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none">
          <ellipse cx="12" cy="12" rx="10" ry="4.2" stroke="#00D8FF" strokeWidth="1.6" transform="rotate(30 12 12)" />
          <ellipse cx="12" cy="12" rx="10" ry="4.2" stroke="#00D8FF" strokeWidth="1.6" transform="rotate(90 12 12)" />
          <ellipse cx="12" cy="12" rx="10" ry="4.2" stroke="#00D8FF" strokeWidth="1.6" transform="rotate(150 12 12)" />
          <circle cx="12" cy="12" r="1.8" fill="#00D8FF" />
        </svg>
      );

    // TypeScript
    case 'ts':
    case 'mts':
    case 'cts':
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none">
          <rect x="2" y="2" width="20" height="20" rx="3" fill="#3178C6" />
          <text x="12" y="16.5" fill="#ffffff" fontSize="12" fontWeight="bold" textAnchor="middle" fontFamily="system-ui, sans-serif">
            TS
          </text>
        </svg>
      );

    // React JavaScript
    case 'jsx':
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none">
          <ellipse cx="12" cy="12" rx="9.5" ry="3.8" stroke="#61DAFB" strokeWidth="1.6" transform="rotate(30 12 12)" />
          <ellipse cx="12" cy="12" rx="9.5" ry="3.8" stroke="#61DAFB" strokeWidth="1.6" transform="rotate(90 12 12)" />
          <ellipse cx="12" cy="12" rx="9.5" ry="3.8" stroke="#61DAFB" strokeWidth="1.6" transform="rotate(150 12 12)" />
          <circle cx="12" cy="12" r="1.6" fill="#61DAFB" />
        </svg>
      );

    // JavaScript
    case 'js':
    case 'mjs':
    case 'cjs':
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none">
          <rect x="2" y="2" width="20" height="20" rx="3" fill="#F7DF1E" />
          <text x="12" y="16.5" fill="#000000" fontSize="12" fontWeight="900" textAnchor="middle" fontFamily="system-ui, sans-serif">
            JS
          </text>
        </svg>
      );

    // Cascading Style Sheets
    case 'css':
    case 'scss':
    case 'sass':
    case 'less':
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none">
          <path d="M4 3l1.8 17.5L12 22l6.2-1.5L20 3H4z" fill="#264DE4" />
          <path d="M12 4.5v15.8l4.8-1.2 1.4-14.6H12z" fill="#2965F1" />
          <path d="M8 8h8l-.3 3H8.3l.2 3h7.2l-.4 4.5-3.3.9-3.3-.9-.2-2H6.4l.4 3.7 5.2 1.5 5.2-1.5.7-7.7H7.8L8 8z" fill="#ffffff" />
        </svg>
      );

    // HTML
    case 'html':
    case 'htm':
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none">
          <path d="M4 3l1.8 17.5L12 22l6.2-1.5L20 3H4z" fill="#E34F26" />
          <path d="M12 4.5v15.8l4.8-1.2 1.4-14.6H12z" fill="#EF652A" />
          <path d="M8.2 8h7.6l-.2 2.5H10.7l.2 2.5h4.6l-.4 4.5-3.1.9-3.1-.9-.2-1.8H6.7l.3 3.5 5 1.4 5-1.4.7-7.7H8l.2-2.5z" fill="#ffffff" />
        </svg>
      );

    // JSON Data
    case 'json':
    case 'json5':
    case 'jsonc':
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none">
          <rect x="2" y="2" width="20" height="20" rx="3" fill="#F59E0B" />
          <text x="12" y="16" fill="#000000" fontSize="13" fontWeight="bold" textAnchor="middle" fontFamily="monospace">
            {'{ }'}
          </text>
        </svg>
      );

    // Markdown
    case 'md':
    case 'mdx':
    case 'markdown':
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none">
          <rect x="2" y="3" width="20" height="18" rx="3" fill="#38BDF8" />
          <path d="M6 8l3 3 3-3v8H9v-5l-2 2-2-2v5H4V8h2zm11 0l-3 4.5h2V16h2v-3.5h2L17 8z" fill="#ffffff" />
        </svg>
      );

    // Python
    case 'py':
    case 'pyw':
    case 'ipynb':
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none">
          <path d="M11.8 2c-4.8 0-4.5 2.1-4.5 2.1l.1 2.2h4.5v.6H5.4S2 6.5 2 11.3s3 4.6 3 4.6h1.8v-2.3s-.1-2.7 2.6-2.7h4.4s2.5 0 2.5-2.5V4.6S16.6 2 11.8 2zm-1.3 1.5a.9.9 0 110 1.8.9.9 0 010-1.8z" fill="#3776AB" />
          <path d="M12.2 22c4.8 0 4.5-2.1 4.5-2.1l-.1-2.2h-4.5v-.6h6.5s3.4.4 3.4-4.4-3-4.6-3-4.6h-1.8v2.3s.1 2.7-2.6 2.7h-4.4s-2.5 0-2.5 2.5v3.8s-.3 2.6 4.5 2.6zm1.3-1.5a.9.9 0 110-1.8.9.9 0 010 1.8z" fill="#FFD43B" />
        </svg>
      );

    // Rust
    case 'rs':
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none">
          <circle cx="12" cy="12" r="9" stroke="#DEA584" strokeWidth="2" />
          <text x="12" y="16" fill="#DEA584" fontSize="10" fontWeight="bold" textAnchor="middle" fontFamily="monospace">
            RS
          </text>
        </svg>
      );

    // Go
    case 'go':
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none">
          <rect x="2" y="3" width="20" height="18" rx="3" fill="#00ADD8" />
          <text x="12" y="16" fill="#ffffff" fontSize="11" fontWeight="bold" textAnchor="middle" fontFamily="monospace">
            GO
          </text>
        </svg>
      );

    // Java / Kotlin
    case 'java':
    case 'class':
    case 'jar':
      return <FileCode className={`${className} text-orange-400`} strokeWidth={2} />;
    case 'kt':
    case 'kts':
      return <FileCode className={`${className} text-purple-400`} strokeWidth={2} />;

    // C / C++ / C#
    case 'c':
    case 'h':
      return <FileCode className={`${className} text-blue-400`} strokeWidth={2} />;
    case 'cpp':
    case 'hpp':
    case 'cc':
    case 'cxx':
      return <FileCode className={`${className} text-blue-500`} strokeWidth={2} />;
    case 'cs':
      return <FileCode className={`${className} text-emerald-500`} strokeWidth={2} />;

    // PHP / Ruby / Swift / Dart
    case 'php':
      return <FileCode className={`${className} text-indigo-400`} strokeWidth={2} />;
    case 'rb':
    case 'erb':
      return <FileCode className={`${className} text-rose-500`} strokeWidth={2} />;
    case 'swift':
      return <FileCode className={`${className} text-orange-500`} strokeWidth={2} />;
    case 'dart':
      return <FileCode className={`${className} text-cyan-500`} strokeWidth={2} />;

    // SQL / Databases / Prisma
    case 'sql':
    case 'prisma':
    case 'db':
    case 'sqlite':
      return <Database className={`${className} text-indigo-400`} strokeWidth={2} />;

    // GraphQL
    case 'graphql':
    case 'gql':
      return <Braces className={`${className} text-pink-400`} strokeWidth={2} />;

    // Web Vector & Images
    case 'svg':
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
    case 'ico':
    case 'bmp':
      return <ImageIcon className={`${className} text-emerald-400`} strokeWidth={2} />;

    // Audio & Video
    case 'mp4':
    case 'mov':
    case 'webm':
    case 'avi':
      return <Film className={`${className} text-violet-400`} strokeWidth={2} />;
    case 'mp3':
    case 'wav':
    case 'ogg':
    case 'flac':
      return <Music className={`${className} text-amber-300`} strokeWidth={2} />;

    // Configuration / Serialization
    case 'yaml':
    case 'yml':
    case 'toml':
    case 'ini':
    case 'xml':
      return <Settings2 className={`${className} text-rose-400`} strokeWidth={2} />;

    // Shell Scripts
    case 'sh':
    case 'bash':
    case 'zsh':
    case 'fish':
    case 'ps1':
    case 'bat':
    case 'cmd':
      return <Terminal className={`${className} text-emerald-300`} strokeWidth={2} />;

    // Compressed Archives
    case 'zip':
    case 'tar':
    case 'gz':
    case '7z':
    case 'rar':
      return <Archive className={`${className} text-amber-500`} strokeWidth={2} />;

    // Binaries / WASM
    case 'wasm':
    case 'bin':
    case 'exe':
    case 'dll':
    case 'so':
    case 'dylib':
      return <Binary className={`${className} text-red-400`} strokeWidth={2} />;

    // =========================================================================
    // 3. CLEAN FALLBACK FOR UNKNOWN EXTENSIONS & EXTENSIONLESS FILES
    // =========================================================================
    default:
      if (!hasExt) {
        // Clean extensionless file
        return <File className={`${className} text-neutral-400`} strokeWidth={1.8} />;
      }
      // Unknown extension
      return <FileText className={`${className} text-neutral-400`} strokeWidth={1.8} />;
  }
};

/**
 * VS Code / Antigravity styled Folder icon resolver.
 * Centralized directory resolution for open and closed folder states.
 */
export const FolderIcon: React.FC<FolderIconProps> = ({
  name,
  isOpen,
  className = 'w-3.5 h-3.5 shrink-0',
}) => {
  const lower = name.toLowerCase().trim();

  // Source & Code Root
  if (lower === 'src' || lower === 'source' || lower === 'app' || lower === 'lib') {
    return isOpen ? (
      <FolderOpen className={`${className} text-sky-400`} strokeWidth={2} />
    ) : (
      <Folder className={`${className} text-sky-400`} strokeWidth={2} />
    );
  }

  // Components & UI
  if (lower === 'components' || lower === 'widgets' || lower === 'ui') {
    return isOpen ? (
      <FolderOpen className={`${className} text-teal-400`} strokeWidth={2} />
    ) : (
      <Folder className={`${className} text-teal-400`} strokeWidth={2} />
    );
  }

  // Features, Routes, Pages
  if (lower === 'features' || lower === 'routes' || lower === 'pages' || lower === 'views') {
    return isOpen ? (
      <FolderOpen className={`${className} text-indigo-400`} strokeWidth={2} />
    ) : (
      <Folder className={`${className} text-indigo-400`} strokeWidth={2} />
    );
  }

  // Static Assets & Public
  if (lower === 'public' || lower === 'assets' || lower === 'static' || lower === 'images' || lower === 'icons') {
    return isOpen ? (
      <FolderOpen className={`${className} text-emerald-400`} strokeWidth={2} />
    ) : (
      <Folder className={`${className} text-emerald-400`} strokeWidth={2} />
    );
  }

  // Runtime, Server, API, Backend
  if (
    lower === 'runtime' ||
    lower === 'api' ||
    lower === 'server' ||
    lower === 'backend' ||
    lower === 'controllers' ||
    lower === 'services'
  ) {
    return isOpen ? (
      <FolderOpen className={`${className} text-purple-400`} strokeWidth={2} />
    ) : (
      <Folder className={`${className} text-purple-400`} strokeWidth={2} />
    );
  }

  // State, Store, Context, Hooks
  if (lower === 'state' || lower === 'store' || lower === 'context' || lower === 'hooks' || lower === 'reducers') {
    return isOpen ? (
      <FolderOpen className={`${className} text-cyan-400`} strokeWidth={2} />
    ) : (
      <Folder className={`${className} text-cyan-400`} strokeWidth={2} />
    );
  }

  // Tests & Spec
  if (lower === 'tests' || lower === 'test' || lower === '__tests__' || lower === 'spec' || lower === '__mocks__') {
    return isOpen ? (
      <FolderOpen className={`${className} text-lime-400`} strokeWidth={2} />
    ) : (
      <Folder className={`${className} text-lime-400`} strokeWidth={2} />
    );
  }

  // Node Modules & Vendors
  if (lower === 'node_modules' || lower === 'vendor' || lower === '.pnpm') {
    return isOpen ? (
      <FolderOpen className={`${className} text-neutral-500`} strokeWidth={2} />
    ) : (
      <Folder className={`${className} text-neutral-500`} strokeWidth={2} />
    );
  }

  // Config & Dot Folders
  if (lower === 'config' || lower === '.vscode' || lower === '.github' || lower === '.git') {
    return isOpen ? (
      <FolderOpen className={`${className} text-zinc-400`} strokeWidth={2} />
    ) : (
      <Folder className={`${className} text-zinc-400`} strokeWidth={2} />
    );
  }

  // Default directory
  return isOpen ? (
    <FolderOpen className={`${className} text-amber-400`} strokeWidth={2} />
  ) : (
    <Folder className={`${className} text-amber-400/90`} strokeWidth={2} />
  );
};
