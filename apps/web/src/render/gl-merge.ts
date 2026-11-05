// SPDX-License-Identifier: AGPL-3.0-only
// WebGL2 stacked-alpha reconstruction for playing video elements (§53.3.1 "reconstructed on the GPU"). Paused, seek and
// capture frames use the CPU merge pool (merge-pool.ts); both read the packing from STACKED_ALPHA and copy texels exactly
// (texelFetch, no filtering), so alpha matches the pool's. One shared context; each item gets its own output canvas.
import { halves, STACKED_ALPHA } from './merge-pool';

const VS = `#version 300 es
void main() { vec2 p = vec2(gl_VertexID & 1, gl_VertexID >> 1) * 4.0 - 1.0; gl_Position = vec4(p, 0.0, 1.0); }`;
const FS = `#version 300 es
precision highp float; precision highp int;
uniform highp sampler2D src; uniform int colourX; uniform int alphaX; uniform int channel; uniform int rows;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy); int y = rows - 1 - p.y;
  vec4 c = texelFetch(src, ivec2(p.x + colourX, y), 0), a = texelFetch(src, ivec2(p.x + alphaX, y), 0);
  o = vec4(c.rgb, a[channel]);
}`;
type GL = { gl: WebGL2RenderingContext; canvas: OffscreenCanvas; tex: WebGLTexture; u: Record<string, WebGLUniformLocation | null> };
let shared: GL | null | undefined;

function setup(): GL | null {
  const canvas = new OffscreenCanvas(2, 2), gl = canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false });
  if (!gl) return null;
  const program = gl.createProgram()!;
  for (const [type, text] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, FS]] as const) {
    const s = gl.createShader(type)!; gl.shaderSource(s, text); gl.compileShader(s); gl.attachShader(program, s);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  gl.useProgram(program);
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
  for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  const u = Object.fromEntries(['src', 'colourX', 'alphaX', 'channel', 'rows'].map(n => [n, gl.getUniformLocation(program, n)]));
  return { gl, canvas, tex, u };
}
/** Merges the current picture of `frame` (both halves, width × height px) into `out` (resized to the half). False when
 *  WebGL2 is unavailable; the caller then falls back to the merge pool. */
export function glMergeInto(frame: TexImageSource, width: number, height: number, out: OffscreenCanvas): boolean {
  if (shared === undefined) shared = setup();
  if (!shared) return false;
  const { gl, canvas, tex, u } = shared, w = width >> 1, { colourX, alphaX } = halves(width);
  if (canvas.width !== w || canvas.height !== height) { canvas.width = w; canvas.height = height; }
  gl.viewport(0, 0, w, height);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, frame);
  gl.uniform1i(u.src, 0); gl.uniform1i(u.colourX, colourX); gl.uniform1i(u.alphaX, alphaX); gl.uniform1i(u.channel, STACKED_ALPHA.channel); gl.uniform1i(u.rows, height);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  if (out.width !== w || out.height !== height) { out.width = w; out.height = height; }
  const ctx = out.getContext('2d')!;
  ctx.clearRect(0, 0, w, height); ctx.drawImage(canvas, 0, 0);
  return true;
}
