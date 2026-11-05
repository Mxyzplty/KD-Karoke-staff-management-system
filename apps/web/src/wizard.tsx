// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from 'react';
import { projectStore } from './store/database';
import { Dialog, notify, reportError } from './ui';
import { attachReference, listReferences, uploadReference } from './media/references';
import type { ReferenceVideo } from './media/references';
import { analysisLabel } from './media-panel';
import { LibraryBrowser } from './library';
import { createProjectWithFootage } from './media/ingest';
import { acceptAttribute, mediaKind } from './media/files';
import { probeMedia } from './media/probe';
import { formatDuration } from './media-ui';

type Queued = { file: File; preview?: string; durationMs?: number | null };
export function Wizard({ close, navigate }: { close: () => void; navigate: (path: string) => void }) {
  const [step, setStep] = useState(1), [picker, setPicker] = useState<'template' | 'reference' | 'footage'>(), [selected, setSelected] = useState<string[]>([]), [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState<Queued[]>([]), computer = useRef<HTMLInputElement>(null), previews = useRef<string[]>([]);
  const [reference, setReference] = useState<ReferenceVideo>(), [references, setReferences] = useState<ReferenceVideo[]>([]), [referenceQuery, setReferenceQuery] = useState(''), referenceInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (picker === 'reference') void listReferences(projectStore).then(setReferences).catch(reportError); }, [picker]);
  /** Upload from the wizard: hashed and reused when already saved; the dialog closes and the card shows the pick. */
  async function uploadPicked(file?: File) {
    if (!file) return;
    try { const r = await uploadReference(projectStore, file); setReference(r.reference); setPicker(undefined); } catch (e) { reportError(e); }
  }
  useEffect(() => () => { for (const url of previews.current) URL.revokeObjectURL(url); }, []);
  /** Images get a preview; a video's duration is read on add (findings part 2 §26). Upload happens on Create. */
  async function add(files: File[]) {
    const next = files.filter(f => mediaKind(f.name, f.type)).map(file => {
      const preview = mediaKind(file.name, file.type) === 'image' ? URL.createObjectURL(file) : undefined;
      if (preview) previews.current.push(preview);
      return { file, preview } as Queued;
    });
    setQueued(q => [...q, ...next]);
    for (const item of next) if (mediaKind(item.file.name, item.file.type) !== 'image') {
      const durationMs = await probeMedia(item.file, item.file.name, mediaKind(item.file.name, item.file.type)!).then(i => i.durationMs).catch(() => null);
      setQueued(q => q.map(x => x.file === item.file ? { ...x, durationMs } : x));
    }
  }
  async function create() {
    if (busy) return; setBusy(true);
    try {
      // Footage uploads are queued for the new project: name + size matches are reused silently (no dialog in the wizard).
      const { project, result } = await createProjectWithFootage(projectStore, queued.map(q => q.file), selected);
      for (const f of result.failed) reportError(f.error);
      // The picked library reference is attached once the project exists (findings part 2 §26; T22 builds on this).
      if (reference) await attachReference(projectStore, project.id, reference.id).catch(() => notify('Project created, but the reference could not be attached.'));
      navigate(`/project/${project.id}`);
    } catch (e) { reportError(e); setBusy(false); }
  }
  return <Dialog title="New Video" close={busy ? () => {} : close}>
    <div className="steps" aria-label={`Step ${step} of 2`}><i className={step === 1 ? 'active' : ''} /><i className={step === 2 ? 'active' : ''} /></div>
    {step === 1 ? <>
      <h3>Project Setup</h3><p>Choose a template and optional reference, or start fresh.</p>
      <div className="setup-card"><h4>Template</h4><p>Bring a reusable style and structure to your project.</p><button onClick={() => setPicker('template')}>Choose template</button><button onClick={() => setPicker('template')}>Change</button><button disabled>Remove</button></div>
      <div className="setup-card"><h4>Reference Video <small>Optional</small></h4>{reference ? <><p>{reference.name}</p><p><small>From your library</small></p><button onClick={() => setReference(undefined)}>Remove</button></> : <><button onClick={() => referenceInput.current?.click()}>Upload a reference</button><button onClick={() => setPicker('reference')}>From your library</button></>}</div>
      <input ref={referenceInput} type="file" hidden accept="video/*,.mp4,.mov,.webm,.mkv,.m4v" aria-label="Choose a reference video" onChange={e => { void uploadPicked(e.target.files?.[0]); e.target.value = ''; }} />
      <div className="dialog-actions"><button onClick={close}>Cancel</button><button className="primary" onClick={() => setStep(2)}>Continue</button></div>
    </> : <>
      <h3>Add Your Footage</h3><p>Choose clips, photos or audio. You can also start with an empty project.</p>
      <div className="drop-zone" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); void add(Array.from(e.dataTransfer.files)); }}><p>Add media to your project</p><button onClick={() => computer.current?.click()}>Computer</button><button onClick={() => setPicker('footage')}>Library</button>
        <input ref={computer} type="file" multiple hidden accept={`${acceptAttribute},video/*,image/*,audio/*`} aria-label="Add footage from this computer" onChange={e => { void add(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
        <p>{queued.length + selected.length} files selected</p>
        {queued.length > 0 && <ul className="queued" aria-label="Footage to upload">{queued.map((q, i) => <li key={`${q.file.name}-${i}`}>{q.preview ? <img src={q.preview} alt="" /> : null}<span>{q.file.name}</span>{q.durationMs ? <small>{formatDuration(q.durationMs)}</small> : null}<button aria-label={`Remove ${q.file.name}`} onClick={() => setQueued(x => x.filter(y => y !== q))}>×</button></li>)}</ul>}
      </div>
      <div className="dialog-actions"><button disabled={busy} onClick={() => setStep(1)}>← Back</button><button className="primary" disabled={busy} onClick={() => void create()}>{busy ? 'Creating…' : 'Create Project'}</button></div>
    </>}
    {picker === 'template' && <Dialog title="Choose template" close={() => setPicker(undefined)}><p>Template selection is not yet implemented (T22).</p></Dialog>}
    {picker === 'reference' && <Dialog title="Reference library" close={() => setPicker(undefined)}><span className="chip">{references.length} saved</span><p>Choose a reference to attach when the project is created.</p><input aria-label="Search reference videos" placeholder="Search reference videos" value={referenceQuery} onChange={e => setReferenceQuery(e.target.value)} />
      {!references.length ? <p>No reference videos yet.</p> : <ul className="reference-list" aria-label="Saved references">{references.filter(r => r.name.toLowerCase().includes(referenceQuery.trim().toLowerCase())).map(r => <li key={r.id}><button onClick={() => { setReference(r); setPicker(undefined); }}>{r.name}</button><small>{analysisLabel(r)}</small></li>)}</ul>}
      <button onClick={() => referenceInput.current?.click()}>Upload reference video</button></Dialog>}
    {picker === 'footage' && <Dialog title="Choose footage" close={() => setPicker(undefined)}><LibraryBrowser picker selected={selected} onSelected={setSelected} /><div className="dialog-actions"><button onClick={() => setPicker(undefined)}>Done</button></div></Dialog>}
  </Dialog>;
}
