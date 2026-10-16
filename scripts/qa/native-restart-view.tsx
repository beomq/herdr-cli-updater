// Isolated visual interaction fixture; never imported by the product entry.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AppCommand, AppSnapshot } from '../../src/app/types';
import type { Installation, TargetSelection } from '../../src/protocol';
import { Surface } from '../../web/app';
import type { View } from '../../web/app';
import { LanguageProvider } from '../../web/i18n';
import '../../web/styles.css';
const installation: Installation = {
  installationId: 'codex-install', family: 'codex', channel: 'latest', executableRealpath: '/fixture/codex',
  resources: [], resourcesFingerprint: 'fixture', owner: { kind: 'package', manager: 'npm', packageName: '@openai/codex', prefix: '/fixture' },
  installedVersion: { kind: 'known', version: '0.116.0' }, lastCheck: null,
};
const target: TargetSelection = { targetId: 'native-target', runtimeId: 'native-runtime', installationId: installation.installationId,
  expectedBinding: { socketId: 'socket', socketEpoch: 'epoch', paneId: 'pane-codex', paneGeneration: 3,
    rootIncarnation: { pid: 123, startIdentity: 'start-3', executableRealpath: '/fixture/codex' },
    session: { kind: 'conversation', fullId: '019d0000-1111-2222-3333-444455556666', storagePathHash: 'storage' },
    cwd: '/fixture/project', optionsRef: 'settings', turnGeneration: 2, resourcesFingerprint: 'fixture' } };
const capability = { kind: 'supported', reason: 'verified', evidenceRef: 'fixture' } as const;
const snapshot: AppSnapshot = {
  revision: 1, service: 'ready', installations: [], managed: [], external: [], operations: [], policies: [], failure: null,
  native: { jobs: [], failure: null, selections: [{ installation, update: { kind: 'unsupported', reason: 'not_verified' },
    readiness: capability, targets: [{ target, runningVersion: { kind: 'known', version: '0.115.0' },
      readiness: capability, completion: capability, gracefulExit: capability, resume: capability }] }] },
};
function Harness() {
  const [view, setView] = useState<View>('sessions');
  const [command, setCommand] = useState<AppCommand | null>(null);
  return <><Surface snapshot={snapshot} view={view} onView={setView} disabled={false}
    act={async command => { setCommand(command); return true; }}/><output data-testid="command" hidden>{JSON.stringify(command)}</output></>;
}
const root = document.getElementById('root');
if (!root) throw new Error('fixture_root_missing');
createRoot(root).render(<LanguageProvider><Harness/></LanguageProvider>);
