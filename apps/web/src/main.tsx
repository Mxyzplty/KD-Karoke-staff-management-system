// SPDX-License-Identifier: AGPL-3.0-only
import React, { lazy, Suspense, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Home } from './home';
import { Library } from './library';
import { EditorRoute } from './editor';
import { Notifications, notify, reportError } from './ui';
import { projectStore } from './store/database';
import { recoverOnLoad } from './media/ingest';
import { bindPreparationLifecycle, resumePreparations } from './media/prepare';
import { AgentLink } from './agent/AgentLink';
import { sweepDemos } from './settings/first-edit/demos';
import { HELP_LINKS, openHelpLink } from './settings/help-links';
import { ProviderLine } from './settings/ProviderLine';
import { connectProviders } from './settings/providers';
import './style.css';
const CostsPage = lazy(() => import('./settings/CostsPage').then(m => ({ default: m.CostsPage })));
const HelpPage = lazy(() => import('./settings/HelpPage').then(m => ({ default: m.HelpPage })));
const OnboardingPage = lazy(() => import('./settings/OnboardingPage').then(m => ({ default: m.OnboardingPage })));
const SettingsPage = lazy(() => import('./settings/SettingsPage').then(m => ({ default: m.SettingsPage })));
function App() {
  const [path, setPath] = useState(location.pathname), [help, setHelp] = useState(false);
  const [theme, setTheme] = useState(() => { try { const saved = localStorage.getItem('cutframe:theme'); return saved === 'light' || saved === 'dark' ? saved : 'system'; } catch { return 'system'; } });
  const navigate = (next: string) => { history.pushState(null, '', next); setPath(location.pathname); setHelp(false); };
  const project = /^\/project\/([^/]+)$/.exec(path);
  const onboarding = path === '/onboarding';
  const helpSection = /^\/help(?:\/([^/]+))?$/.exec(path);
  const known = project || helpSection || ['/', '/assets', '/settings', '/costs', '/onboarding'].includes(path);
  useEffect(() => { const pop = () => setPath(location.pathname); window.addEventListener('popstate', pop); void projectStore.retryCleanup().catch(reportError); void recoverOnLoad(projectStore).catch(reportError); void connectProviders(projectStore).catch(reportError);
    // Hidden or leaving → running media preparations are cancelled; visible again → they resume (review F11).
    const unbindPreparation = bindPreparationLifecycle(() => void resumePreparations(projectStore).catch(reportError));
    return () => { window.removeEventListener('popstate', pop); unbindPreparation(); }; }, []);
  useEffect(() => { if (!known) { if (location.pathname !== '/') { history.replaceState(null, '', '/'); notify('Page not found. You’re back home.'); } setPath('/'); } }, [path, known]);
  useEffect(() => { document.documentElement.dataset.theme = theme; try { localStorage.setItem('cutframe:theme', theme); } catch { notify('Theme preference could not be saved in this browser.'); } }, [theme]);
  const link = (event: React.MouseEvent<HTMLAnchorElement>, next: string) => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0) { event.preventDefault(); navigate(next); } };
  return <>
    {!project && !onboarding && <header><a className="logo" href="/" onClick={e => link(e, '/')}>Cutframe<span>LOCAL STUDIO</span></a><nav aria-label="Main navigation">{[['/assets', 'Library'], ['/settings', 'Settings'], ['/costs', 'Costs']].map(([url, label]) => <a key={url} aria-current={path === url ? 'page' : undefined} href={url} onClick={e => link(e, url)}>{label}</a>)}<button aria-label={`Theme: ${theme}`} title="Cycle theme: system, light, dark" onClick={() => setTheme(theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system')}>{theme === 'system' ? '◐' : theme === 'light' ? '☀' : '☾'}</button></nav></header>}
    {project ? <EditorRoute key={project[1]} id={project[1]} navigate={navigate} /> : onboarding ? <Suspense fallback={null}><OnboardingPage navigate={navigate} /></Suspense> : <main><Suspense key={helpSection ? '/help' : path} fallback={null}>{path === '/assets' ? <Library navigate={navigate} /> : path === '/settings' ? <SettingsPage navigate={navigate} /> : path === '/costs' ? <CostsPage /> : helpSection ? <HelpPage id={helpSection[1]} navigate={navigate} /> : <Home navigate={navigate} />}</Suspense>
      <footer><ProviderLine key={path} /> <span>Alt+N focuses notifications.</span></footer>
    </main>}
    {!project && !onboarding && <div className="help"><button aria-label="Help & Resources" aria-expanded={help} onClick={() => setHelp(!help)}>?</button>{help && <div role="menu" aria-label="Help & Resources">{HELP_LINKS.map(l => <button key={l.label} role="menuitem" onClick={() => { setHelp(false); openHelpLink(l, navigate); }}>{l.label}</button>)}</div>}</div>}
    <Notifications />
    <AgentLink path={path} />
  </>;
}
const root = createRoot(document.getElementById('root')!);
// Before the first paint: the Library and the Settings counts read once, and must not show a demo a closed or crashed tab left.
void sweepDemos(projectStore).catch(e => console.warn('[FirstEdit]', e)).finally(() => root.render(<React.StrictMode><App /></React.StrictMode>));
