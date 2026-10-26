import React from 'react';
import { CodeBlock } from './CodeBlock';
import { useApp } from '../../state/AppContext';

interface MarkdownContentProps {
  content: string;
  textColor?: string;
}

export const MarkdownContent: React.FC<MarkdownContentProps> = ({ content, textColor }) => {
  const { theme } = useApp();
  const isLight = theme === 'light';
  const effectiveTextColor = textColor || (isLight ? 'text-[#18181b]' : 'text-neutral-200');

  // Parse markdown content into structured blocks (code blocks vs text blocks)
  const blocks = React.useMemo(() => {
    const result: Array<
      | { type: 'code'; code: string; language: string }
      | { type: 'text'; content: string }
    > = [];

    // Fenced code block regex: ```lang?\ncode\n```
    const codeBlockRegex = /```([a-zA-Z0-9_\-+]*)\n([\s\S]*?)```/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = codeBlockRegex.exec(content)) !== null) {
      const precedingText = content.slice(lastIndex, match.index);
      if (precedingText) {
        result.push({ type: 'text', content: precedingText });
      }

      const language = match[1] ? match[1].trim() : '';
      const code = match[2];
      result.push({ type: 'code', code, language });

      lastIndex = match.index + match[0].length;
    }

    const remainingText = content.slice(lastIndex);
    if (remainingText) {
      result.push({ type: 'text', content: remainingText });
    }

    return result;
  }, [content]);

  // Helper to format inline markdown (inline code, bold, links)
  const renderInlineFormatted = (text: string) => {
    // Split by inline code: `code`
    const parts = text.split(/(`[^`]+`)/g);

    return parts.map((part, pIdx) => {
      if (part.startsWith('`') && part.endsWith('`')) {
        const inner = part.slice(1, -1);
        return (
          <code
            key={pIdx}
            className={`px-1.5 py-0.5 mx-0.5 rounded-md ${
              isLight
                ? 'bg-[#f1f2f5] border-[#dcdce2] text-[#0284c7]'
                : 'bg-[#222129] border-[#2e2d38] text-sky-300'
            } border font-mono text-[12px] font-normal select-all`}
          >
            {inner}
          </code>
        );
      }

      // Handle bold **text**
      const boldParts = part.split(/(\*\*[^*]+\*\*)/g);
      return boldParts.map((bPart, bIdx) => {
        if (bPart.startsWith('**') && bPart.endsWith('**')) {
          return (
            <strong key={`${pIdx}-${bIdx}`} className={`font-bold ${textColor ? 'brightness-110' : isLight ? 'text-[#09090b]' : 'text-white'}`}>
              {bPart.slice(2, -2)}
            </strong>
          );
        }
        return bPart;
      });
    });
  };

  return (
    <div className={`space-y-3 leading-relaxed ${effectiveTextColor}`}>
      {blocks.map((block, idx) => {
        if (block.type === 'code') {
          return (
            <CodeBlock
              key={idx}
              code={block.code}
              language={block.language}
            />
          );
        }

        // Text block: split into paragraphs by double newlines or single newlines
        const paragraphs = block.content.split(/\n\n+/);

        return (
          <div key={idx} className="space-y-2">
            {paragraphs.map((p, pIdx) => {
              const trimmed = p.trim();
              if (!trimmed) return null;

              // Check if bullet point list
              if (trimmed.includes('\n* ') || trimmed.includes('\n- ') || trimmed.startsWith('* ') || trimmed.startsWith('- ')) {
                const listItems = trimmed.split(/\n[\*\-]\s+/);
                const firstIsItem = trimmed.startsWith('* ') || trimmed.startsWith('- ');
                
                return (
                  <ul key={pIdx} className={`space-y-1 my-1.5 pl-4 list-disc list-outside ${effectiveTextColor}`}>
                    {listItems.map((li, liIdx) => {
                      const cleanLi = liIdx === 0 && firstIsItem ? li.replace(/^[\*\-]\s+/, '') : li;
                      if (!cleanLi.trim()) return null;
                      return (
                        <li key={liIdx} className="pl-1 leading-relaxed">
                          {renderInlineFormatted(cleanLi)}
                        </li>
                      );
                    })}
                  </ul>
                );
              }

              return (
                <p key={pIdx} className="whitespace-pre-line leading-relaxed">
                  {renderInlineFormatted(trimmed)}
                </p>
              );
            })}
          </div>
        );
      })}
    </div>
  );
};
