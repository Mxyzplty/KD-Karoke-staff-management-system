// SPDX-License-Identifier: AGPL-3.0-only
// T08 repair fixture (ticket T08 "Repair tests" (b), F27): 10 snippets we wrote, each with one known defect, and the client
// for the user's own model. The run is Author's step (needs a model):
//   CUTFRAME_REPAIR_ENDPOINT=<private> CUTFRAME_REPAIR_MODEL=<private> CUTFRAME_REPAIR_KEY=<private> npx playwright test tests/ui/t08-repair-fixture.spec.ts
// The endpoint is any OpenAI-compatible chat-completions base URL (…/v1); the key is optional for a local server. Pass:
// ≥ 8 of 10 repaired and valid (validated at FRAMES, plus `check`), every failure reported, none saved broken. Without the
// variables the spec runs the reference fixes (`fixed`) as a mock model instead: 10 of 10.
// The spec runs in Node and the runtime is sandbox-only (runtime-components loads lottie-web, which needs a DOM), so the API
// names are read from its source text (apiNames).
import { readFileSync } from 'node:fs';
import { replyCode, systemPrompt, userMessage } from '../apps/web/src/mg/repair';
import type { RepairRequest } from '../apps/web/src/mg/repair';

export type RepairSnippet = { id: string; defect: string; code: string; fixed: string;
  /** The error the repair starts from when the renderer reports none (the defect is not a render error). */
  error?: string;
  /** A further condition on a repaired code: null when it holds, else why not. */
  check?: (code: string) => string | null };
/** Item box, clock and the frames every candidate is rendered at (the runtime throw starts at 30). */
export const ITEM = { width: 540, height: 960, fps: 30, durationInFrames: 90 };
export const FRAMES = [0, 30, 60];

const fadeTitle = (text: string) => `<div style={{ position: 'absolute', left: 40, top: 40, color: 'white', fontSize: 64, opacity: interpolate(frame, [0, 30], [0, 1], { extrapolateRight: 'clamp' }) }}>${text}</div>`;
export const SNIPPETS: readonly RepairSnippet[] = [
  { id: 'native-video', defect: 'a native <video> element',
    code: `export const Graphic = () => {\n  const frame = useCurrentFrame();\n  return <AbsoluteFill style={{ background: '#101828' }}>\n    <video autoPlay muted loop style={{ position: 'absolute', inset: 0, width: itemWidth, height: itemHeight, objectFit: 'cover' }} />\n    ${fadeTitle('Launch day')}\n  </AbsoluteFill>;\n};`,
    fixed: `export const Graphic = () => {\n  const frame = useCurrentFrame();\n  return <AbsoluteFill style={{ background: '#101828' }}>\n    ${fadeTitle('Launch day')}\n  </AbsoluteFill>;\n};` },
  { id: 'config-sizing', defect: 'layout from useVideoConfig() width / height instead of the item box',
    code: `export const Graphic = () => {\n  const { width, height } = useVideoConfig();\n  const frame = useCurrentFrame();\n  const x = interpolate(frame, [0, 60], [-width, 0], { extrapolateRight: 'clamp' });\n  return <AbsoluteFill><div style={{ position: 'absolute', left: x, top: height * 0.8, width, height: height * 0.2, background: '#e11d48' }} /></AbsoluteFill>;\n};`,
    fixed: `export const Graphic = () => {\n  const frame = useCurrentFrame();\n  const x = interpolate(frame, [0, 60], [-itemWidth, 0], { extrapolateRight: 'clamp' });\n  return <AbsoluteFill><div style={{ position: 'absolute', left: x, top: itemHeight * 0.8, width: itemWidth, height: itemHeight * 0.2, background: '#e11d48' }} /></AbsoluteFill>;\n};`,
    error: 'The graphic is laid out from useVideoConfig() width and height (the canvas size), but it is drawn in its item box: use itemWidth and itemHeight.',
    check: code => /useVideoConfig/.test(code) ? 'still uses useVideoConfig' : /\bitem(Width|Height)\b/.test(code) ? null : 'does not use itemWidth / itemHeight' },
  { id: 'default-export', defect: 'a default export instead of `export const` as the last statement',
    code: `const Graphic = () => {\n  const frame = useCurrentFrame();\n  return <AbsoluteFill style={{ background: '#0f172a' }}><div style={{ color: 'white', fontSize: 48, transform: \`scale(\${spring({ frame, fps: 30 })})\` }}>Hello</div></AbsoluteFill>;\n};\nexport default Graphic;`,
    fixed: `export const Graphic = () => {\n  const frame = useCurrentFrame();\n  return <AbsoluteFill style={{ background: '#0f172a' }}><div style={{ color: 'white', fontSize: 48, transform: \`scale(\${spring({ frame, fps: 30 })})\` }}>Hello</div></AbsoluteFill>;\n};` },
  { id: 'helper-exported', defect: 'a helper exported after the component',
    code: `export const Graphic = () => {\n  const frame = useCurrentFrame();\n  return <AbsoluteFill style={{ background: '#111827' }}><Badge label="NEW" scale={spring({ frame, fps: 30 })} /></AbsoluteFill>;\n};\nexport const Badge = ({ label, scale }) => <div style={{ margin: 40, padding: '8px 16px', background: '#facc15', fontSize: 40, transform: \`scale(\${scale})\` }}>{label}</div>;`,
    fixed: `const Badge = ({ label, scale }) => <div style={{ margin: 40, padding: '8px 16px', background: '#facc15', fontSize: 40, transform: \`scale(\${scale})\` }}>{label}</div>;\nexport const Graphic = () => {\n  const frame = useCurrentFrame();\n  return <AbsoluteFill style={{ background: '#111827' }}><Badge label="NEW" scale={spring({ frame, fps: 30 })} /></AbsoluteFill>;\n};` },
  { id: 'jsx-syntax', defect: 'a JSX syntax error (unclosed element)',
    code: `export const Graphic = () => {\n  const frame = useCurrentFrame();\n  return <AbsoluteFill style={{ background: '#1e293b' }}>\n    ${fadeTitle('Chapter 2').replace('</div>', '')}\n  </AbsoluteFill>;\n};`,
    fixed: `export const Graphic = () => {\n  const frame = useCurrentFrame();\n  return <AbsoluteFill style={{ background: '#1e293b' }}>\n    ${fadeTitle('Chapter 2')}\n  </AbsoluteFill>;\n};` },
  { id: 'undefined-name', defect: 'a name outside the API (measureSpring)',
    code: `export const Graphic = () => {\n  const frame = useCurrentFrame();\n  const settle = measureSpring({ fps: 30 });\n  const y = interpolate(frame, [0, settle], [itemHeight, itemHeight / 2], { extrapolateRight: 'clamp' });\n  return <AbsoluteFill><div style={{ position: 'absolute', left: 0, top: y, width: itemWidth, height: 8, background: '#38bdf8' }} /></AbsoluteFill>;\n};`,
    fixed: `export const Graphic = () => {\n  const frame = useCurrentFrame();\n  const y = interpolate(frame, [0, 30], [itemHeight, itemHeight / 2], { extrapolateRight: 'clamp' });\n  return <AbsoluteFill><div style={{ position: 'absolute', left: 0, top: y, width: itemWidth, height: 8, background: '#38bdf8' }} /></AbsoluteFill>;\n};` },
  { id: 'unsupported-option', defect: 'an option outside the API table (interpolateColors options)',
    code: `export const Graphic = () => {\n  const frame = useCurrentFrame();\n  const color = interpolateColors(frame, [0, 45], ['#22d3ee', '#a855f7'], { extrapolateRight: 'clamp' });\n  return <AbsoluteFill style={{ background: color }} />;\n};`,
    fixed: `export const Graphic = () => {\n  const frame = useCurrentFrame();\n  const color = interpolateColors(Math.min(frame, 45), [0, 45], ['#22d3ee', '#a855f7']);\n  return <AbsoluteFill style={{ background: color }} />;\n};` },
  { id: 'throw-at-30', defect: 'a runtime throw from frame 30 (step list too short)',
    code: `export const Graphic = () => {\n  const frame = useCurrentFrame();\n  const steps = [{ label: 'Intro' }];\n  const step = steps[Math.floor(frame / 30)];\n  return <AbsoluteFill style={{ background: '#064e3b' }}><div style={{ margin: 40, color: 'white', fontSize: 56 }}>{step.label}</div></AbsoluteFill>;\n};`,
    fixed: `export const Graphic = () => {\n  const frame = useCurrentFrame();\n  const steps = [{ label: 'Intro' }, { label: 'Middle' }, { label: 'End' }];\n  const step = steps[Math.min(steps.length - 1, Math.floor(frame / 30))];\n  return <AbsoluteFill style={{ background: '#064e3b' }}><div style={{ margin: 40, color: 'white', fontSize: 56 }}>{step.label}</div></AbsoluteFill>;\n};` },
  { id: 'infinite-loop', defect: 'a loop that never ends from frame 1 (caught by the watchdog)',
    code: `export const Graphic = () => {\n  const frame = useCurrentFrame();\n  let n = frame, steps = 0;\n  while (n > 0) { n = Math.floor(n / 2) + 1; steps++; }\n  return <AbsoluteFill style={{ background: '#312e81' }}><div style={{ margin: 40, color: 'white', fontSize: 56 }}>{steps} halvings</div></AbsoluteFill>;\n};`,
    fixed: `export const Graphic = () => {\n  const frame = useCurrentFrame();\n  let n = frame, steps = 0;\n  while (n > 0) { n = Math.floor(n / 2); steps++; }\n  return <AbsoluteFill style={{ background: '#312e81' }}><div style={{ margin: 40, color: 'white', fontSize: 56 }}>{steps} halvings</div></AbsoluteFill>;\n};` },
  { id: 'editable-type', defect: "an editable field of a type the API does not have ('paragraph')",
    code: `export const Graphic = () => {\n  const frame = useCurrentFrame();\n  const title = editable('title', 'Summer sale', { type: 'paragraph' });\n  return <AbsoluteFill style={{ background: '#7c2d12' }}><div style={{ margin: 40, color: 'white', fontSize: 64, opacity: interpolate(frame, [0, 20], [0, 1], { extrapolateRight: 'clamp' }) }}>{title}</div></AbsoluteFill>;\n};`,
    fixed: `export const Graphic = () => {\n  const frame = useCurrentFrame();\n  const title = editable('title', 'Summer sale', { type: 'text' });\n  return <AbsoluteFill style={{ background: '#7c2d12' }}><div style={{ margin: 40, color: 'white', fontSize: 64, opacity: interpolate(frame, [0, 20], [0, 1], { extrapolateRight: 'clamp' }) }}>{title}</div></AbsoluteFill>;\n};` },
];

/** runtime-components.tsx API_NAMES (the names a graphic may use). Run from the repo root, as npm scripts and Playwright are. */
export function apiNames(): string[] {
  const text = readFileSync('apps/web/src/mg/runtime-components.tsx', 'utf8');
  const list = /export const API_NAMES = \[([^\]]*)\]/.exec(text)?.[1];
  if (!list) throw new Error('API_NAMES not found in runtime-components.tsx');
  return [...list.matchAll(/'([^']+)'/g)].map(m => m[1]);
}
export { replyCode, systemPrompt, userMessage };

export type ModelEnv = { endpoint: string; model: string; key?: string };
export const modelEnv = (env: NodeJS.ProcessEnv = process.env): ModelEnv | null =>
  env.CUTFRAME_REPAIR_ENDPOINT && env.CUTFRAME_REPAIR_MODEL ? { endpoint: env.CUTFRAME_REPAIR_ENDPOINT, model: env.CUTFRAME_REPAIR_MODEL, key: env.CUTFRAME_REPAIR_KEY } : null;
/** One repair request to the user's model (OpenAI-compatible chat completions). */
export async function callModel(env: ModelEnv, system: string, r: RepairRequest): Promise<{ code: string } | { error: string }> {
  const res = await fetch(`${env.endpoint.replace(/\/+$/, '')}/chat/completions`, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(env.key ? { authorization: `Bearer ${env.key}` } : {}) },
    body: JSON.stringify({ model: env.model, temperature: 0, messages: [{ role: 'system', content: system },{ role: 'user', content: userMessage(r) }] }) });
  if (!res.ok) return { error: `The model answered HTTP ${res.status}.` };
  const text = (await res.json())?.choices?.[0]?.message?.content;
  return typeof text === 'string' && text.trim() ? { code: replyCode(text) } : { error: 'The model returned no code.' };
}
