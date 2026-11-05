// SPDX-License-Identifier: AGPL-3.0-only
import { MotionGraphicError } from './errors';
import { SENSITIVE_KEYS, UNSAFE_TAGS } from './policy';

// Capture capabilities before installing guards. Only the bootstrap retains these references.
const NativeProxy = Proxy, functionPrototype = Function.prototype, apply = Reflect.apply, construct = Reflect.construct;
export { apply };
const define = Object.defineProperty, descriptor = Object.getOwnPropertyDescriptor, hasOwn = Object.hasOwn;
const nativeString = String, nativeNumber = Number, nativeArray = Array, isArray = Array.isArray;
const lowerCase = String.prototype.toLowerCase, substring = String.prototype.substring, lastIndexOf = String.prototype.lastIndexOf;
const isView = ArrayBuffer.isView, Buffer = ArrayBuffer;
export const now = performance.now.bind(performance);
export const createElement = Document.prototype.createElement;
export const appendChild = Node.prototype.appendChild;
const createElementNS = Document.prototype.createElementNS;
export const timeout = setTimeout.bind(globalThis);
const interval = setInterval.bind(globalThis), animationFrame = requestAnimationFrame.bind(globalThis);
const frameCount = descriptor(globalThis, 'length')!.get!;
const sensitive: Record<PropertyKey, true> = Object.create(null);
for (const key of SENSITIVE_KEYS) sensitive[key] = true;
const unsafe: Record<string, true> = Object.create(null);
for (const name of UNSAFE_TAGS) unsafe[name] = true;

let fault: MotionGraphicError | undefined;
export function fail(code: string, message: string): never { fault ??= new MotionGraphicError(code, message); throw fault; }
export function checkFault(): void { if (fault) throw fault; }
export function currentFault(): MotionGraphicError | undefined { return fault; }
export function checkFrames(): void {
  if (apply(frameCount, globalThis, []) === 0) return;
  fault = new MotionGraphicError('MG_SANDBOX_DENIED', 'Child browsing contexts are blocked in the motion graphic sandbox.');
  throw fault;
}
function deny(): never { return fail('MG_SANDBOX_DENIED', 'This capability is blocked in the motion graphic sandbox.'); }
// A native function handed to a timer or an animation frame (a bound RegExp.prototype.test) runs no instrumented code,
// so the frame gets no tick for the time it burns. Scheduled callbacks call this hook on entry instead, and the frame
// charges that time to the graphic (FU2-B1). Set by sandbox-entry, which only arms it where nothing else can see the
// callback: in the output phase, after mg:out.
let scheduled: () => void = () => {};
export function onScheduled(hook: () => void): void { scheduled = hook; }
export function safeKey(key: unknown): PropertyKey {
  const value = typeof key === 'symbol' ? key : nativeString(key);
  if (sensitive[value]) deny();
  return value;
}

let allocated = 0;
const maxElements = 1_000_000, maxChars = 16 * 1024 * 1024, budget = 128 * 1024 * 1024;
function charge(bytes: number): void { if (bytes > 0 && (allocated += bytes) > budget) memory(); }
function memory(): never { return fail('MG_MEMORY_LIMIT', 'Motion graphic allocation exceeds the memory budget.'); }
function elements(value: unknown): number { const n = nativeNumber(value); if (n > maxElements || !Number.isFinite(n)) memory(); return Math.max(0, Math.trunc(n)); }
function chars(length: number): void { if (length > maxChars) memory(); charge(length * 2); }

export function installGuards(): void {
  const lock = (target: object, key: PropertyKey, value: unknown) => define(target, key, { value, writable: false, configurable: false });
  const charged = (callback: TimerHandler) => (...args: unknown[]) => { scheduled(); return apply(callback as (...a: unknown[]) => unknown, globalThis, args); };
  lock(globalThis, 'setTimeout', (callback: TimerHandler, delay?: number, ...args: unknown[]) => { if (typeof callback !== 'function') deny(); return timeout(charged(callback), delay, ...args); });
  lock(globalThis, 'setInterval', (callback: TimerHandler, delay?: number, ...args: unknown[]) => { if (typeof callback !== 'function') deny(); return interval(charged(callback), delay, ...args); });
  lock(globalThis, 'requestAnimationFrame', (callback: FrameRequestCallback) => { if (typeof callback !== 'function') deny(); return animationFrame(charged(callback)); });
  for (const name of ['fetch','XMLHttpRequest','WebSocket','WebSocketStream','WebTransport','EventSource','Worker','SharedWorker','RTCPeerConnection','webkitRTCPeerConnection','open','eval','Function','WebAssembly','XSLTProcessor','navigation','history','Proxy','showOpenFilePicker','showSaveFilePicker','showDirectoryPicker']) {
    try { lock(globalThis, name, deny); } catch { /* Non-configurable native restrictions remain in force. */ }
  }
  for (const proto of [functionPrototype, Object.getPrototypeOf(async function () {}), Object.getPrototypeOf(function* () {}), Object.getPrototypeOf(async function* () {})]) lock(proto, 'constructor', deny);
  for (const key of ['call','apply','bind'] as const) lock(functionPrototype, key, functionPrototype[key]);
  lock(Error, 'prepareStackTrace', undefined);
  lock(Navigator.prototype, 'sendBeacon', deny);
  for (const key of ['pushState','replaceState','go','back','forward']) lock(History.prototype, key, deny);
  const denySetter = (proto: object, key: string) => {
    const d = descriptor(proto, key);
    if (d?.set) define(proto, key, { ...d, set: deny, configurable: false });
  };
  for (const key of ['innerHTML','outerHTML']) denySetter(Element.prototype, key);
  denySetter(ShadowRoot.prototype, 'innerHTML');
  for (const [proto, keys] of [
    [Element.prototype, ['insertAdjacentHTML','setHTMLUnsafe','setHTML']],
    [ShadowRoot.prototype, ['setHTMLUnsafe','setHTML']],
    [Range.prototype, ['createContextualFragment']],
    [Document.prototype, ['write','writeln','open','execCommand']],
    [DOMParser.prototype, ['parseFromString']],
    [Document, ['parseHTMLUnsafe','parseHTML']],
  ] as const) for (const key of keys) if (key in proto) lock(proto, key, deny);
  const tag = (value: unknown) => {
    const name = nativeString(value), lower = apply(lowerCase, name, []);
    if (unsafe[apply(substring, lower, [apply(lastIndexOf, lower, [':']) + 1])]) deny();
    return name;
  };
  lock(Document.prototype, 'createElement', function (this: Document, name: string, options?: ElementCreationOptions) { return apply(createElement, this, [tag(name), options]); });
  lock(Document.prototype, 'createElementNS', function (this: Document, ns: string | null, name: string, options?: string | ElementCreationOptions) { return apply(createElementNS, this, [ns, tag(name), options]); });
  const createDocument = DOMImplementation.prototype.createDocument;
  lock(DOMImplementation.prototype, 'createDocument', function (this: DOMImplementation, ns: string | null, name: string, doctype?: DocumentType | null) { return apply(createDocument, this, [ns, tag(name), doctype]); });
  // This factory has a title argument, not an element name. Alternate HTML documents are unnecessary.
  lock(DOMImplementation.prototype, 'createHTMLDocument', deny);
  const nodeType = descriptor(Node.prototype, 'nodeType')!.get!, firstChild = descriptor(Node.prototype, 'firstChild')!.get!, nextSibling = descriptor(Node.prototype, 'nextSibling')!.get!;
  const localName = descriptor(Element.prototype, 'localName')!.get!, templateContent = descriptor(HTMLTemplateElement.prototype, 'content')!.get!, shadowRoot = descriptor(Element.prototype, 'shadowRoot')!.get!;
  const inspect = (node: Node): void => {
    try { apply(nodeType, node, []); } catch { return; } // Other append arguments become text, never elements.
    const pending = [node];
    while (pending.length) {
      const current = pending[pending.length - 1]; pending.length--;
      if (apply(nodeType, current, []) === 1) {
        const name = tag(apply(localName, current, []));
        if (name === 'template') pending[pending.length] = apply(templateContent, current, []);
        const shadow = apply(shadowRoot, current, []); if (shadow) pending[pending.length] = shadow;
      }
      for (let child = apply(firstChild, current, []); child; child = apply(nextSibling, child, [])) pending[pending.length] = child;
    }
  };
  // One subtree check serves insertion, cloning and import; all traversal uses captured native getters.
  const wrap = (proto: object, key: string, indices: (args: any[]) => any[]) => {
    const original = (proto as any)[key]; if (!original) return;
    lock(proto, key, function (this: object, ...args: any[]) {
      for (const node of indices(args)) if (typeof node === 'object' && node !== null) inspect(node);
      return apply(original, this, args);
    });
  };
  for (const key of ['appendChild','insertBefore','replaceChild']) wrap(Node.prototype, key, args => [args[0]]);
  for (const proto of [Element.prototype, Document.prototype, DocumentFragment.prototype]) {
    for (const key of ['append','prepend','replaceChildren']) wrap(proto, key, args => args);
  }
  for (const proto of [Element.prototype, CharacterData.prototype, DocumentType.prototype]) {
    for (const key of ['before','after','replaceWith']) wrap(proto, key, args => args);
  }
  wrap(Element.prototype, 'insertAdjacentElement', args => [args[1]]);
  wrap(Document.prototype, 'importNode', args => [args[0]]);
  wrap(Document.prototype, 'adoptNode', args => [args[0]]);
  for (const key of ['insertNode','surroundContents']) wrap(Range.prototype, key, args => [args[0]]);
  const cloneNode = Node.prototype.cloneNode;
  lock(Node.prototype, 'cloneNode', function (this: Node, deep?: boolean) { inspect(this); return apply(cloneNode, this, [deep]); });
  const cloneContents = Range.prototype.cloneContents;
  for (const key of ['cloneContents','extractContents'] as const) {
    const original = Range.prototype[key];
    lock(Range.prototype, key, function (this: Range) { inspect(apply(cloneContents, this, [])); return apply(original, this, []); });
  }
  addEventListener('beforeunload', () => { fault ??= new MotionGraphicError('MG_SANDBOX_DENIED', 'Navigation from the motion graphic sandbox is blocked.'); });

  const arrayArgs = (args: unknown[]) => { if (args.length === 1 && typeof args[0] === 'number') charge(elements(args[0]) * 8); else charge(elements(args.length) * 8); };
  lock(globalThis, 'Array', new NativeProxy(nativeArray, {
    apply(target, receiver, args) { arrayArgs(args); return apply(target, receiver, args); },
    construct(target, args) { arrayArgs(args); return construct(target, args); },
  }));
  // Snapshot array-like lengths before native allocation; iterables are bounded during iteration.
  const snapshot = (source: any): any[] => {
    const out: any[] = [];
    if (source[Symbol.iterator]) { for (const value of source) { if (out.length >= maxElements) memory(); charge(8); out.push(value); } }
    else { const length = elements(source.length); charge(length * 8); for (let i = 0; i < length; i++) out.push(source[i]); }
    return out;
  };
  const from = nativeArray.from, of = nativeArray.of;
  lock(nativeArray, 'from', function (source: any, ...args: any[]) { return apply(from, nativeArray, [snapshot(source), ...args]); });
  lock(nativeArray, 'of', (...args: any[]) => { charge(elements(args.length) * 8); return apply(of, nativeArray, args); });
  const allocating = ['map','filter','slice','concat','flat','flatMap','toReversed','toSorted','toSpliced','with'];
  const methods = [...allocating, 'fill','copyWithin','sort','reverse','push','unshift','splice','join'];
  for (const key of methods) {
    const original = (nativeArray.prototype as any)[key];
    if (!original) continue;
    lock(nativeArray.prototype, key, function (this: any, ...args: any[]) {
      const length = elements(this.length);
      // Generic array methods must not re-read a user-controlled length during a native allocation.
      const mutating = ['fill','copyWithin','sort','reverse','push','unshift','splice'].includes(key);
      if (!isArray(this) && mutating && !isView(this)) { const d = descriptor(this, 'length'); if (!d || !hasOwn(d, 'value')) memory(); }
      const receiver = isArray(this) || mutating ? this : snapshot(this);
      if (key === 'push' || key === 'unshift' || key === 'splice' || key === 'toSpliced') { elements(length + args.length); charge(args.length * 8); }
      if (key === 'join') {
        const separator = args[0] === undefined ? ',' : nativeString(args[0]); let total = Math.max(0, length - 1) * separator.length;
        if (total > maxChars) memory();
        const strings: string[] = [];
        for (let i = 0; i < length; i++) { const value = receiver[i]; const s = value == null || value === receiver ? '' : nativeString(value); total += s.length; if (total > maxChars) memory(); strings[i] = s; }
        chars(total); return apply(original, strings, [separator]);
      }
      const result: any = apply(original, receiver, args);
      if (allocating.includes(key) || key === 'splice') charge(elements(result.length) * 8);
      return result;
    });
  }
  for (const key of ['keys','values','entries',Symbol.iterator]) {
    const original = (nativeArray.prototype as any)[key];
    lock(nativeArray.prototype, key, function (this: any) {
      elements(this.length); const iterator: any = apply(original, this, []), next = iterator.next; let count = 0;
      return { next() { if (count >= maxElements) { const value: any = apply(next, iterator, []); if (!value.done) memory(); return value; } const value: any = apply(next, iterator, []); if (!value.done) { count++; charge(8); } return value; }, [Symbol.iterator]() { return this; } };
    });
  }
  for (const name of ['ArrayBuffer','Uint8Array','Uint8ClampedArray','Uint16Array','Uint32Array','Int8Array','Int16Array','Int32Array','Float32Array','Float64Array','BigInt64Array','BigUint64Array'] as const) {
    const ctor = globalThis[name];
    lock(globalThis, name, new NativeProxy(ctor, { construct(target, args) {
      const safe = [...args];
      if (name === 'ArrayBuffer') safe[0] = elements(safe[0] ?? 0);
      else if (safe[0] !== undefined && typeof safe[0] !== 'object') safe[0] = elements(safe[0]);
      else if (safe[0] != null && !(safe[0] instanceof Buffer)) safe[0] = snapshot(safe[0]);
      if (name === 'ArrayBuffer' && safe[1] != null) { const maximum = safe[1].maxByteLength; safe[1] = maximum === undefined ? {} : { maxByteLength: elements(maximum) }; }
      const result = construct(target, safe);
      if (!(safe[0] instanceof Buffer)) charge(result.byteLength);
      elements(result.length ?? result.byteLength); return result;
    } }));
  }
  for (const proto of [Buffer.prototype, Object.getPrototypeOf(Uint8Array.prototype)]) {
    for (const key of ['slice','map','filter','toReversed','toSorted','with','transfer','transferToFixedLength']) {
      const original = (proto as any)[key]; if (!original) continue;
      lock(proto, key, function (this: any, ...args: any[]) { elements(this.length ?? this.byteLength); if (key.startsWith('transfer') && args[0] !== undefined) args[0] = elements(args[0]); const result: any = apply(original, this, args); charge(result.byteLength); return result; });
    }
  }
  for (const key of ['repeat','padStart','padEnd','concat','split','replace','replaceAll'] as const) {
    const original = String.prototype[key];
    lock(String.prototype, key, function (this: string, ...args: any[]) {
      const value = nativeString(this), length = value.length;
      if (key === 'repeat') { args[0] = Math.max(0, Math.trunc(nativeNumber(args[0]))); chars(length * args[0]); }
      if (key === 'padStart' || key === 'padEnd') { args[0] = Math.max(0, Math.trunc(nativeNumber(args[0]))); chars(Math.max(length, args[0])); }
      if (key === 'concat') { let total = length; for (let i = 0; i < args.length; i++) { args[i] = nativeString(args[i]); total += args[i].length; } chars(total); }
      if (key === 'split' && length + 1 > maxElements) memory();
      if ((key === 'replace' || key === 'replaceAll') && typeof args[1] === 'string') {
        // Conservative bound includes replacement substitutions that can repeat the source.
        const replacement = args[1] as string, matches = key === 'replaceAll' || args[0]?.global ? length + 1 : 1;
        let substitutions = 0; for (let i = 0; i < replacement.length - 1; i++) if (replacement[i] === '$' && /[&`'0-9]/.test(replacement[i + 1])) substitutions++;
        chars(length + matches * replacement.length + substitutions * matches * length);
      }
      const result = apply(original, value, args); if (typeof result === 'string') chars(result.length); else charge(elements(result.length) * 8); return result;
    });
  }
  const stringIterator = String.prototype[Symbol.iterator];
  lock(String.prototype, Symbol.iterator, function (this: string) { const value = nativeString(this); elements(value.length); charge(value.length * 8); return apply(stringIterator, value, []); });
}

const blocked: Record<string, unknown> = Object.create(null);
function blockedValue(name: string): unknown {
  return blocked[name] ??= new NativeProxy(function () {}, { get: deny, set: deny, apply: deny, construct: deny, defineProperty: deny, deleteProperty: deny, getPrototypeOf: deny, setPrototypeOf: deny, ownKeys: deny, getOwnPropertyDescriptor: deny });
}
export function scope(api: Record<string, unknown>, tick: () => void): object {
  const values = Object.assign(Object.create(null), api, { __mgTick: tick, __mgKey: safeKey });
  for (const name of ['Object','Math','JSON','Number','String','Boolean','Symbol','BigInt','Date','RegExp','Map','Set','WeakMap','WeakSet','Promise','Error','TypeError','RangeError','SyntaxError','ReferenceError','EvalError','URIError','AggregateError','parseInt','parseFloat','isNaN','isFinite','NaN','Infinity','undefined','encodeURI','decodeURI','encodeURIComponent','decodeURIComponent','console','Intl','atob','btoa','setTimeout','setInterval','clearTimeout','clearInterval','queueMicrotask','Array','ArrayBuffer','Uint8Array','Uint8ClampedArray','Uint16Array','Uint32Array','Int8Array','Int16Array','Int32Array','Float32Array','Float64Array','BigInt64Array','BigUint64Array','DataView']) values[name] = (globalThis as any)[name];
  return new NativeProxy(Object.create(null), { has: (_target, key) => typeof key === 'string', get: (_target, key) => typeof key === 'symbol' ? undefined : hasOwn(values, key) ? values[key] : blockedValue(key), set: deny, defineProperty: deny, deleteProperty: deny });
}
