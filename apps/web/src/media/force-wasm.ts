// SPDX-License-Identifier: AGPL-3.0-only
// The forced-fallback switch on its own, so a caller on the play path (audio/source.ts) reads it without loading
// worker-client and its imports (worker-client re-exports it for its other callers).
/** Forced-fallback switch: `?wasm-decode=1` (or localStorage `cutframe:force-wasm` = "1") routes every decode through WASM. */
export const forceWasm = () => { try { return new URLSearchParams(location.search).has('wasm-decode') || localStorage.getItem('cutframe:force-wasm') === '1'; } catch { return false; } };
