// SPDX-License-Identifier: AGPL-3.0-only
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

/** T19 (dev only): the same-origin model root `/models/`, served from `$CUTFRAME_FIXTURES/models/t19a` (or `t19`, `t12`) when
 *  `CUTFRAME_LOCAL_MODELS=1` is also set (opt-in: otherwise every dev server, UI tests included, would run real inference
 *  on each upload). Only files listed in datasets/manifest.json are served; anything else is a 404, so a missing model
 *  shows as an "unavailable" step. */
function localModels(): Plugin {
  return {
    name: 'cutframe-local-models', apply: 'serve',
    configureServer(server) {
      const store = process.env.CUTFRAME_FIXTURES;
      if (!store || process.env.CUTFRAME_LOCAL_MODELS !== '1') return;
      const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('datasets/manifest.json', import.meta.url)), 'utf8')) as { models?: { files: { path: string }[] }[] };
      const listed = new Set((manifest.models ?? []).flatMap(m => m.files.map(f => f.path)));
      server.middlewares.use('/models/', (req, res) => {
        let relative: string;
        try { relative = decodeURIComponent(new URL(req.url ?? '/', 'http://local').pathname).replace(/^\/+/, ''); } catch { relative = ''; }
        const file = ['models/t19a/', 'models/t19/', 'models/t12/'].map(prefix => prefix + relative).find(p => !relative.split('/').includes('..') && listed.has(p) && existsSync(path.join(store, p)));
        if (!file) { res.statusCode = 404; res.end(); return; }
        const abs = path.join(store, file);
        res.setHeader('Content-Type', file.endsWith('.json') ? 'application/json' : file.endsWith('.txt') ? 'text/plain' : 'application/octet-stream');
        res.setHeader('Content-Length', statSync(abs).size);
        createReadStream(abs).pipe(res);
      });
    },
  };
}
// T14: pre-bundle the media libraries so the dev server never reloads the page when a worker first imports them.
export default defineConfig({ root: 'apps/web', build: { outDir: '../../dist', emptyOutDir: true }, server: { host: '127.0.0.1' }, optimizeDeps: { include: ['mediabunny', '@mediabunny/ac3', 'exifr'] }, worker: { format: 'es' }, plugins: [localModels()] });
