import React, { useState, useMemo } from 'react';
import hljs from 'highlight.js';
import 'highlight.js/styles/github-dark.css';
import { Copy, Check, Code2 } from 'lucide-react';
import { useApp } from '../../state/AppContext';

interface CodeBlockProps {
  code: string;
  language?: string;
  showLineNumbers?: boolean;
}

export const CodeBlock: React.FC<CodeBlockProps> = ({
  code,
  language,
  showLineNumbers = true,
}) => {
  const { theme } = useApp();
  const isLight = theme === 'light';
  const [copied, setCopied] = useState(false);

  // Normalize language alias
  const normalizedLang = useMemo(() => {
    if (!language) return '';
    const clean = language.trim().toLowerCase();
    const aliasMap: Record<string, string> = {
      ts: 'typescript',
      js: 'javascript',
      py: 'python',
      sh: 'bash',
      shell: 'bash',
      zsh: 'bash',
      yml: 'yaml',
      golang: 'go',
      rs: 'rust',
      rb: 'ruby',
    };
    return aliasMap[clean] || clean;
  }, [language]);

  // Syntax highlighting via highlight.js
  const { highlightedHtml, detectedLang } = useMemo(() => {
    const trimmedCode = code.replace(/\n$/, '');
    try {
      if (normalizedLang && hljs.getLanguage(normalizedLang)) {
        const result = hljs.highlight(trimmedCode, {
          language: normalizedLang,
          ignoreIllegals: true,
        });
        return {
          highlightedHtml: result.value,
          detectedLang: normalizedLang,
        };
      }
      // Auto detect language
      const autoResult = hljs.highlightAuto(trimmedCode);
      return {
        highlightedHtml: autoResult.value,
        detectedLang: autoResult.language || 'text',
      };
    } catch {
      // Fallback to basic escaping
      return {
        highlightedHtml: trimmedCode
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;'),
        detectedLang: normalizedLang || 'text',
      };
    }
  }, [code, normalizedLang]);

  // Split lines for line numbering
  const lines = useMemo(() => {
    return highlightedHtml.split('\n');
  }, [highlightedHtml]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
    }
  };

  return (
    <div className={`my-3 rounded-xl border ${
      isLight ? 'border-[#e2e4e8] bg-[#f8f9fa] shadow-sm' : 'border-[#2b2a36] bg-[#121215] shadow-lg'
    } overflow-hidden text-xs group`}>
      {/* Code Header Bar */}
      <div className={`flex items-center justify-between px-4 py-2 ${
        isLight ? 'bg-[#f1f2f5] border-b border-[#e2e4e8]' : 'bg-[#18171f] border-b border-[#282732]'
      } select-none`}>
        <div className="flex items-center gap-2">
          <Code2 className={`w-3.5 h-3.5 ${isLight ? 'text-[#64748b]' : 'text-neutral-400'}`} />
          <span className={`font-mono text-[11px] font-semibold ${isLight ? 'text-[#18181b]' : 'text-neutral-300'} uppercase tracking-wider`}>
            {detectedLang}
          </span>
          <span className={`text-[10px] ${isLight ? 'text-[#64748b]' : 'text-neutral-500'} font-mono`}>
            {lines.length} {lines.length === 1 ? 'line' : 'lines'}
          </span>
        </div>

        {/* Copy Button */}
        <button
          onClick={handleCopy}
          aria-label={copied ? 'Copied code' : 'Copy code to clipboard'}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium transition-all cursor-pointer ${
            copied
              ? isLight
                ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                : 'bg-emerald-950/80 text-emerald-300 border border-emerald-800/60'
              : isLight
              ? 'text-[#475569] hover:text-[#09090b] bg-white hover:bg-[#f8f9fa] border border-[#dcdce2] shadow-2xs'
              : 'text-neutral-400 hover:text-white bg-[#22212b] hover:bg-[#2b2a37] border border-[#323140]'
          }`}
        >
          {copied ? (
            <>
              <Check className="w-3 h-3 text-emerald-600" />
              <span>Copied!</span>
            </>
          ) : (
            <>
              <Copy className={`w-3 h-3 ${isLight ? 'text-[#64748b] group-hover:text-[#09090b]' : 'text-neutral-400 group-hover:text-white'}`} />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>

      {/* Code Content Container */}
      <div className={`p-3.5 overflow-x-auto text-[13px] font-mono leading-relaxed select-text ${
        isLight ? 'bg-white' : ''
      } scrollbar-thin`}>
        {showLineNumbers && lines.length > 1 ? (
          <table className="w-full border-collapse">
            <tbody>
              {lines.map((lineHtml, idx) => (
                <tr key={idx} className={`${isLight ? 'hover:bg-[#f8fafc]' : 'hover:bg-[#1a1923]/60'} transition-colors`}>
                  <td className={`w-8 select-none text-right pr-4 ${isLight ? 'text-[#94a3b8]' : 'text-neutral-600'} text-[11px] font-mono align-top py-0.5`}>
                    {idx + 1}
                  </td>
                  <td
                    className="py-0.5 whitespace-pre hljs"
                    style={{ background: 'transparent' }}
                    dangerouslySetInnerHTML={{ __html: lineHtml || '&nbsp;' }}
                  />
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <pre className="hljs m-0 p-0" style={{ background: 'transparent' }}>
            <code
              className={`hljs language-${detectedLang}`}
              dangerouslySetInnerHTML={{ __html: highlightedHtml }}
            />
          </pre>
        )}
      </div>
    </div>
  );
};
