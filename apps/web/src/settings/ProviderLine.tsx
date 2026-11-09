// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';
import { projectStore } from '../store/database';
import { reportError } from '../ui';
import { modelFor, readProviders } from './providers';

/** The page footer's line (T01's "No AI provider connected."). */
export function ProviderLine() {
  const [line, setLine] = useState('No AI provider connected.');
  useEffect(() => { void readProviders(projectStore).then(s => { const choice = modelFor(s, 'chat'); if (choice) setLine(`AI: ${choice.connection.label}, ${choice.model}.`); }).catch(reportError); }, []);
  return <>{line}</>;
}
