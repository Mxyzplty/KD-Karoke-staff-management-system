// SPDX-License-Identifier: AGPL-3.0-only
// WebGPU backend. Textures hold the top row first (WGSL texel() flips to the oracle's row-from-bottom), so uploads and
// reads copy rows as they are. Intermediates are half-float rgba16float (§48); the last pass of a chain is rgba8unorm.
import { programSource } from './shaders';
import { createRenderer, isRawPixels, quantise, sourceSize, type Backend, type EffectRenderer, type Frame, type PassSpec, type PixelSource } from './renderer';
import type { AuxTable } from './uniforms';

// GPUTextureUsage / GPUBufferUsage / GPUMapMode values (the DOM lib types the API but does not declare the constants).
const TEX_COPY_SRC = 1, TEX_COPY_DST = 2, TEX_BINDING = 4, TEX_RENDER = 16;
const BUF_MAP_READ = 1, BUF_COPY_DST = 8, BUF_UNIFORM = 64, MAP_READ = 1;
const UNIFORM_BYTES = 64 * 16;

type GpuFormat = 'rgba8unorm' | 'rgba16float';

/** IEEE 754 binary16 bits → number. */
function half(h: number): number {
  const e = (h >> 10) & 31, m = h & 1023, s = h & 0x8000 ? -1 : 1;
  return s * (e === 0 ? m * 2 ** -24 : e === 31 ? (m ? NaN : Infinity) : (1 + m / 1024) * 2 ** (e - 15));
}

export class WebGPUBackend implements Backend {
  readonly kind = 'webgpu' as const;
  private readonly layout: GPUBindGroupLayout;
  private readonly pipelineLayout: GPUPipelineLayout;
  private readonly modules = new Map<string, GPUShaderModule>();
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private readonly dummy: GPUTexture;

  constructor(readonly device: GPUDevice) {
    const tex = { sampleType: 'unfilterable-float' as const, viewDimension: '2d' as const };
    this.layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 2 /* FRAGMENT */, buffer: { type: 'uniform' } },
        { binding: 1, visibility: 2, texture: tex },
        { binding: 2, visibility: 2, texture: tex },
      ],
    });
    this.pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    this.dummy = this.texture(1, 1, 'rgba8unorm');
    device.queue.writeTexture({ texture: this.dummy }, new Uint8Array(4), { bytesPerRow: 4 }, [1, 1]);
  }

  private texture(width: number, height: number, format: GpuFormat): GPUTexture {
    return this.device.createTexture({ size: [width, height], format, usage: TEX_COPY_SRC | TEX_COPY_DST | TEX_BINDING | TEX_RENDER });
  }

  upload(source: PixelSource): Frame {
    if (isRawPixels(source)) {
      const { width, height } = source, t = this.texture(width, height, 'rgba8unorm');
      const bytes = new Uint8Array(source.data.buffer, source.data.byteOffset, width * height * 4);
      this.device.queue.writeTexture({ texture: t }, bytes, { bytesPerRow: width * 4, rowsPerImage: height }, [width, height]);
      return { width, height, format: 'rgba8', texture: t };
    }
    const { width, height } = sourceSize(source), t = this.texture(width, height, 'rgba8unorm');
    this.device.queue.copyExternalImageToTexture({ source: source as GPUCopyExternalImageSource, flipY: false },
      { texture: t, premultipliedAlpha: false, colorSpace: 'srgb' }, [width, height]);
    return { width, height, format: 'rgba8', texture: t };
  }

  private module(id: string): GPUShaderModule {
    let m = this.modules.get(id);
    if (!m) this.modules.set(id, m = this.device.createShaderModule({ label: id, code: programSource(id, 'wgsl') }));
    return m;
  }

  private pipeline(id: string, format: GpuFormat): GPURenderPipeline {
    const key = `${id}|${format}`;
    let p = this.pipelines.get(key);
    if (!p) {
      const module = this.module(id);
      p = this.device.createRenderPipeline({
        label: key, layout: this.pipelineLayout,
        vertex: { module, entryPoint: 'vsMain' },
        fragment: { module, entryPoint: 'fsMain', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      });
      this.pipelines.set(key, p);
    }
    return p;
  }

  /** Compile one program and build both pipelines now; rejects with the compiler messages on failure. */
  async prepare(id: string): Promise<void> {
    this.device.pushErrorScope('validation');
    const module = this.module(id);
    this.pipeline(id, 'rgba16float');
    this.pipeline(id, 'rgba8unorm');
    const error = await this.device.popErrorScope();
    const messages = (await module.getCompilationInfo()).messages.filter(m => m.type === 'error');
    if (messages.length || error) {
      this.modules.delete(id);
      this.pipelines.delete(`${id}|rgba16float`);
      this.pipelines.delete(`${id}|rgba8unorm`);
      throw new Error(`WGSL failed for '${id}': ${messages.map(m => `${m.lineNum}:${m.linePos} ${m.message}`).join('; ') || error?.message}`);
    }
  }

  pass(input: Frame, spec: PassSpec): Frame {
    const device = this.device, format: GpuFormat = spec.final ? 'rgba8unorm' : 'rgba16float';
    const out = this.texture(spec.width, spec.height, format);
    const uniforms = device.createBuffer({ size: UNIFORM_BYTES, usage: BUF_UNIFORM | BUF_COPY_DST });
    device.queue.writeBuffer(uniforms, 0, spec.uniforms.buffer, spec.uniforms.byteOffset, UNIFORM_BYTES);
    const aux = spec.aux ? this.auxTexture(spec.aux) : null;
    const bind = device.createBindGroup({
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: uniforms } },
        { binding: 1, resource: (input.texture as GPUTexture).createView() },
        { binding: 2, resource: (aux ?? this.dummy).createView() },
      ],
    });
    const encoder = device.createCommandEncoder();
    const rp = encoder.beginRenderPass({ colorAttachments: [{ view: out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
    rp.setPipeline(this.pipeline(spec.program, format));
    rp.setBindGroup(0, bind);
    rp.draw(3);
    rp.end();
    device.queue.submit([encoder.finish()]);
    uniforms.destroy();
    aux?.destroy();
    return { width: spec.width, height: spec.height, format: spec.final ? 'rgba8' : 'rgba16f', texture: out };
  }

  private auxTexture(aux: AuxTable): GPUTexture {
    const t = this.texture(aux.width, aux.height, 'rgba8unorm');
    this.device.queue.writeTexture({ texture: t }, aux.data, { bytesPerRow: aux.width * 4, rowsPerImage: aux.height }, [aux.width, aux.height]);
    return t;
  }

  async read(frame: Frame): Promise<Uint8Array> {
    const { width, height } = frame, texelBytes = frame.format === 'rgba16f' ? 8 : 4;
    const tight = width * texelBytes, stride = Math.ceil(tight / 256) * 256;
    const buffer = this.device.createBuffer({ size: stride * height, usage: BUF_MAP_READ | BUF_COPY_DST });
    const encoder = this.device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture: frame.texture as GPUTexture }, { buffer, bytesPerRow: stride, rowsPerImage: height }, [width, height]);
    this.device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(MAP_READ);
    const mapped = new Uint8Array(buffer.getMappedRange()), packed = new Uint8Array(tight * height);
    for (let r = 0; r < height; r++) packed.set(mapped.subarray(r * stride, r * stride + tight), r * tight);
    buffer.unmap();
    buffer.destroy();
    return frame.format === 'rgba16f' ? quantise(Float32Array.from(new Uint16Array(packed.buffer), half)) : packed;
  }

  release(frame: Frame) { (frame.texture as GPUTexture).destroy(); }

  dispose() {
    this.dummy.destroy();
    this.modules.clear();
    this.pipelines.clear();
  }
}

/** True when this browser exposes WebGPU (an adapter may still be refused). */
export const webgpuAvailable = () => typeof navigator !== 'undefined' && 'gpu' in navigator && !!navigator.gpu;

/** WebGPU effect renderer on `device`, or on a newly requested one. Rejects when WebGPU or an adapter is unavailable. */
export async function createWebGPURenderer(device?: GPUDevice): Promise<EffectRenderer & { gpu: WebGPUBackend }> {
  let d = device;
  if (!d) {
    if (!webgpuAvailable()) throw new Error('WebGPU is not available');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('WebGPU adapter is not available');
    d = await adapter.requestDevice();
  }
  const gpu = new WebGPUBackend(d);
  return { ...createRenderer(gpu), gpu };
}
