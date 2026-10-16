import { useState } from 'react';
import type { AppCommand, AppSnapshot } from '../src/app/types';
import type { InstallSelection, TargetSelection, TargetTransaction, VersionEvidence } from '../src/protocol';
import { Badge, Button, Dialog, Facts, Notice, Panel, SectionHead } from './primitives';
import { useLanguage } from './i18n';

export function NativeRestarts({ snapshot, act, disabled }: {
  snapshot: AppSnapshot; act: (command: AppCommand) => Promise<boolean>; disabled: boolean;
}) {
  const { t } = useLanguage();
  const [selected, setSelected] = useState<{ installation: InstallSelection; target: TargetSelection; server: string | undefined } | null>(null);
  const native = snapshot.native;
  const busy = snapshot.operations.some(operation => !['completed', 'failed', 'cancelled'].includes(operation.stage))
    || native?.jobs.some(job => !['completed', 'failed', 'cancelled'].includes(job.status));
  const version = (value: VersionEvidence) => value.kind === 'known' ? value.version : t('수집되지 않음', 'Not captured');
  const stale = selected && (snapshot.serverInstance !== selected.server || !native?.selections.some(row =>
    row.installation.installationId === selected.installation.installationId
    && row.installation.resourcesFingerprint === selected.installation.resourcesFingerprint
    && JSON.stringify(row.installation.owner) === JSON.stringify(selected.installation.owner)
    && JSON.stringify(row.installation.installedVersion) === JSON.stringify(selected.installation.installedVersion)
    && row.targets.some(item => JSON.stringify(item.target) === JSON.stringify(selected.target))));
  return <Panel>
    <SectionHead title={t('연결된 CLI 세션', 'Connected CLI sessions')}
      count={native?.selections.reduce((count, row) => count + row.targets.length, 0) ?? 0}>
      <Button disabled={disabled} onClick={() => void act({ kind: 'refresh' })}>{t('다시 확인', 'Refresh')}</Button>
    </SectionHead>
    <p className="muted">{t('설치 업데이트와 별개로 선택한 세션을 다시 시작합니다. 현재 작업이 끝난 뒤 같은 대화를 이어갑니다.',
      'Restart a selected session independently of installation updates. Current work finishes naturally before the same conversation resumes.')}</p>
    {!native?.selections.length && <Notice>{t('재시작 가능한 연결이 없습니다. 현재 설치와 네이티브 세션의 준비 정보를 등록한 뒤 다시 확인하세요.',
      'No qualified restart target is connected. Register current installation and native session preparation, then refresh.')}</Notice>}
    {native?.failure && <Notice tone="warning">{t('연결을 검증하지 못했습니다. 준비 정보와 코어 상태를 확인하세요.',
      'The connection could not be verified. Check preparation and core state.')} <code>{native.failure}</code></Notice>}
    {native?.selections.flatMap(row => row.targets.map(item => <div className="stack" key={item.target.targetId}>
      <h3>Codex · {item.target.expectedBinding.paneId}</h3>
      <Facts items={[
        [t('설치된 버전', 'Installed version'), version(row.installation.installedVersion)],
        [t('실행 중인 버전', 'Running version'), version(item.runningVersion)],
        [t('대화 ID', 'Conversation ID'), <span className="path">{item.target.expectedBinding.session.fullId}</span>],
      ]}/>
      <details><summary>{t('기술 정보','Technical details')}</summary><Facts items={[
        [t('설치 ID','Installation ID'), row.installation.installationId],
        [t('세션 세대','Session generation'), item.target.expectedBinding.paneGeneration],
      ]}/></details>
      <Button disabled={disabled || busy} onClick={() => setSelected({ target: item.target, server: snapshot.serverInstance,
        installation: { installationId: row.installation.installationId, resourcesFingerprint: row.installation.resourcesFingerprint,
          owner: row.installation.owner, installedVersion: row.installation.installedVersion } })}>
        {t('세션 재시작 검토', 'Review session restart')}
      </Button>
    </div>))}
    {native?.jobs.map(job => {
      const targets: readonly TargetTransaction[] = job.targetTxns;
      return <details key={job.jobId}>
      <summary>{t('재시작 기록', 'Restart record')} · <Badge tone={job.status === 'completed' ? 'success' : 'neutral'}>
        {job.status === 'completed' ? t('검증 완료', 'Verified') : job.status === 'recovery_required'
          ? t('확인 필요 · 재시도 금지', 'Inspection required · do not retry') : job.status === 'cancelled'
            ? t('취소됨', 'Cancelled') : t('진행 중', 'In progress')}
      </Badge></summary>
      <p>{t('설치 파일 변경 없음', 'No installation files changed')}</p>
      {targets.map(target => <Facts key={target.targetId} items={[
        [t('대화 ID', 'Conversation ID'), <span className="path">{target.expectedBinding.session.fullId}</span>],
        [t('이전 세대', 'Previous generation'), target.expectedBinding.paneGeneration],
        [t('확인된 세대', 'Verified generation'), target.state === 'completed' && target.receipt?.kind === 'completed'
          ? target.receipt.identity?.paneGeneration : t('미확인', 'Unverified')],
      ]}/>)}
    </details>; })}
    {selected && <Dialog title={t('선택한 세션 다시 시작', 'Restart selected session')} onClose={() => setSelected(null)}>
      <p>{t('현재 작업 완료를 기다린 뒤 종료하고, 현재 설치된 버전으로 같은 대화를 다시 엽니다. 설치 업데이트는 실행하지 않습니다.',
        'Wait for current work to finish, stop the session, then open the same conversation using the installed version. No installation update runs.')}</p>
      <p className="path">{selected.target.expectedBinding.session.fullId}</p>
      <p className="path">{selected.target.expectedBinding.paneId} · {selected.installation.installationId}</p>
      {stale && <Notice tone="warning">{t('선택한 세션이 바뀌었습니다. 닫고 다시 선택하세요.', 'The selected session changed. Close and select again.')}</Notice>}
      <Button tone="primary" disabled={disabled || busy || !!stale}
        onClick={() => { if (disabled || busy || stale) return; void act({ kind: 'native-restart', installation: selected.installation, target: selected.target }).then(ok => { if (ok) setSelected(null); }); }}>
        {t('이 세션 다시 시작', 'Restart this session')}
      </Button>
    </Dialog>}
  </Panel>;
}
