// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';
import { projectStore } from './store/database';
import { projectDateLabel } from './store/model';
import type { ProjectRecord } from './store/model';
import { Dialog, InlineName, notify, reportError } from './ui';
import { Wizard } from './wizard';
export function Home({ navigate }: { navigate: (path: string) => void }) {
  const [projects, setProjects] = useState<ProjectRecord[]>([]), [loading, setLoading] = useState(true), [failed, setFailed] = useState(false);
  const [rename, setRename] = useState<string>(), [menu, setMenu] = useState<string>(), [deleting, setDeleting] = useState<ProjectRecord>();
  const [newProject, setNewProject] = useState(false), [name, setName] = useState(''), [busy, setBusy] = useState(false), [wizard, setWizard] = useState(false);
  async function refresh() { setLoading(true); try { setProjects(await projectStore.list()); setFailed(false); } catch (e) { setFailed(true); reportError(e); } finally { setLoading(false); } }
  useEffect(() => { void refresh(); }, []);
  async function create() {
    if (busy) return; setBusy(true);
    try { const project = await projectStore.create(name); navigate(`/project/${project.id}`); }
    catch (e) { reportError(e); } finally { setBusy(false); }
  }
  return <>
    <section className="home-intro"><p className="eyebrow">YOUR LOCAL WORKSPACE</p><h1>Make room for your next idea.</h1><p>Projects and media stay in this browser.</p><button className="primary" onClick={() => setWizard(true)}>＋ New Video</button></section>
    <section><div className="section-heading"><h2>Your Projects</h2><button onClick={() => setNewProject(!newProject)}>＋ New Project</button></div>
      {newProject && <form className="new-project" aria-label="New Project" onSubmit={e => { e.preventDefault(); void create(); }}><input autoFocus aria-label="Project name" placeholder="Project name" value={name} onChange={e => setName(e.target.value)} /><button disabled={busy} type="submit">{busy ? 'Creating…' : 'Create'}</button></form>}
      {loading ? <p>Loading projects…</p> : failed ? <button onClick={() => void refresh()}>Retry loading projects</button> : projects.length === 0 ? <p className="empty">Start with New Video to create your first project.</p> : <ul className="project-list">
        {projects.map(p => <li key={p.id}>
          <span aria-hidden="true">▤</span>{rename === p.id ? <InlineName initial={p.title} label="Project title" cancel={() => setRename(undefined)} commit={name => { setRename(undefined); void projectStore.renameProject(p.id, name).then(refresh).catch(reportError); }} /> : <button className="project-title" onClick={() => navigate(`/project/${p.id}`)}>{p.title}</button>}
          <time dateTime={p.updated_at}>{projectDateLabel(p.updated_at)}</time><div className="row-actions"><button aria-label={`Actions for ${p.title}`} aria-expanded={menu === p.id} onClick={() => setMenu(menu === p.id ? undefined : p.id)}>…</button>
            {menu === p.id && <div role="menu"><button role="menuitem" onClick={() => { setRename(p.id); setMenu(undefined); }}>Rename</button><button role="menuitem" className="danger" onClick={() => { setDeleting(p); setMenu(undefined); }}>Delete</button></div>}
          </div>
        </li>)}
      </ul>}
    </section>
    {deleting && <Dialog title="Delete project" close={() => setDeleting(undefined)}><p>Delete “{deleting.title}”? This permanently removes the project and its local project files.</p><div className="dialog-actions"><button onClick={() => setDeleting(undefined)}>Cancel</button><button className="danger" onClick={() => { const id = deleting.id; setDeleting(undefined); void projectStore.deleteProject(id).then(async () => { notify('Project deleted.'); await refresh(); }).catch(reportError); }}>Delete</button></div></Dialog>}
    {wizard && <Wizard close={() => setWizard(false)} navigate={navigate} />}
  </>;
}
