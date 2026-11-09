// SPDX-License-Identifier: AGPL-3.0-only
// T21 /onboarding (§28, §28b.1): About You (4 questions, labels and the one-answer rule from compares and facts §4.3) → the
// drive picker → the built-in track (First Edit → Ready) or the own-agent track (Install → Connect → Ready). Answers stay in
// this browser and steer nothing; a finished onboarding sends /onboarding home. Nothing here needs an account or a network.
import { useEffect, useState } from 'react';
import { Dialog } from '../ui';
import { AgentPanel, useLink } from '../agent/AgentLink';
import { ClientGuide, CopyLine, GUIDES, HELPER_COMMAND, Troubleshooting } from './guides';
import type { Client } from './guides';
import { choose, finishOnboarding, OTHER, QUESTIONS, readOnboarding, saveOnboarding } from './onboarding';
import type { Drive, Onboarding } from './onboarding';
import { FirstEdit } from './first-edit/FirstEdit';

const BUILT_IN_RAIL = ['Sign Up', 'About You', 'First Edit', 'Ready'], AGENT_RAIL = ['Sign Up', 'About You', 'Install', 'Connect', 'Ready'];
const DRIVES: { drive: Drive; title: string; text: string }[] = [
  { drive: 'built-in', title: 'Use the built-in assistant', text: 'A quick demo now, then chat inside the editor. You can add your own provider later.' },
  { drive: 'own', title: 'Connect your own AI', text: 'Claude Code, Claude Desktop, Codex or any MCP client, through the local helper.' },
  { drive: 'skip', title: 'Not now — go to the editor', text: 'Go straight to the editor. Everything local works with no AI at all.' },
];
/** Both tracks end in the same editor with the same features. */
const SAME = 'Either way you get the same editor and the same features.';
const railOf = (state: Onboarding) => state.drive === 'own' ? AGENT_RAIL : BUILT_IN_RAIL;
function railStep(state: Onboarding) {
  if (state.phase === 'about-you') return 1;
  if (state.phase === 'drive-picker') return 1;
  return state.phase === 'ready' ? railOf(state).length - 1 : 2 + (state.phase === 'connect' ? 1 : 0);
}
function Rail({ state }: { state: Onboarding }) {
  const labels = railOf(state), at = railStep(state);
  return <ol className="onboarding-rail" aria-label="Setup progress">{labels.map((label, n) => <li key={label} aria-current={n === at ? 'step' : undefined} data-done={n < at}>{label}</li>)}</ol>;
}
export function OnboardingPage({ navigate }: { navigate: (path: string) => void }) {
  const [state, setState] = useState<Onboarding>(() => readOnboarding());
  const [skipping, setSkipping] = useState(false);
  const link = useLink();
  const put = (change: Partial<Onboarding>) => { const next = { ...state, ...change }; setState(next); saveOnboarding(next); };
  // A completed onboarding has nothing to show (§28: /onboarding then goes home).
  useEffect(() => { if (state.completed) navigate('/'); }, [state.completed, navigate]);
  // The own-agent track reaches Ready the moment a client pairs with this tab.
  useEffect(() => { if (state.phase === 'connect' && link.status === 'connected') put({ phase: 'ready' }); }, [state.phase, link.status]);
  function done() {
    finishOnboarding(); setState(readOnboarding());
    navigate('/');
  }
  if (state.completed) return <section><p>Setup is already finished.</p></section>;
  const question = QUESTIONS[state.step], chosen = question ? state.answers[question.id] ?? [] : [];
  const guide = GUIDES.find(g => g.client === (state.client ?? 'claude-code'))!;
  const pick = (drive: Drive) => drive === 'skip' ? done() : put({ drive, phase: drive === 'built-in' ? 'first-edit' : 'install' });
  return <section className="onboarding"><Rail state={state} />
    {state.phase === 'about-you' && question && <div className="onboarding-step">
      <p className="eyebrow">{String(state.step + 1).padStart(2, '0')} of 05</p><h1>{question.title}</h1>
      <p>{question.multiple ? 'Pick as many as you like.' : 'Pick one.'} Your answers stay in this browser.</p>
      <ul className="picker" aria-label={question.title}>{question.options.map(option => <li key={option}>
        <label className="picker-label"><input type={question.multiple ? 'checkbox' : 'radio'} name={question.id} checked={chosen.includes(option)}
          onChange={() => put({ answers: { ...state.answers, [question.id]: choose(question, chosen, option) } })} />
          {option === OTHER ? 'Other — tell us more' : option}</label></li>)}</ul>
      {chosen.includes(OTHER) && <input aria-label="Tell us more" value={state.other[question.id] ?? ''} onChange={e => put({ other: { ...state.other, [question.id]: e.target.value } })} />}
      <div className="dialog-actions">
        {state.step > 0 && <button onClick={() => put({ step: state.step - 1 })}>Back</button>}
        <button className="primary" disabled={!chosen.length} onClick={() => state.step + 1 < QUESTIONS.length ? put({ step: state.step + 1 }) : put({ phase: 'drive-picker' })}>Next</button>
        <button className="link" onClick={() => setSkipping(true)}>Skip setup</button>
      </div></div>}
    {state.phase === 'drive-picker' && <div className="onboarding-step"><p className="eyebrow">05 of 05</p><h1>How do you want to drive the AI?</h1><p>{SAME}</p>
      <ul className="picker" aria-label="How do you want to drive the AI?">{DRIVES.map(d => <li key={d.drive}>
        <button className="drive-card" data-drive={d.drive} onClick={() => pick(d.drive)}><strong>{d.title}</strong><span>{d.text}</span></button></li>)}</ul>
      <div className="dialog-actions"><button onClick={() => put({ phase: 'about-you', step: QUESTIONS.length - 1 })}>Back</button></div></div>}
    {state.phase === 'first-edit' && <FirstEdit back={() => put({ phase: 'drive-picker' })} finish={skipped => put({ phase: 'ready', skipped })} />}
    {state.phase === 'install' && <div className="onboarding-step"><h1>Install the helper</h1>
      <p>One command starts the local helper. It runs on this machine, on loopback only, and the editor pairs with it by a short code.</p>
      <CopyLine text={HELPER_COMMAND} />
      <div role="tablist" aria-label="Clients">{GUIDES.map(g => <button key={g.client} role="tab" aria-selected={guide.client === g.client} onClick={() => put({ client: g.client as Client })}>{g.label}</button>)}</div>
      <ClientGuide guide={guide} />
      <div className="dialog-actions"><button onClick={() => put({ phase: 'drive-picker' })}>Back</button>
        <button className="primary" onClick={() => put({ phase: 'connect' })}>Next</button>
        <button className="link" onClick={() => setSkipping(true)}>Skip setup — use the built-in assistant</button></div></div>}
    {state.phase === 'connect' && <div className="onboarding-step"><h1>Pair this tab</h1>
      <p>Connect this tab, then enter the pairing code the helper printed, or type the code this tab shows into the helper’s terminal. This page moves on by itself once a client is paired.</p>
      <AgentPanel />
      <Troubleshooting guide={guide} />
      <div className="dialog-actions"><button onClick={() => put({ phase: 'install' })}>Back</button>
        <button className="link" onClick={() => setSkipping(true)}>Skip setup — use the built-in assistant</button></div></div>}
    {state.phase === 'ready' && <div className="onboarding-step"><h1>All set</h1><p>{SAME} Nothing you make leaves this device unless you choose a provider.</p>
      <div className="dialog-actions"><button className="primary" onClick={done}>Open Cutframe</button></div></div>}
    {skipping && <Dialog title="Skip setup" close={() => setSkipping(false)}>
      <p>You can set up an outside agent at any time in Settings. Would you like the quick demo with the built-in assistant instead?</p>
      <div className="dialog-actions"><button onClick={() => { setSkipping(false); done(); }}>Skip setup</button>
        <button className="primary" onClick={() => { setSkipping(false); put({ drive: 'built-in', phase: 'first-edit' }); }}>Show me the demo</button></div></Dialog>}
  </section>;
}
