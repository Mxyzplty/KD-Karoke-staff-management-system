// SPDX-License-Identifier: AGPL-3.0-only
// T21 First Edit demo view (§28b.1.3, §28b.3): the intro, the scripted chat beside the real editor, the read-only footage
// panel and the end state. The input is cosmetic as in §28b.3.1 (typing stops the auto-typing, sending posts the scripted
// message); our improvements: the setup spinner can be skipped, and the answers are worded from the real results.
import { useEffect, useRef, useState } from 'react';
import { EditorRoute } from '../../editor';
import { usePoster } from '../../media-ui';
import { activeRuntime } from '../../timeline/runtime';
import { createScript, FINAL_HEADLINE, OPENING, runOps } from './script';
import type { ChipState, Step } from './script';
import { leaveDemos } from './demos';
import { browserProblem, DemoFailure, setupDemo } from './pack';
import type { Demo, DemoReason } from './pack';
import { clock } from './plan';
import type { DemoAsset } from './plan';
import { projectStore } from '../../store/database';

export const TYPE_MS = 45, READY_POLL_MS = 300, READY_TRIES = 100, SETTLE_MS = 800;
const REASON: Record<DemoReason, string> = {
  pack: 'The demo pack could not be loaded.', project: 'The demo project could not be created.', setup: 'The demo could not be set up.', timeout: 'The demo took too long to set up.' };
const CONFETTI = ['#ff5d73', '#ffd166', '#06d6a0', '#4cc9f0', '#b185ff'];
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
type Turn = { role: 'user' | 'assistant'; text: string } | { role: 'chips'; step: number; tools: string[]; states: ChipState[] };

/** Three steps, each: auto-type the message, send, run the operations with their chips, then the answer. */
function Chat({ demo, headline, leave, ended }: { demo: Demo; headline: (text: string) => void; leave: () => void; ended: () => void }) {
  const [turns, setTurns] = useState<Turn[]>([]), [index, setIndex] = useState(0), [typed, setTyped] = useState(''), [busy, setBusy] = useState(true), [own, setOwn] = useState(false);
  const script = useRef<{ steps: Step[] }>(undefined);
  script.current ??= createScript({ assets: demo.assets, wait, call: (tool, args) => activeRuntime?.call(tool, args) ?? { success: false, code: 'NO_PROJECT', error: 'The editor is not open.' } });
  const steps = script.current.steps, step = steps[index], finished = index >= steps.length, opened = turns.length > 0;
  // The top bar follows the step from the opening line on; the end state comes with the last answer (§28b.3.6).
  useEffect(() => { if (finished) ended(); else if (opened) headline(step.headline); }, [finished, opened, step]);
  // Opening line: wait for the runtime and the assets, then settle. A slow editor is not an error (W1).
  useEffect(() => {
    let alive = true;
    void (async () => {
      for (let n = 0; n < READY_TRIES && !(activeRuntime && demo.assets.length); n++) await wait(READY_POLL_MS);
      await wait(SETTLE_MS);
      if (alive) { setTurns([{ role: 'assistant', text: OPENING }]); setBusy(false); }
    })();
    return () => { alive = false; };
  }, [demo]);
  useEffect(() => {
    if (busy || finished) return;
    let n = 0, timer: ReturnType<typeof setTimeout>;
    const tick = () => { if (own) return; setTyped(step.message.slice(0, ++n)); if (n < step.message.length) timer = setTimeout(tick, TYPE_MS); };
    timer = setTimeout(tick, TYPE_MS);
    return () => clearTimeout(timer);
  }, [busy, finished, index, own, step]);
  async function send() {
    if (busy || finished) return;
    setBusy(true); setOwn(false); setTyped('');
    const chips: Turn = { role: 'chips', step: index, tools: step.ops.map(o => o.tool), states: step.ops.map(() => 'pending') };
    setTurns(t => [...t, { role: 'user', text: step.message }, chips]);
    await runOps(step.ops, wait, (op, state) => setTurns(t => t.map(turn => turn.role === 'chips' && turn.step === index ? { ...turn, states: turn.states.map((s, n) => n === op ? state : s) } : turn)));
    setTurns(t => [...t, { role: 'assistant', text: step.answer() }]);
    setIndex(index + 1); setBusy(false);
  }
  return <aside className="demo-chat" aria-label="Assistant">
    <div className="demo-log" role="log">{turns.map((turn, n) => turn.role === 'chips'
      ? <ul key={n} className="demo-chips">{turn.tools.map((tool, i) => <li key={i} data-state={turn.states[i]}>{tool}</li>)}</ul>
      : <p key={n} className={`demo-turn ${turn.role}`}>{turn.text}</p>)}
      {busy && !finished && <p className="demo-turn assistant working">Working…</p>}
    </div>
    <div className="demo-bar" data-done={index}>{steps.map((s, n) => <span key={s.id} data-filled={n < index} />)}</div>
    {finished ? <button className="primary demo-continue" onClick={leave}>Continue</button>
      : <form className="demo-input" onSubmit={e => { e.preventDefault(); void send(); }}>
        <input aria-label="Message" value={typed} placeholder={busy ? 'Working…' : ''} disabled={busy}
          onChange={e => { setOwn(true); setTyped(e.target.value); }} />
        <button aria-label="Send this message" disabled={busy}>↑</button>
        {!busy && <span className="demo-hint">Send this message</span>}
      </form>}
  </aside>;
}
function FootageTile({ asset }: { asset: DemoAsset }) {
  const poster = usePoster(asset.id, asset.durationMs);
  return <li><div className="demo-tile" style={poster ? { backgroundImage: `url(${poster})` } : undefined} /><span>{asset.name}</span><small>{clock(asset.durationMs)}</small></li>;
}
/** The right-hand footage panel: read-only, nothing draggable (§28b.2.2). */
function Footage({ assets }: { assets: DemoAsset[] }) {
  const video = assets.filter(a => a.type === 'video'), audio = assets.filter(a => a.type === 'audio');
  return <div className="demo-footage"><h3>Your clips</h3>
    <ul className="demo-grid">{video.map(a => <FootageTile key={a.id} asset={a} />)}</ul>
    <ul className="demo-audio">{audio.map(a => <li key={a.id}>♪ <span>{a.name}</span><small>{clock(a.durationMs)}</small></li>)}</ul>
    {!assets.length && <p className="empty">No demo clips were loaded.</p>}
  </div>;
}
/** Setup starts on mount (§28b.1.3) so the intro is not dead time; `Show me` then waits on a spinner it can skip. */
export function FirstEdit({ back, finish }: { back: () => void; finish: (skipped: boolean) => void }) {
  const [demo, setDemo] = useState<Demo>(), [failure, setFailure] = useState<DemoFailure>(), [showing, setShowing] = useState(false), [end, setEnd] = useState(false), [headline, setHeadline] = useState('');
  const blocked = useRef(browserProblem()).current, setup = useRef<Promise<Demo>>(undefined), mounted = useRef(false);
  useEffect(() => {
    if (blocked) return;
    let alive = true;
    // StrictMode mounts twice: one entry is one setup.
    void (setup.current ??= setupDemo(projectStore)).then(d => { if (alive) setDemo(d); }, e => { if (alive) setFailure(e instanceof DemoFailure ? e : new DemoFailure('setup', e)); });
    return () => { alive = false; };
  }, [blocked]);
  // However this view is left, the demo goes with it. StrictMode's unmount on the way in is back by the microtask.
  useEffect(() => {
    if (blocked) return;
    mounted.current = true;
    return () => {
      mounted.current = false;
      queueMicrotask(() => { if (!mounted.current) void leaveDemos(projectStore).catch(e => console.warn('[FirstEdit]', e)); });
    };
  }, [blocked]);
  if (blocked) return <section className="demo-gate"><h2>The demo needs a desktop browser</h2>
    <p>This quick demo uses video features this browser does not offer. Finish setting up now, and try it later on a desktop Chromium-family browser — the editor itself still works here.</p>
    <div className="dialog-actions"><button onClick={back}>Back</button><button className="primary" onClick={() => finish(true)}>Continue</button></div></section>;
  if (failure) return <section className="demo-gate"><h2>The demo could not start</h2><p>{REASON[failure.reason]} You can carry on; the editor is ready either way.</p>
    <div className="dialog-actions"><button onClick={back}>Back</button><button className="primary" onClick={() => finish(true)}>Continue</button></div></section>;
  if (!showing) return <section className="demo-intro"><h2>A quick look at what this can do</h2>
    <p>You send three messages. Cutframe does the editing. It takes about a minute.</p>
    <ol><li><strong>01</strong> The song goes on the timeline, beats already analysed.</li><li><strong>02</strong> One pass lays down about 20 cuts, each on a beat.</li><li><strong>03</strong> One request gives every clip an ASCII look. Then you play it back.</li></ol>
    <p><small>This is the real editor working, not a recording.</small></p>
    <div className="dialog-actions"><button onClick={back}>Back</button><button className="primary" onClick={() => setShowing(true)}>Show me</button></div></section>;
  if (!demo) return <section className="demo-gate"><p>Setting up the demo…</p><div className="dialog-actions"><button onClick={() => finish(true)}>Skip demo</button></div></section>;
  const title = end ? FINAL_HEADLINE : headline;
  return <div className="demo-frame">
    <div className="demo-top"><strong key={title}>{title}</strong>
      {end ? <button className="primary" onClick={() => finish(false)}>Continue</button> : <button className="link" onClick={() => finish(true)}>Skip demo</button>}</div>
    {end && <div className="demo-confetti" aria-hidden="true">{Array.from({ length: 28 }, (_, n) => <i key={n} style={{ left: `${(n * 97) % 100}%`, background: CONFETTI[n % CONFETTI.length], animationDelay: `${(n % 7) * .12}s` }} />)}</div>}
    <EditorRoute id={demo.projectId} navigate={() => {}} demo={<><Chat demo={demo} headline={setHeadline} leave={() => finish(false)} ended={() => setEnd(true)} /><Footage assets={demo.assets} /></>} />
  </div>;
}
