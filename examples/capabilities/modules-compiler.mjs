import { parentPort, workerData } from 'node:worker_threads';
import { dirname, resolve, basename } from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';

const HELPER = 'jss:/.__runner/imports.js';
const DECLARATIONS = '/__jss_globals.d.ts';
const domGlobals = new Set([
  'AbortController', 'AbortSignal', 'Blob', 'File', 'FormData', 'URL', 'URLSearchParams',
  'TextEncoder', 'TextDecoder', 'Event', 'EventTarget', 'MessageEvent', 'CloseEvent', 'DOMException',
  'Headers', 'Request', 'Response', 'WebSocket', 'fetch', 'console', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'queueMicrotask', 'ReadableStream', 'ReadableByteStreamController',
  'ReadableStreamBYOBReader', 'ReadableStreamBYOBRequest', 'ReadableStreamDefaultController',
  'ReadableStreamDefaultReader', 'TransformStream', 'TransformStreamDefaultController', 'WritableStream',
  'WritableStreamDefaultController', 'WritableStreamDefaultWriter', 'ByteLengthQueuingStrategy', 'CountQueuingStrategy',
]);

function execute(data) {
  if (data.operation === 'inspect') {
    const ast = ts.createSourceFile('input.ts', data.source, ts.ScriptTarget.Latest, true,
      data.typescript ? ts.ScriptKind.TS : ts.ScriptKind.JS);
    if (ast.parseDiagnostics.length) {
      const errors = ast.parseDiagnostics.slice(0, 30).map(diagnostic => {
        const { line, character } = ast.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
        return data.url + ':' + (line + 1) + ':' + (character + 1) + ' TS' + diagnostic.code + ': ' + ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
      });
      throw new TypeError('TypeScript parsing failed:\n' + errors.join('\n'));
    }
    return [...specifiers(ast)];
  }
  if (!['compile', 'repl'].includes(data.operation)) throw new TypeError('Unknown compiler operation');
  const records = new Map(data.records.map(record => [record.url, {
    ...record, dependencies: new Map(record.dependencies),
  }]));
  const virtualFiles = new Map([...records.values()].map(record => [record.filename, record]));
  const globalSource = data.globals;
  const require = createRequire(import.meta.url);
  const libDirectory = dirname(require.resolve('typescript'));
  const libCache = new Map();
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    moduleDetection: ts.ModuleDetectionKind.Force,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts', 'lib.dom.asynciterable.d.ts'],
    strict: true,
    noEmit: true,
    allowJs: true,
    checkJs: false,
    allowImportingTsExtensions: true,
    skipLibCheck: true,
    types: [],
    noResolve: false,
    noUncheckedSideEffectImports: true,
    allowUnreachableCode: data.operation === 'repl' ? true : undefined,
  };
  function specifiers(sourceFile) {
    const results = new Map();
    const add = (name, runtime) => results.set(name, results.get(name) || runtime);
    const visit = (node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        if (node.attributes?.elements.length) throw new TypeError('Import attributes are not supported; only JavaScript and TypeScript modules are available');
        const typeOnly = ts.isImportDeclaration(node)
          ? node.importClause?.isTypeOnly || (!node.importClause?.name && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) && node.importClause.namedBindings.elements.every(item => item.isTypeOnly))
          : node.isTypeOnly || (node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.every(item => item.isTypeOnly));
        add(node.moduleSpecifier.text, !typeOnly);
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) {
        add(node.argument.literal.text, false);
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length && ts.isStringLiteralLike(node.arguments[0])) {
        add(node.arguments[0].text, true);
      } else if (ts.isImportEqualsDeclaration(node)) {
        throw new TypeError('CommonJS import assignments are not supported; use ES imports');
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return results;
  }

  function library(file) {
    const normalized = resolve(file);
    if (dirname(normalized) !== libDirectory || !/^lib\.[a-z\d.]+\.d\.ts$/i.test(basename(normalized))) return undefined;
    if (libCache.has(normalized)) return libCache.get(normalized);
    let source = ts.sys.readFile(normalized);
    if (source && basename(normalized) === 'lib.dom.d.ts') {
      const ast = ts.createSourceFile(normalized, source, ts.ScriptTarget.Latest, true);
      const statements = ast.statements.filter((node) => {
        if (ts.isFunctionDeclaration(node)) return node.name && domGlobals.has(node.name.text);
        if (ts.isVariableStatement(node)) return node.declarationList.declarations.every((item) => ts.isIdentifier(item.name) && domGlobals.has(item.name.text));
        return true;
      }).map((node) => ts.isInterfaceDeclaration(node) && node.name.text === 'ImportMeta'
        ? ts.factory.updateInterfaceDeclaration(node, node.modifiers, node.name, node.typeParameters, node.heritageClauses,
          node.members.filter(member => member.name && ts.isIdentifier(member.name) && member.name.text === 'url'))
        : node);
      source = ts.createPrinter().printFile(ts.factory.updateSourceFile(ast, statements));
    }
    libCache.set(normalized, source);
    return source;
  }
  function readFile(file) {
    if (file === DECLARATIONS) return globalSource;
    return virtualFiles.get(file)?.source ?? library(file);
  }
  function typecheck() {
    const compilerHost = {
      getSourceFile(file, languageVersion) {
        const source = readFile(file);
        return source === undefined ? undefined : ts.createSourceFile(file, source, languageVersion, true);
      },
      getDefaultLibFileName: () => resolve(libDirectory, 'lib.es2022.full.d.ts'),
      getCurrentDirectory: () => '/',
      getCanonicalFileName: file => file,
      useCaseSensitiveFileNames: () => true,
      getNewLine: () => '\n',
      fileExists: file => readFile(file) !== undefined,
      readFile,
      writeFile() {},
      resolveModuleNames(names, containingFile) {
        const parent = virtualFiles.get(containingFile);
        return names.map((name) => {
          const dependency = records.get(parent?.dependencies.get(name));
          if (!dependency) return undefined;
          return { resolvedFileName: dependency.filename, extension: dependency.declaration ? ts.Extension.Dts : dependency.typescript ? ts.Extension.Ts : ts.Extension.Js, isExternalLibraryImport: false };
        });
      },
    };
    const program = ts.createProgram([DECLARATIONS, ...virtualFiles.keys()], options, compilerHost);
    const diagnostics = ts.getPreEmitDiagnostics(program);
    if (diagnostics.length) {
      const messages = diagnostics.slice(0, 30).map((diagnostic) => {
        const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
        if (!diagnostic.file || diagnostic.start === undefined) return `TS${diagnostic.code}: ${message}`;
        const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
        const name = virtualFiles.get(diagnostic.file.fileName)?.url ?? diagnostic.file.fileName;
        return `${name}:${line + 1}:${character + 1} TS${diagnostic.code}: ${message}`;
      });
      if (diagnostics.length > messages.length) messages.push(`${diagnostics.length - messages.length} more diagnostics`);
      throw new TypeError(`TypeScript typecheck failed:\n${messages.join('\n')}`);
    }
  }

  function compile(record) {
    let helperName = '__jss_import_module';
    while (record.source.includes(helperName)) helperName += '_';
    let dynamic = false;
    const output = ts.transpileModule(record.source, {
      fileName: record.filename,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleDetection: ts.ModuleDetectionKind.Force, isolatedModules: true, sourceMap: false },
      transformers: { before: [(context) => {
        const f = context.factory;
        const visit = (node) => {
          if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
            return f.updateImportDeclaration(node, node.modifiers, node.importClause, f.createStringLiteral(record.dependencies.get(node.moduleSpecifier.text)), undefined);
          }
          if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
            return f.updateExportDeclaration(node, node.modifiers, node.isTypeOnly, node.exportClause, f.createStringLiteral(record.dependencies.get(node.moduleSpecifier.text)), undefined);
          }
          if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
            dynamic = true;
            return f.createCallExpression(f.createIdentifier(helperName), undefined, [
              ts.visitNode(node.arguments[0], visit), f.createStringLiteral(record.url),
              ...(node.arguments.length > 1 ? [ts.visitNode(node.arguments[1], visit)] : []),
            ]);
          }
          return ts.visitEachChild(node, visit, context);
        };
        return (sourceFile) => {
          const transformed = ts.visitNode(sourceFile, visit);
          if (!dynamic) return transformed;
          const declaration = f.createImportDeclaration(undefined,
            f.createImportClause(false, undefined, f.createNamedImports([
              f.createImportSpecifier(false, f.createIdentifier('importModule'), f.createIdentifier(helperName)),
            ])), f.createStringLiteral(HELPER));
          return f.updateSourceFile(transformed, [declaration, ...transformed.statements]);
        };
      }] },
    });
    return output.outputText;
  }


  function compileRepl(record) {
    let prefix = `__jss_repl_module_${data.cellIndex}`;
    while (record.source.includes(prefix)) prefix += '_';
    let importIndex = 0;
    const output = ts.transpileModule(data.cell, {
      fileName: record.filename,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleDetection: ts.ModuleDetectionKind.Force, isolatedModules: true, sourceMap: false },
      transformers: {
        before: [(context) => {
          const f = context.factory;
          const importCall = (specifier, options) => f.createCallExpression(f.createIdentifier(data.importHelper), undefined, [
            specifier, f.createStringLiteral(record.url), ...(options ? [options] : []),
          ]);
          const binding = (name, value) => f.createVariableStatement(undefined,
            f.createVariableDeclarationList([f.createVariableDeclaration(name, undefined, undefined, value)], ts.NodeFlags.Const));
          const imports = (node) => {
            const clause = node.importClause;
            if (clause?.isTypeOnly) return [];
            if (!clause) return [f.createExpressionStatement(f.createVoidExpression(f.createAwaitExpression(importCall(node.moduleSpecifier))))];
            const named = clause.namedBindings;
            const values = named && ts.isNamedImports(named) ? named.elements.filter(item => !item.isTypeOnly) : [];
            if (!clause.name && named && ts.isNamedImports(named) && !values.length && named.elements.length) return [];
            const local = f.createIdentifier(`${prefix}_${importIndex++}`);
            const result = [binding(local, f.createAwaitExpression(importCall(node.moduleSpecifier)))];
            if (clause.name) result.push(binding(clause.name, f.createPropertyAccessExpression(local, 'default')));
            if (named && ts.isNamespaceImport(named)) result.push(binding(named.name, local));
            for (const item of values) {
              const exported = item.propertyName ?? item.name;
              result.push(binding(item.name, f.createElementAccessExpression(local, f.createStringLiteral(exported.text))));
            }
            return result;
          };
          const visit = (node) => {
            if (ts.isExportDeclaration(node) || ts.isExportAssignment(node) || node.modifiers?.some(item => item.kind === ts.SyntaxKind.ExportKeyword)) {
              throw new TypeError('The REPL does not support exports; use a file module');
            }
            if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
              throw new TypeError('import.meta is available in file modules, not the REPL');
            }
            if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
              return importCall(ts.visitNode(node.arguments[0], visit), node.arguments[1] && ts.visitNode(node.arguments[1], visit));
            }
            return ts.visitEachChild(node, visit, context);
          };
          return (file) => {
            const declarations = [];
            const statements = [];
            for (const node of file.statements) {
              if (ts.isImportDeclaration(node)) declarations.push(...imports(node));
              else statements.push(ts.visitNode(node, visit));
            }
            return f.updateSourceFile(file, [...declarations, ...statements]);
          };
        }],
        after: [() => file => ts.factory.updateSourceFile(file, file.statements.filter(node => !ts.isExportDeclaration(node)))],
      },
    });
    return output.outputText;
  }

  typecheck();
  const emit = new Set(data.emit);
  const modules = [...records.values()].filter(record => !record.declaration && emit.has(record.url))
    .map(record => [record.url, compile(record)]);
  if (data.operation === 'repl') return { code: compileRepl(records.get(data.replURL)), modules };
  return modules;
}

if (!parentPort) throw new Error('The module compiler must run in a Worker');
try { parentPort.postMessage({ value: execute(workerData) }); }
catch (error) { parentPort.postMessage({ error: { name: error.name, message: error.message } }); }
