// SPDX-License-Identifier: AGPL-3.0-only
// WebGL2 backend. Textures hold the bottom row first (the oracle's row-from-bottom), so uploads flip; reads flip back.
// Intermediates are half-float RGBA16F (§48) when a float colour buffer extension exists (else RGBA8); the last pass of a
// chain is RGBA8. Released textures go to a pool keyed by size and format and are reused by the next upload, pass or aux
// table (T10 fix round 1 N2): every pass overwrites its whole target, so reuse does not change the output.
import { GLSL_VERTEX, programSource } from './shaders';
import { createRenderer, isRawPixels, quantise, sourceSize, type Backend, type EffectRenderer, type Frame, type PassSpec, type PixelSource } from './renderer';
import type { AuxTable } from './uniforms';

interface GlProgram { program: WebGLProgram; params: WebGLUniformLocation | null; src: WebGLUniformLocation | null; aux: WebGLUniformLocation | null }
/** Pool bounds: textures kept per size and format, and size / format keys kept (the oldest key is dropped first). */
const POOL_PER_KEY = 4, POOL_KEYS = 8;
const poolKey = (width: number, height: number, float: boolean) => `${width}x${height}${float ? 'f' : ''}`;

function compile(gl: WebGL2RenderingContext, type: number, source: string, id: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, source);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error(`GLSL compile failed for '${id}': ${log}`);
  }
  return s;
}

/** Bottom-row-first copy of top-row-first RGBA rows (the same operation flips either way). */
function flipRows<T extends Uint8Array | Float32Array>(data: T, width: number, height: number): T {
  const row = width * 4, out = new (data.constructor as new (n: number) => T)(row * height);
  for (let r = 0; r < height; r++) out.set(data.subarray((height - 1 - r) * row, (height - r) * row), r * row);
  return out;
}

export class WebGL2Backend implements Backend {
  readonly kind = 'webgl2' as const;
  readonly floatTargets: boolean;
  private readonly programs = new Map<string, GlProgram>();
  private readonly vao: WebGLVertexArrayObject;
  private readonly fbo: WebGLFramebuffer;
  private readonly readFbo: WebGLFramebuffer;
  private readonly dummy: WebGLTexture;
  private readonly pool = new Map<string, WebGLTexture[]>();
  private vertex?: WebGLShader;

  constructor(readonly gl: WebGL2RenderingContext) {
    this.floatTargets = !!gl.getExtension('EXT_color_buffer_float') || !!gl.getExtension('EXT_color_buffer_half_float');
    this.vao = gl.createVertexArray()!;
    this.fbo = gl.createFramebuffer()!;
    this.readFbo = gl.createFramebuffer()!;
    this.dummy = this.texture(1, 1, false, new Uint8Array(4));
  }

  private texture(width: number, height: number, float: boolean, data: ArrayBufferView | null): WebGLTexture {
    const gl = this.gl, reused = this.pool.get(poolKey(width, height, float))?.pop();
    if (reused) {
      gl.bindTexture(gl.TEXTURE_2D, reused);
      this.unpack();
      if (data) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, float ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, data);
      return reused;
    }
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.unpack();
    if (float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, data);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    return t;
  }

  private unpack() {
    const gl = this.gl;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  }

  upload(source: PixelSource): Frame {
    const gl = this.gl;
    if (isRawPixels(source)) {
      const { width, height } = source;
      const bytes = new Uint8Array(source.data.buffer, source.data.byteOffset, width * height * 4);
      return { width, height, format: 'rgba8', texture: this.texture(width, height, false, flipRows(bytes, width, height)) };
    }
    // UNPACK_FLIP_Y is ignored for ImageBitmap, so every source lands top row first and one blit flips it.
    const { width, height } = sourceSize(source);
    const top = this.texture(width, height, false, null);
    // A tainted source throws a SecurityError (T10 CANVAS_TAINTED): the pooled texture goes back before it propagates.
    try { gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source as TexImageSource); } catch (e) { this.recycle(top, poolKey(width, height, false)); throw e; }
    const t = this.texture(width, height, false, null);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.readFbo);
    gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, top, 0);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    gl.disable(gl.SCISSOR_TEST);
    gl.blitFramebuffer(0, 0, width, height, 0, height, width, 0, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    this.recycle(top, poolKey(width, height, false));
    return { width, height, format: 'rgba8', texture: t };
  }

  /** Returns a texture to the pool (or deletes it when its key is full). */
  private recycle(t: WebGLTexture, key: string) {
    let list = this.pool.get(key);
    if (!list) {
      if (this.pool.size >= POOL_KEYS) {
        const [oldest, old] = this.pool.entries().next().value!;
        for (const x of old) this.gl.deleteTexture(x);
        this.pool.delete(oldest);
      }
      this.pool.set(key, list = []);
    }
    if (list.length < POOL_PER_KEY) list.push(t); else this.gl.deleteTexture(t);
  }

  private program(id: string): GlProgram {
    const hit = this.programs.get(id);
    if (hit) return hit;
    const gl = this.gl;
    this.vertex ??= compile(gl, gl.VERTEX_SHADER, GLSL_VERTEX, 'vertex');
    const fs = compile(gl, gl.FRAGMENT_SHADER, programSource(id, 'glsl'), id), program = gl.createProgram()!;
    gl.attachShader(program, this.vertex);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error(`GLSL link failed for '${id}': ${gl.getProgramInfoLog(program)}`);
    const p = { program, params: gl.getUniformLocation(program, 'fxP'), src: gl.getUniformLocation(program, 'fxSrc'), aux: gl.getUniformLocation(program, 'fxAux') };
    this.programs.set(id, p);
    return p;
  }

  /** Compile and link one program now (tests and warm-up); throws the info log on failure. */
  prepare(id: string) { this.program(id); }

  pass(input: Frame, spec: PassSpec): Frame {
    const gl = this.gl, p = this.program(spec.program);
    const float = !spec.final && this.floatTargets;
    const out = this.texture(spec.width, spec.height, float, null);
    const aux = spec.aux ? this.auxTexture(spec.aux) : null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, out, 0);
    gl.viewport(0, 0, spec.width, spec.height);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(p.program);
    gl.uniform4fv(p.params, spec.uniforms);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, input.texture as WebGLTexture);
    gl.uniform1i(p.src, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, aux ?? this.dummy);
    gl.uniform1i(p.aux, 1);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(gl.TEXTURE0);
    if (aux) this.recycle(aux, poolKey(spec.aux!.width, spec.aux!.height, false));
    return { width: spec.width, height: spec.height, format: float ? 'rgba16f' : 'rgba8', texture: out };
  }

  private auxTexture(aux: AuxTable): WebGLTexture { return this.texture(aux.width, aux.height, false, aux.data); }

  async read(frame: Frame): Promise<Uint8Array> {
    const gl = this.gl, { width, height } = frame;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, frame.texture as WebGLTexture, 0);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    let bytes: Uint8Array;
    if (frame.format === 'rgba16f') { // RGBA/FLOAT is always readable from a float colour buffer
      const f = new Float32Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, f);
      bytes = quantise(f);
    } else {
      bytes = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return flipRows(bytes, width, height);
  }

  release(frame: Frame) { this.recycle(frame.texture as WebGLTexture, poolKey(frame.width, frame.height, frame.format === 'rgba16f')); }

  dispose() {
    const gl = this.gl;
    for (const list of this.pool.values()) for (const t of list) gl.deleteTexture(t);
    this.pool.clear();
    for (const p of this.programs.values()) gl.deleteProgram(p.program);
    this.programs.clear();
    if (this.vertex) gl.deleteShader(this.vertex);
    gl.deleteVertexArray(this.vao);
    gl.deleteFramebuffer(this.fbo);
    gl.deleteFramebuffer(this.readFbo);
    gl.deleteTexture(this.dummy);
  }
}

/** WebGL2 effect renderer on `gl`, or on a private OffscreenCanvas context. */
export function createWebGL2Renderer(gl?: WebGL2RenderingContext): EffectRenderer & { gpu: WebGL2Backend } {
  const context = gl ?? new OffscreenCanvas(1, 1).getContext('webgl2', { premultipliedAlpha: false, antialias: false, depth: false, stencil: false });
  if (!context) throw new Error('WebGL2 is not available');
  const gpu = new WebGL2Backend(context);
  return { ...createRenderer(gpu), gpu };
}
