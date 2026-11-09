// SPDX-License-Identifier: AGPL-3.0-only
// T21 per-client install guides (§28), shared by onboarding and the External Agent card. The helper runs from a checkout of
// this repository until the package is published, so every command starts in that folder. Claude Desktop reads a config file.
import { useState } from 'react';
import { notify } from '../ui';

export type Client = 'claude-code' | 'claude-desktop' | 'codex' | 'any';
export const HELPER_COMMAND = 'npx cutframe-connect';
export const MCP_URL = 'http://127.0.0.1:47820/mcp';
// Claude Desktop launches the server from its own working directory, so a bare `npx cutframe-connect` cannot resolve while the
// package is unpublished. Point node straight at the helper's bin in the checkout; node is cross-platform (no cmd /c needed).
const HELPER_BIN = '<path-to-cutframe>/apps/helper/bin/cutframe-connect.mjs';
const STDIO_CONFIG = JSON.stringify({ mcpServers: { cutframe: { command: 'node', args: [HELPER_BIN, '--stdio'] } } }, null, 2);
export type GuideStep = { text: string; command?: string };
export type Guide = { client: Client; label: string; steps: GuideStep[]; check: string; trouble: string };
export const GUIDES: Guide[] = [
  { client: 'claude-code', label: 'Claude Code', check: 'Run /mcp in Claude Code. cutframe should be listed as connected.', trouble: 'If cutframe shows as failed, check that the helper terminal is still open, then run the command again.', steps: [
    { text: 'Start the helper in a terminal, in the Cutframe folder, and leave it open.', command: HELPER_COMMAND },
    { text: 'In another terminal, add the helper to Claude Code.', command: `claude mcp add --transport http cutframe ${MCP_URL}` },
    { text: 'Open a project in Cutframe, connect this tab and enter the pairing code.' },
  ] },
  { client: 'claude-desktop', label: 'Claude Desktop', check: 'Restart Claude Desktop. cutframe should appear in its connectors.', trouble: 'If it does not appear, check that the JSON is valid and that the path points at this checkout’s apps/helper/bin/cutframe-connect.mjs.', steps: [
    { text: 'Open Settings, then Developer, then Edit Config in Claude Desktop, and add this server. Replace <path-to-cutframe> with the folder where Cutframe is checked out.', command: STDIO_CONFIG },
    { text: 'Restart Claude Desktop. It starts the helper itself.' },
    { text: 'Open a project in Cutframe, connect this tab and enter the pairing code.' },
  ] },
  { client: 'codex', label: 'Codex', check: 'Run codex mcp list. cutframe should be listed.', trouble: 'If the tools stay missing, start a new Codex session: tools are read at start-up.', steps: [
    { text: 'Start the helper in a terminal, in the Cutframe folder, and leave it open.', command: HELPER_COMMAND },
    { text: 'In another terminal, add the helper to Codex.', command: `codex mcp add cutframe --url ${MCP_URL}` },
    { text: 'Open a project in Cutframe, connect this tab and enter the pairing code.' },
  ] },
  { client: 'any', label: 'Any client', check: 'Ask your client to list its tools. The Cutframe tools should appear.', trouble: 'A client that only speaks stdio can start the helper itself with npx cutframe-connect --stdio.', steps: [
    { text: 'Start the helper in a terminal, in the Cutframe folder, and leave it open.', command: HELPER_COMMAND },
    { text: 'Add this Streamable HTTP MCP server to your client. The helper prints the port if 47820 was taken.', command: MCP_URL },
    { text: 'Open a project in Cutframe, connect this tab and enter the pairing code.' },
  ] },
];
/** Row 14: a page outside the editor's own origins cannot see the helper at all, so the fix has to name this page's origin. */
export const allowOriginCommand = (origin = location.origin) => `${HELPER_COMMAND} --allow-origin ${origin}`;
export function CopyLine({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => notify('Copying was refused by this browser. Select the text instead.'));
  return <div className="copy-line"><code>{text}</code><button onClick={() => void copy()}>{copied ? 'Copied' : label}</button></div>;
}
export function ClientGuide({ guide }: { guide: Guide }) {
  return <div className="client-guide" data-client={guide.client}>
    <ol>{guide.steps.map(step => <li key={step.text}>{step.text}{step.command && <CopyLine text={step.command} />}</li>)}</ol>
    <p>{guide.check}</p>
  </div>;
}
export function Troubleshooting({ guide }: { guide?: Guide }) {
  return <details className="troubleshooting" data-testid="connect-troubleshooting"><summary>Troubleshooting</summary><ul>
    {guide && <li>{guide.trouble}</li>}
    <li>No helper found: start it with <code>{HELPER_COMMAND}</code> and try again.</li>
    <li>Helper running but not found, or the connection is refused: the helper accepts only the editor’s own addresses. For this page, restart it with <CopyLine text={allowOriginCommand()} /></li>
    <li>Wrong code, or pairing locked: type <code>code</code> in the helper terminal for a new code.</li>
    <li>Port taken: the helper uses the next free port from 47820 to 47829 and prints it. Enter that port here.</li>
  </ul></details>;
}
