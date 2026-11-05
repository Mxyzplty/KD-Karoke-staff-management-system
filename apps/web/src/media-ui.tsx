// SPDX-License-Identifier: AGPL-3.0-only
// Shared T14 UI pieces: asset poster with duration/status badges, the "Duplicate file found" dialog, relink/retry.
import { useEffect, useRef, useState } from 'react';
import { projectStore } from './store/database';
import type { Asset } from './store/model';
import type { ThumbnailRow } from './media/prepare';
import { mediaError } from './media/codes';
import type { MediaCode } from './media/codes';
import type { Duplicate } from './media/ingest';
import { Dialog } from './ui';
import { dispatch } from './editor/commands';

/** Placement seam: T03 owns timeline placement (append after the last clip, drop position, "Add items"). */
export const placeOnTimeline = (what: string, assetIds: string[] = []) => dispatch({ type: 'placeAssets', assetIds, name: what });

export const formatDuration = (ms: number) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
/** Object URL of an asset's poster (thumbnail worker output in IndexedDB); refreshes when `version` changes. */
export function usePoster(assetId: string, version: unknown): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let alive = true, made: string | undefined;
    void projectStore.row<ThumbnailRow>('thumbnails', assetId).then(row => { if (alive && row) { made = URL.createObjectURL(row.poster); setUrl(made); } }).catch(() => {});
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [assetId, version]);
  return url;
}
export const statusLabel = (a: Asset, missing: boolean) => missing || a.last_error_code === 'OBJECT_MISSING' ? 'Missing' : a.processing_status === 'uploading' ? 'Uploading' : a.processing_status === 'processing' ? 'Processing' : a.processing_status === 'failed' ? 'Failed' : null;
/** T19: a ready asset whose analysis, transcription or search index failed (it stays usable; Retry re-runs it). The code
 *  is the asset's error, else its first failed T19 step's: a proxy failure on the same asset holds `last_error_code`. */
const ANALYSIS_FAILURES: MediaCode[] = ['GEMINI_FAILED', 'TRANSCRIPTION_FAILED', 'EMBEDDING_FAILED'];
const FAILED_STEPS = [['analysis', 'GEMINI_FAILED'], ['transcription', 'TRANSCRIPTION_FAILED'], ['embeddings_description', 'EMBEDDING_FAILED'], ['embeddings_transcript', 'EMBEDDING_FAILED']] as const;
export const analysisFailure = (a: Asset): MediaCode | null => a.processing_status !== 'ready' ? null
  : ANALYSIS_FAILURES.find(c => c === a.last_error_code) ?? FAILED_STEPS.find(([step]) => a.processing_steps?.[step] === 'failed')?.[1] ?? null;
export const analysisFailed = (a: Asset) => analysisFailure(a) !== null;
export function AssetPoster({ asset, missing = false }: { asset: Asset; missing?: boolean }) {
  const url = usePoster(asset.id, `${asset.processing_status}:${asset.processing_steps?.thumbnails}`), status = statusLabel(asset, missing), failed = status ? null : analysisFailure(asset);
  return <div className="asset-poster" aria-hidden={!status && !failed}>
    {url ? <img src={url} alt="" /> : <span aria-hidden="true">{asset.type === 'audio' ? '♫' : asset.type === 'image' ? '▧' : '▷'}</span>}
    {asset.durationMs !== null && <span className="badge duration" aria-label={`Duration ${formatDuration(asset.durationMs)}`}>{formatDuration(asset.durationMs)}</span>}
    {status && <span className={`badge status ${status.toLowerCase()}`} title={asset.last_error_message ?? undefined}>{status}{asset.last_error_code && status !== 'Processing' ? ` · ${asset.last_error_code}` : ''}</span>}
    {failed && <span className="badge status failed" title={failed === asset.last_error_code ? asset.last_error_message ?? undefined : mediaError(failed).message}>Analysis failed · {failed}</span>}
  </div>;
}
/** Library-page duplicate dialog (part 2 §25): lists original → renamed; Skip Duplicates or Upload & Rename. */
export function DuplicateDialog({ duplicates, answer }: { duplicates: Duplicate[]; answer: (choice: 'skip' | 'rename' | 'cancel') => void }) {
  return <Dialog title="Duplicate file found" close={() => answer('cancel')}>
    <p>{duplicates.length === 1 ? 'A file with this name is already in your library.' : `${duplicates.length} files with these names are already in your library.`} Upload under a new name, or skip it.</p>
    <ul className="duplicates">{duplicates.map(d => <li key={d.renamed}>{d.original} → {d.renamed}</li>)}</ul>
    <div className="dialog-actions"><button onClick={() => answer('skip')}>Skip Duplicates</button><button className="primary" onClick={() => answer('rename')}>Upload &amp; Rename</button></div>
  </Dialog>;
}
/** Turns the dialog into a promise for uploadToLibrary's `choice` callback. */
export function useDuplicateChoice() {
  const [pending, setPending] = useState<{ duplicates: Duplicate[]; resolve: (c: 'skip' | 'rename' | 'cancel') => void }>();
  const ask = (duplicates: Duplicate[]) => new Promise<'skip' | 'rename' | 'cancel'>(resolve => setPending({ duplicates, resolve }));
  const dialog = pending && <DuplicateDialog duplicates={pending.duplicates} answer={c => { pending.resolve(c); setPending(undefined); }} />;
  return { ask, dialog };
}
/** A hidden single-file input that resolves with the picked file (relink). */
export function useFilePick() {
  const input = useRef<HTMLInputElement>(null), resolver = useRef<(f: File | null) => void>(undefined);
  const pick = () => new Promise<File | null>(resolve => { resolver.current = resolve; input.current?.click(); });
  const element = <input ref={input} type="file" hidden aria-label="Choose the original file" onChange={e => { resolver.current?.(e.target.files?.[0] ?? null); e.target.value = ''; }} />;
  return { pick, element };
}
