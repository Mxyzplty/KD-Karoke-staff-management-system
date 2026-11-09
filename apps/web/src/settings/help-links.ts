// SPDX-License-Identifier: AGPL-3.0-only
// T21 Help & Resources links, shared by the page chrome and the editor menu; apart from HelpPage so they load without the corpus.
import { notify } from '../ui';

export const COMMUNITY_URL: string | null = null;
export const HELP_LINKS: { label: string; path?: string }[] = [{ label: 'Getting-started guide', path: '/help/getting-started' }, { label: 'Agent-setup guide', path: '/help/agent-setup' }, { label: 'Community' }];
/** T01: no URL is guessed. Community opens once COMMUNITY_URL is set. */
export function openHelpLink(link: { path?: string }, navigate: (path: string) => void) {
  if (link.path) return navigate(link.path);
  if (COMMUNITY_URL) window.open(COMMUNITY_URL, '_blank', 'noopener');
  else notify('No community space has been set up yet.');
}
