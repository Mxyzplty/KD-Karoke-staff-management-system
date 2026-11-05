// SPDX-License-Identifier: AGPL-3.0-only
// T18a tab protocol (master plan §1a Contract A), shared by the helper (apps/helper) and the editor tab (this folder).
// Pure data: no DOM, no Node, so both sides import it.

export const PROTOCOL = 1;
export const APP = 'cutframe-helper';
export const DEFAULT_PORT = 47820;
export const PORT_RANGE = 10; // 47820–47829
export const RESOURCE_URI = 'cutframe://project/state';
export const PING_MS = 15_000;
/** No message from the other side for this long → the link is dead (Xapp's 60 s stream stall, findings §10b.2). */
export const STALL_MS = 60_000;
export const RESOURCE_QUIET_MS = 500;
export const CODE_TTL_MS = 5 * 60_000;
/** Xapp's reconnect schedule (findings §10b.2): 250 ms, 1 s, 2 s, 4 s, then 8 s; at most 10 attempts; 5 s stable resets. */
export const RECONNECT_DELAYS = [250, 1000, 2000, 4000, 8000];
export const RECONNECT_MAX = 10;
export const RECONNECT_STABLE_MS = 5000;

/** WebSocket close codes the helper uses (4000–4999 are application codes). */
export const CLOSE = { superseded: 4409, unauthorized: 4401, replaced: 4410, protocol: 4400, shutdown: 4503 } as const;

/** The 30 served tools: the 15 T03 tools, the 3 T04 tools (editProperties, setTimeRemap, writeKeyframes), the 2 T08 tools
 *  (addMotionGraphic, editMotionGraphic), T19's syncAndSwap and viewItemDetails (transcript, keyframes, beats), T10's
 *  writeEffects, T06's addShape and writeShapePoints, T07's addLayout and editLayout, T11's applyTransition, T05's addText,
 *  and `context` (layout L). Every other T18 name stays unserved (searchProjectAssets / searchUserLibrary too: Q6; `fonts`
 *  too: T05 ruling Q2). */
export const SERVED_TOOLS = ['addLayout', 'addMedia', 'addMotionGraphic', 'addShape', 'addText', 'applyTransition', 'changeTrack', 'cloneItem', 'consolidateTracks', 'context', 'deleteItems', 'editLayout', 'editMotionGraphic', 'editProperties', 'manageMarkers', 'manageTrack',
  'manageTrackGroup', 'moveItem', 'reorderItems', 'resizeCanvas', 'setTimeRemap', 'slipItem', 'splitItem', 'syncAndSwap', 'transformItem', 'trimItem', 'viewItemDetails',
  'writeEffects', 'writeKeyframes', 'writeShapePoints'] as const;
/** The 15 easing preset names (timeline/properties `EASINGS`; the helper's schemas cannot import that module). */
export const EASING_NAMES = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'easeInQuad', 'easeOutQuad', 'easeInOutQuad', 'easeInCubic', 'easeOutCubic', 'easeInOutCubic',
  'easeInBack', 'easeOutBack', 'easeInOutBack', 'easeOutElastic', 'easeOutBounce'] as const;
/** Read-only set: skips the execution ledger and `timelineChanges` (agent tool results A0.2 item 1). */
export const READ_ONLY = new Set(['viewItemDetails', 'context', 'fonts', 'listEffects', 'getEffectDetails', 'captureFrame', 'viewMaskFrame', 'listAllowedDir',
  'listCaptionTemplates', 'getMotionGraphicCode', 'searchStockMedia']);
/** Timeline-scope stale-read gate (agent tool results A0.2 item 3): always checked for these tools. */
export const TIMELINE_GATED = new Set(['addMedia', 'addText', 'addShape', 'addCaptions', 'addMotionGraphic', 'addLayout', 'changeTrack', 'cloneItem', 'consolidateTracks',
  'deleteItems', 'manageTrack', 'manageTrackGroup', 'moveItem', 'reorderItems', 'splitItem', 'slipItem', 'trimItem']);

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type ToolResult = { success: boolean; [k: string]: unknown };

/** Tab → helper. `hello` carries the pairing token once paired, the helper-issued `connId` to resume a link, and
 *  `takeover` (opening the editor / focus: true; the manual Connect button: false). */
export type TabMessage =
  | { type: 'hello'; protocol: number; projectId: string | null; tabId: string; token?: string; connId?: string; takeover?: boolean }
  | { type: 'pair'; code: string; offer?: boolean }
  | { type: 'result'; callId: string; result?: ToolResult; error?: { code: string; message: string } }
  | { type: 'event'; name: string; data?: Json }
  | { type: 'revoke' }
  | { type: 'ping' } | { type: 'pong' };
/** Helper → tab. `hello` is the answer to the tab's hello; `error` refuses a hello / pair / takeover. */
export type HelperMessage =
  | { type: 'hello'; protocol: number; version: string; connId: string; paired: boolean; active: boolean }
  | { type: 'paired'; token: string }
  | { type: 'call'; callId: string; executionKey: string; toolName: string; input: Record<string, unknown>; session?: string; resource?: boolean }
  | { type: 'takeover'; byTabId?: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'ping' } | { type: 'pong' };

/** Helper-side codes for the link (Cutframe's own; Xapp's hosted flow uses HTTP statuses, findings §10b.2). */
export const LINK_ERRORS = {
  PAIRING_REQUIRED: 'This tab is not paired with the helper. Enter the 6-digit code the helper printed.',
  PAIRING_CODE_INVALID: 'That pairing code is not valid. Check the code the helper printed and try again.',
  PAIRING_CODE_EXPIRED: 'That pairing code has expired. Ask the helper for a new code and try again.',
  PAIRING_LOCKED: 'Too many wrong pairing codes, so the helper stopped taking codes. Type “code” in the helper’s terminal for a new one, or type the code this tab shows into the helper.',
  TOKEN_INVALID: 'This tab’s pairing is unknown to the helper or was revoked. Pair again.',
  TOKEN_REVOKED: 'This tab’s pairing was revoked. Pair again to reconnect.',
  TAB_ACTIVE_ELSEWHERE: 'Another tab holds the MCP connection.',
  PROTOCOL_UNSUPPORTED: 'This helper speaks a different tab protocol version. Update the helper or the editor.',
  INVALID_MESSAGE: 'The helper could not read that message.',
} as const;
export type LinkError = keyof typeof LINK_ERRORS;

export const TIMEOUT_ERROR = 'MCP tool timed out — the browser may not be connected or the operation is still running. Check browser connection and retry.';
export const NOT_CONNECTED_ERROR = 'No editor tab is connected to the helper. Open a project in Cutframe, press Connect tab, then retry.';
export const DISCONNECTED_ERROR = 'The editor tab disconnected while the call was running, so its result is unknown. Read context before retrying.';
