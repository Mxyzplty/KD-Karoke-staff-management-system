// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: 'tests/ui', testMatch: '**/*.spec*.ts', use: { baseURL: 'http://127.0.0.1:4173' }, webServer: { command: 'npm run dev -- --port 4173 --strictPort', url: 'http://127.0.0.1:4173', reuseExistingServer: !process.env.CI }, reporter: 'list' });
