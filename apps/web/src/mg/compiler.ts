// SPDX-License-Identifier: AGPL-3.0-only
import * as Babel from '@babel/standalone';
import { compilationError, MotionGraphicError } from './errors';
import { MEDIA_REFUSALS, SENSITIVE_KEYS, UNSAFE_TAGS } from './policy';
import { assetIdRefusal } from './agent-checks';
export { MEDIA_REFUSALS } from './policy';
export type CompiledGraphic = { js: string; name: string };
// Xapp's R3 text (reference compares §1.4); the compile error prefix is added by compilationError.
export const EXPORT_REFUSAL = 'Put every helper (constants, components, functions) above the exported component and end the code with it: `export const MyAnimation = () => { … };` must be the last statement, with nothing after it.';
export function compileMotionGraphic(code: string, assetMap?: Record<string, string>): CompiledGraphic {
  if (typeof code !== 'string' || !code.trim()) throw compilationError(Error('Compiled code did not produce a valid React component'));
  if (code.length > 256 * 1024) throw new MotionGraphicError('MG_MEMORY_LIMIT', 'Motion graphic source exceeds the 256 KiB limit.');
  const assetProblem = assetMap && assetIdRefusal(code, Object.keys(assetMap).map(agentId => ({ agentId, id: agentId })));
  if (assetProblem) throw new MotionGraphicError('VALIDATION_ERROR', assetProblem);
  let name = 'MotionGraphic';
  try {
    const result = Babel.transform(code, { filename: 'motion-graphic.tsx', sourceType: 'module', presets: [['typescript', { allExtensions: true, isTSX: true }], ['react', { runtime: 'classic' }]], plugins: [({ types: t }: any) => ({ visitor: {
      Program: {
        enter(path: any) {
          for (const item of path.get('body')) if (item.isImportDeclaration()) item.remove();
          const body = path.node.body, last = body.at(-1), exports = body.filter((node: any) => t.isExportDeclaration(node));
          if (exports.length) {
            if (exports.length !== 1 || !t.isExportNamedDeclaration(last) || !t.isVariableDeclaration(last.declaration) || last.declaration.kind !== 'const' || last.declaration.declarations.length !== 1) throw Error(EXPORT_REFUSAL);
            const declaration = last.declaration.declarations[0]; if (!t.isIdentifier(declaration.id)) throw Error(EXPORT_REFUSAL);
            name = declaration.id.name; body[body.length - 1] = last.declaration; body.push(t.returnStatement(t.identifier(name)));
          } else if (t.isVariableDeclaration(last) && last.declarations.length === 1 && t.isIdentifier(last.declarations[0].id)) { name = last.declarations[0].id.name; body.push(t.returnStatement(t.identifier(name))); }
          else if (t.isFunctionDeclaration(last) && last.id) { name = last.id.name; body.push(t.returnStatement(t.identifier(name))); }
          else if (t.isExpressionStatement(last)) body[body.length - 1] = t.returnStatement(last.expression);
          else throw Error('Compiled code did not produce a valid React component');
        },
      },
      JSXOpeningElement(path: any) {
        if (t.isJSXIdentifier(path.node.name) && Object.hasOwn(MEDIA_REFUSALS, path.node.name.name)) throw new MotionGraphicError('VALIDATION_ERROR', MEDIA_REFUSALS[path.node.name.name as keyof typeof MEDIA_REFUSALS]);
        const tag = path.node.name.name;
        if (UNSAFE_TAGS.includes(tag)) throw new MotionGraphicError('VALIDATION_ERROR', `Unsafe <${tag}> element is not supported.`);
        for (const a of path.node.attributes) if (a.name?.name === 'dangerouslySetInnerHTML') throw new MotionGraphicError('VALIDATION_ERROR', 'dangerouslySetInnerHTML is not supported.');
      },
      CallExpression(path: any) {
        if (t.isImport(path.node.callee) || t.isIdentifier(path.node.callee, { name: 'eval' })) throw new MotionGraphicError('VALIDATION_ERROR', 'Dynamic code execution is not supported.');
      },
      Identifier(path: any) {
        if (path.isReferencedIdentifier() && !path.scope.hasBinding(path.node.name) && ['Function', 'AsyncFunction', 'GeneratorFunction', 'AsyncGeneratorFunction', 'WebAssembly', 'SharedArrayBuffer', 'Atomics', 'Worker', 'SharedWorker', 'Reflect','frames','parent','top','opener'].includes(path.node.name)) throw new MotionGraphicError('VALIDATION_ERROR', `Unsafe capability '${path.node.name}' is not supported.`);
        if (path.node.loc && path.node.name.startsWith('__mg')) throw new MotionGraphicError('VALIDATION_ERROR', 'Names beginning __mg are reserved by the runtime.');
      },
      'MemberExpression|OptionalMemberExpression'(path: any) {
        const prop = path.node.property;
        if ((!path.node.computed && SENSITIVE_KEYS.includes(prop.name)) || path.node.computed && t.isStringLiteral(prop) && SENSITIVE_KEYS.includes(prop.value)) throw new MotionGraphicError('VALIDATION_ERROR', 'Unsafe property access is not supported.');
        if (path.node.computed) path.node.property = t.callExpression(t.identifier('__mgKey'), [prop]);
      },
      ObjectProperty(path: any) {
        if (path.node.computed) path.node.key = t.callExpression(t.identifier('__mgKey'), [path.node.key]);
        else if (path.parentPath.isObjectPattern() && SENSITIVE_KEYS.includes(path.node.key.name ?? path.node.key.value)) throw new MotionGraphicError('VALIDATION_ERROR', 'Unsafe property destructuring is not supported.');
      },
      Loop: { exit(path: any) { const guard = t.expressionStatement(t.callExpression(t.identifier('__mgTick'), [])); if (!t.isBlockStatement(path.node.body)) path.node.body = t.blockStatement([path.node.body]); path.node.body.body.unshift(guard); } },
      Function: { exit(path: any) { if (path.node.async || path.node.generator) throw new MotionGraphicError('VALIDATION_ERROR', 'Async and generator functions are not supported in motion graphics.'); if (!t.isBlockStatement(path.node.body)) path.node.body = t.blockStatement([t.returnStatement(path.node.body)]); path.node.body.body.unshift(t.expressionStatement(t.callExpression(t.identifier('__mgTick'), []))); } },
    } }) as any], parserOpts: { allowReturnOutsideFunction: true }, generatorOpts: { comments: false } });
    return { js: result.code ?? '', name };
  } catch (error) {
    if (error instanceof MotionGraphicError) { // Babel prefixes plugin errors with a filename.
      const prefix = error.message.indexOf('compilation error:'); if (prefix >= 0) error.message = error.message.slice(prefix);
      error.message = error.message.replace(/^.*?motion-graphic\.tsx:\s*/, '');
      throw error;
    }
    if (error instanceof Error) error.message = error.message.replace(/^.*?motion-graphic\.tsx:\s*/, '');
    throw compilationError(error);
  }
}
