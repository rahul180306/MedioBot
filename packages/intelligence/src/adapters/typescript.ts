import ts from "typescript";
import type { ExtractedSymbol, ExtractedDependency, ParsedFile, LanguageAdapter, SymbolKind } from "../types.ts";

export class TypeScriptAdapter implements LanguageAdapter {
  readonly name = "typescript";
  readonly fileExtensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"] as const;

  canParse(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return this.fileExtensions.some((ext) => lower.endsWith(ext));
  }

  parse(filePath: string, content: string): ParsedFile {
    const errors: string[] = [];
    const symbols: ExtractedSymbol[] = [];
    const dependencies: ExtractedDependency[] = [];

    const scriptKind = this.getScriptKind(filePath);
    let sourceFile: ts.SourceFile;

    try {
      sourceFile = ts.createSourceFile(
        filePath,
        content,
        ts.ScriptTarget.Latest,
        true,
        scriptKind
      );
    } catch (err) {
      return {
        filePath,
        language: scriptKind === ts.ScriptKind.JS || scriptKind === ts.ScriptKind.JSX ? "javascript" : "typescript",
        lineCount: countLines(content),
        symbols: [],
        dependencies: [],
        errors: [err instanceof Error ? err.message : String(err)],
      };
    }

    const isJs = scriptKind === ts.ScriptKind.JS || scriptKind === ts.ScriptKind.JSX;
    const language = isJs ? "javascript" : "typescript";
    const lineCount = countLines(content);

    const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean => {
      const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
      return !!modifiers?.some((m) => m.kind === kind);
    };

    const getSignature = (node: ts.Node): string | undefined => {
      try {
        const text = node.getText(sourceFile);
        const firstBrace = text.indexOf("{");
        const firstSemi = text.indexOf(";");
        const cut = Math.min(
          firstBrace > 0 ? firstBrace : Infinity,
          firstSemi > 0 ? firstSemi : Infinity
        );
        if (cut < Infinity) {
          return text.slice(0, cut).trim();
        }
        return text.split("\n")[0]?.trim();
      } catch {
        return undefined;
      }
    };

    const getDocComment = (node: ts.Node): string | undefined => {
      try {
        const fullText = sourceFile.getFullText();
        const ranges = ts.getLeadingCommentRanges(fullText, node.getFullStart());
        if (!ranges || ranges.length === 0) return undefined;
        const lastRange = ranges[ranges.length - 1];
        if (!lastRange) return undefined;
        const comment = fullText.slice(lastRange.pos, lastRange.end).trim();
        return comment;
      } catch {
        return undefined;
      }
    };

    const addSymbol = (
      name: string,
      kind: SymbolKind,
      node: ts.Node,
      isExported: boolean,
      parentSymbolId?: number
    ) => {
      if (!name) return;
      const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
      symbols.push({
        name,
        kind,
        filePath,
        startLine: start.line + 1,
        endLine: end.line + 1,
        character: start.character,
        signature: getSignature(node),
        isExported,
        parentSymbolId,
        docComment: getDocComment(node),
      });
    };

    const visit = (node: ts.Node) => {
      try {
        if (ts.isFunctionDeclaration(node)) {
          const name = node.name?.text ?? (hasModifier(node, ts.SyntaxKind.DefaultKeyword) ? "default" : "");
          if (name) {
            addSymbol(name, "function", node, hasModifier(node, ts.SyntaxKind.ExportKeyword));
          }
        } else if (ts.isClassDeclaration(node)) {
          const name = node.name?.text ?? (hasModifier(node, ts.SyntaxKind.DefaultKeyword) ? "default" : "");
          if (name) {
            const isExported = hasModifier(node, ts.SyntaxKind.ExportKeyword);
            addSymbol(name, "class", node, isExported);
            // Methods and members
            for (const member of node.members) {
              if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
                addSymbol(member.name.text, "method", member, false);
              }
            }
          }
        } else if (ts.isInterfaceDeclaration(node)) {
          addSymbol(node.name.text, "interface", node, hasModifier(node, ts.SyntaxKind.ExportKeyword));
        } else if (ts.isTypeAliasDeclaration(node)) {
          addSymbol(node.name.text, "type", node, hasModifier(node, ts.SyntaxKind.ExportKeyword));
        } else if (ts.isEnumDeclaration(node)) {
          addSymbol(node.name.text, "constant", node, hasModifier(node, ts.SyntaxKind.ExportKeyword));
        } else if (ts.isVariableStatement(node)) {
          const isExported = hasModifier(node, ts.SyntaxKind.ExportKeyword);
          const isConst = (node.declarationList.flags & ts.NodeFlags.Const) !== 0;
          for (const decl of node.declarationList.declarations) {
            if (ts.isIdentifier(decl.name)) {
              addSymbol(decl.name.text, isConst ? "constant" : "variable", decl, isExported);
            }
          }
        } else if (ts.isModuleDeclaration(node)) {
          if (ts.isIdentifier(node.name)) {
            addSymbol(node.name.text, "module", node, hasModifier(node, ts.SyntaxKind.ExportKeyword));
          }
        } else if (ts.isExportAssignment(node)) {
          // export default ...
          addSymbol("default", "variable", node, true);
        } else if (ts.isExportDeclaration(node)) {
          // Re-exports: export { foo, bar } from './baz' or export * from './baz'
          if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
            const specifier = node.moduleSpecifier.text;
            const names: string[] = [];
            if (node.exportClause && ts.isNamedExports(node.exportClause)) {
              for (const elem of node.exportClause.elements) {
                names.push(elem.name.text);
                addSymbol(elem.name.text, "variable", elem, true);
              }
            } else {
              names.push("*");
            }
            dependencies.push({
              importPath: specifier,
              importedNames: names,
              isTypeOnly: node.isTypeOnly,
            });
          }
        } else if (ts.isImportDeclaration(node)) {
          if (ts.isStringLiteral(node.moduleSpecifier)) {
            const specifier = node.moduleSpecifier.text;
            const importedNames: string[] = [];
            let isTypeOnly = node.importClause?.isTypeOnly ?? false;

            if (node.importClause) {
              if (node.importClause.name) {
                importedNames.push(node.importClause.name.text);
              }
              const namedBindings = node.importClause.namedBindings;
              if (namedBindings) {
                if (ts.isNamedImports(namedBindings)) {
                  for (const element of namedBindings.elements) {
                    importedNames.push(element.name.text);
                  }
                } else if (ts.isNamespaceImport(namedBindings)) {
                  importedNames.push(namedBindings.name.text);
                }
              }
            }

            dependencies.push({
              importPath: specifier,
              importedNames,
              isTypeOnly,
            });
          }
        } else if (ts.isCallExpression(node)) {
          // require('...') or dynamic import('...')
          if (ts.isIdentifier(node.expression) && node.expression.text === "require" && node.arguments.length > 0) {
            const arg = node.arguments[0];
            if (arg && ts.isStringLiteral(arg)) {
              dependencies.push({
                importPath: arg.text,
                importedNames: ["*"],
                isTypeOnly: false,
              });
            }
          } else if (node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length > 0) {
            const arg = node.arguments[0];
            if (arg && ts.isStringLiteral(arg)) {
              dependencies.push({
                importPath: arg.text,
                importedNames: ["*"],
                isTypeOnly: false,
              });
            }
          }
        }
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    return {
      filePath,
      language,
      lineCount,
      symbols,
      dependencies,
      errors,
    };
  }

  private getScriptKind(filePath: string): ts.ScriptKind {
    const lower = filePath.toLowerCase();
    if (lower.endsWith(".tsx")) return ts.ScriptKind.TSX;
    if (lower.endsWith(".jsx")) return ts.ScriptKind.JSX;
    if (lower.endsWith(".ts") || lower.endsWith(".mts") || lower.endsWith(".cts")) return ts.ScriptKind.TS;
    if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return ts.ScriptKind.JS;
    return ts.ScriptKind.Unknown;
  }
}

function countLines(content: string): number {
  if (!content) return 0;
  let count = 1;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) count++;
  }
  return count;
}
