import { EditorView } from '@codemirror/view';
import { Extension } from '@codemirror/state';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';

/**
 * Mediobot-Native Dark Syntax Theme.
 * Balanced, accessible, and professional dark palette designed specifically
 * for Mediobot V2 dark mode interface.
 */
export const mediobotEditorTheme = EditorView.theme(
  {
    '&': {
      color: '#e1e4ea',
      backgroundColor: '#121215',
      fontSize: '13px',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      height: '100%',
    },
    '.cm-content': {
      caretColor: '#58a6ff',
      padding: '12px 16px 12px 4px',
      lineHeight: '1.6',
    },
    '&.cm-focused .cm-cursor': {
      borderLeftColor: '#58a6ff',
      borderLeftWidth: '2px',
    },
    '&.cm-focused .cm-selectionBackground, ::selection': {
      backgroundColor: '#264f7866',
    },
    '.cm-selectionMatch': {
      backgroundColor: '#3a506844',
      borderRadius: '2px',
    },
    '.cm-gutters': {
      backgroundColor: '#121215',
      color: '#4e5563',
      borderRight: '1px solid #1f1f26',
      paddingRight: '8px',
      userSelect: 'none',
    },
    '.cm-lineNumbers .cm-gutterElement': {
      minWidth: '40px',
      textAlign: 'right',
      paddingRight: '12px',
      fontSize: '12px',
    },
    '.cm-activeLine': {
      backgroundColor: '#18181f66',
    },
    '.cm-activeLineGutter': {
      backgroundColor: '#18181f66',
      color: '#9aa2b2',
      fontWeight: '600',
    },
    '.cm-scroller': {
      overflow: 'auto',
      fontFamily: 'inherit',
    },
  },
  { dark: true },
);

export const mediobotHighlightStyle = HighlightStyle.define([
  // Comments: Muted slate, italic
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: '#687082', fontStyle: 'italic' },

  // Strings & regex: Soft emerald mint
  { tag: [tags.string, tags.special(tags.string)], color: '#7ee787' },
  { tag: [tags.regexp, tags.escape], color: '#a5d6ff' },

  // Numbers: Warm amber / gold
  { tag: [tags.number, tags.integer, tags.float], color: '#e3b341' },

  // Keywords & Control flow: Elegant violet
  { tag: [tags.keyword, tags.controlKeyword, tags.modifier], color: '#d2a8ff', fontWeight: '500' },
  { tag: [tags.moduleKeyword], color: '#d2a8ff', fontWeight: '600' },

  // Types & Classes: Coral / Peach
  { tag: [tags.typeName, tags.className, tags.namespace], color: '#ff7b72', fontWeight: '500' },

  // Functions & Methods: Crisp sky blue
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: '#79c0ff' },

  // Properties & Fields: Soft cyan
  { tag: [tags.propertyName, tags.definition(tags.propertyName)], color: '#a5d6ff' },

  // Constants, Booleans, Null: Vivid cyan / teal
  { tag: [tags.constant(tags.variableName), tags.bool, tags.null], color: '#56d4dd', fontWeight: '600' },

  // Operators: Light salmon / rose
  { tag: [tags.operator, tags.arithmeticOperator, tags.logicOperator, tags.bitwiseOperator], color: '#f47067' },

  // Punctuation & Delimiters: Neutral steel
  { tag: [tags.punctuation, tags.separator], color: '#8b949e' },
  { tag: [tags.paren, tags.bracket, tags.brace], color: '#c9d1d9' },

  // Tags (HTML / JSX / TSX): Mint for tags, Sky for components
  { tag: [tags.tagName], color: '#7ee787' },
  { tag: [tags.angleBracket], color: '#8b949e' },

  // Attributes: Soft blue
  { tag: [tags.attributeName], color: '#79c0ff' },
  { tag: [tags.attributeValue], color: '#a5d6ff' },

  // Variable names: Default light slate
  { tag: [tags.variableName], color: '#e1e4ea' },
  { tag: [tags.definition(tags.variableName)], color: '#e1e4ea', fontWeight: '500' },

  // Headings & Links (Markdown)
  { tag: tags.heading, color: '#79c0ff', fontWeight: 'bold' },
  { tag: tags.link, color: '#58a6ff', textDecoration: 'underline' },
  { tag: tags.url, color: '#8b949e' },
]);

/**
 * Mediobot-Native Crisp Light Syntax Theme.
 * High-contrast, clean studio palette with paper-white surfaces and vivid syntax highlighting.
 */
export const mediobotLightEditorTheme = EditorView.theme(
  {
    '&': {
      color: '#1e293b',
      backgroundColor: '#ffffff',
      fontSize: '13px',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      height: '100%',
    },
    '.cm-content': {
      caretColor: '#0284c7',
      padding: '12px 16px 12px 4px',
      lineHeight: '1.6',
    },
    '&.cm-focused .cm-cursor': {
      borderLeftColor: '#0284c7',
      borderLeftWidth: '2px',
    },
    '&.cm-focused .cm-selectionBackground, ::selection': {
      backgroundColor: '#bae6fd77',
    },
    '.cm-selectionMatch': {
      backgroundColor: '#e0f2fe99',
      borderRadius: '2px',
    },
    '.cm-gutters': {
      backgroundColor: '#f8fafc',
      color: '#94a3b8',
      borderRight: '1px solid #e2e8f0',
      paddingRight: '8px',
      userSelect: 'none',
    },
    '.cm-lineNumbers .cm-gutterElement': {
      minWidth: '40px',
      textAlign: 'right',
      paddingRight: '12px',
      fontSize: '12px',
    },
    '.cm-activeLine': {
      backgroundColor: '#f1f5f988',
    },
    '.cm-activeLineGutter': {
      backgroundColor: '#e2e8f099',
      color: '#0f172a',
      fontWeight: '600',
    },
    '.cm-scroller': {
      overflow: 'auto',
      fontFamily: 'inherit',
    },
  },
  { dark: false },
);

export const mediobotLightHighlightStyle = HighlightStyle.define([
  // Comments: Muted slate, italic
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: '#64748b', fontStyle: 'italic' },

  // Strings & regex: Rich emerald green
  { tag: [tags.string, tags.special(tags.string)], color: '#047857' },
  { tag: [tags.regexp, tags.escape], color: '#0369a1' },

  // Numbers: Warm amber
  { tag: [tags.number, tags.integer, tags.float], color: '#b45309' },

  // Keywords & Control flow: Crisp indigo / violet
  { tag: [tags.keyword, tags.controlKeyword, tags.modifier], color: '#6d28d9', fontWeight: '500' },
  { tag: [tags.moduleKeyword], color: '#6d28d9', fontWeight: '600' },

  // Types & Classes: Rose / crimson
  { tag: [tags.typeName, tags.className, tags.namespace], color: '#be123c', fontWeight: '500' },

  // Functions & Methods: Vibrant blue
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: '#0369a1' },

  // Properties & Fields: Slate blue
  { tag: [tags.propertyName, tags.definition(tags.propertyName)], color: '#0284c7' },

  // Constants, Booleans, Null: Teal
  { tag: [tags.constant(tags.variableName), tags.bool, tags.null], color: '#0f766e', fontWeight: '600' },

  // Operators: Rose red
  { tag: [tags.operator, tags.arithmeticOperator, tags.logicOperator, tags.bitwiseOperator], color: '#e11d48' },

  // Punctuation & Delimiters: Slate
  { tag: [tags.punctuation, tags.separator], color: '#475569' },
  { tag: [tags.paren, tags.bracket, tags.brace], color: '#334155' },

  // Tags (HTML / JSX / TSX)
  { tag: [tags.tagName], color: '#047857' },
  { tag: [tags.angleBracket], color: '#475569' },

  // Attributes
  { tag: [tags.attributeName], color: '#0284c7' },
  { tag: [tags.attributeValue], color: '#047857' },

  // Variable names: Deep charcoal
  { tag: [tags.variableName], color: '#1e293b' },
  { tag: [tags.definition(tags.variableName)], color: '#0f172a', fontWeight: '500' },

  // Headings & Links
  { tag: tags.heading, color: '#0369a1', fontWeight: 'bold' },
  { tag: tags.link, color: '#0284c7', textDecoration: 'underline' },
  { tag: tags.url, color: '#475569' },
]);

export const mediobotSyntaxTheme: Extension = [
  mediobotEditorTheme,
  syntaxHighlighting(mediobotHighlightStyle),
];

export function getMediobotSyntaxTheme(theme: 'dark' | 'light'): Extension {
  return theme === 'light'
    ? [mediobotLightEditorTheme, syntaxHighlighting(mediobotLightHighlightStyle)]
    : [mediobotEditorTheme, syntaxHighlighting(mediobotHighlightStyle)];
}
