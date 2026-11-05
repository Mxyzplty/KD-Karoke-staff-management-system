// SPDX-License-Identifier: AGPL-3.0-only
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Home } from './home';
import { Library } from './library';
import { EditorRoute } from './editor';
import { Notifications, notify, reportError, unavailable } from './ui';
import { projectStore } from './store/database';
import { recoverOnLoad } from './media/ingest';
import { bindPreparationLifecycle, resumePreparations } from './media/prepare';
import { AgentLink } from './agent/AgentLink';
import './style.css';
function App() {
  const [path, setPath] = useState(location.pathname), [help, setHelp] = useState(false);
  const [theme, setTheme] = useState(() => { try { const saved = localStorage.getItem('cutframe:theme'); return saved === 'light' || saved === 'dark' ? saved : 'system'; } catch { return 'system'; } });
  const navigate = (next: string) => { history.pushState(null, '', next); setPath(next); setHelp(false); };
  const project = /^\/project\/([^/]+)$/.exec(path);
  const known = project || ['/', '/assets', '/settings', '/costs'].includes(path);
  useEffect(() => { const pop = () => setPath(location.pathname); window.addEventListener('popstate', pop); void projectStore.retryCleanup().catch(reportError); void recoverOnLoad(projectStore).catch(reportError);
    // Hidden or leaving → running media preparations are cancelled; visible again → they resume (review F11).
    const unbindPreparation = bindPreparationLifecycle(() => void resumePreparations(projectStore).catch(reportError));
    return () => { window.removeEventListener('popstate', pop); unbindPreparation(); }; }, []);
  useEffect(() => { if (!known) { if (location.pathname !== '/') { history.replaceState(null, '', '/'); notify('Page not found. You’re back home.'); } setPath('/'); } }, [path, known]);
  useEffect(() => { document.documentElement.dataset.theme = theme; try { localStorage.setItem('cutframe:theme', theme); } catch { notify('Theme preference could not be saved in this browser.'); } }, [theme]);
  const link = (event: React.MouseEvent<HTMLAnchorElement>, next: string) => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0) { event.preventDefault(); navigate(next); } };
  return <>
    {!project && <header><a className="logo" href="/" onClick={e => link(e, '/')}>Cutframe<span>LOCAL STUDIO</span></a><nav aria-label="Main navigation">{[['/assets', 'Library'], ['/settings', 'Settings'], ['/costs', 'Costs']].map(([url, label]) => <a key={url} aria-current={path === url ? 'page' : undefined} href={url} onClick={e => link(e, url)}>{label}</a>)}<button aria-label={`Theme: ${theme}`} title="Cycle theme: system, light, dark" onClick={() => setTheme(theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system')}>{theme === 'system' ? '◐' : theme === 'light' ? '☀' : '☾'}</button></nav></header>}
    {project ? <EditorRoute key={project[1]} id={project[1]} navigate={navigate} /> : <main>{path === '/assets' ? <Library /> : path === '/settings' || path === '/costs' ? <><h1>{path === '/settings' ? 'Settings' : 'Costs'}</h1><p>This page is not yet implemented (T21).</p>{path === '/costs' && <p>Cutframe has no subscription, watermark or paid core limits. Available local space depends on this browser and device.</p>}</> : <Home navigate={navigate} />}
      <footer>No AI provider connected. <span>Alt+N focuses notifications.</span></footer>
    </main>}
    {!project && <div className="help"><button aria-label="Help & Resources" aria-expanded={help} onClick={() => setHelp(!help)}>?</button>{help && <div role="menu" aria-label="Help & Resources">{['Getting-started guide', 'Agent-setup guide', 'Community'].map(label => <button key={label} role="menuitem" onClick={() => unavailable(`${label} (destination not configured)`, 'T21')}>{label}</button>)}</div>}</div>}
    <Notifications />
    <AgentLink path={path} />
  </>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
