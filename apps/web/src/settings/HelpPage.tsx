// SPDX-License-Identifier: AGPL-3.0-only
// T21 /help and /help/<id>: the corpus read by people, the same text the help tools give agents.
import { useState } from 'react';
import type { MouseEvent } from 'react';
import { HELP_SECTIONS, searchHelp } from './help';

export function HelpPage({ id, navigate }: { id?: string; navigate: (path: string) => void }) {
  const [query, setQuery] = useState(''), section = HELP_SECTIONS.find(s => s.section_id === id), results = query.trim() ? searchHelp(query) : null;
  const open = (next: string) => (e: MouseEvent) => { e.preventDefault(); navigate(next); };
  const parents = [...new Set(HELP_SECTIONS.map(s => s.parent_section))];
  return <div className="help-page"><h1>Help</h1>
    <input aria-label="Search help" placeholder="Ask a question" value={query} onChange={e => setQuery(e.target.value)} />
    {results ? results.length ? <ul className="settings-list" aria-label="Search results">{results.map(s => <li key={s.section_id}><a href={`/help/${s.section_id}`} onClick={e => { setQuery(''); open(`/help/${s.section_id}`)(e); }}>{s.section_title}</a></li>)}</ul> : <p className="empty">No matching help. Try a few more words.</p>
      : section ? <article data-section={section.section_id}><p className="eyebrow">{section.parent_section}</p><h2>{section.section_title}</h2><p>{section.content}</p><p><a href="/help" onClick={open('/help')}>All help</a></p></article>
      : parents.map(parent => <section key={parent}><h2>{parent}</h2><ul className="settings-list">{HELP_SECTIONS.filter(s => s.parent_section === parent).map(s => <li key={s.section_id}><a href={`/help/${s.section_id}`} onClick={open(`/help/${s.section_id}`)}>{s.section_title}</a></li>)}</ul></section>)}
  </div>;
}
