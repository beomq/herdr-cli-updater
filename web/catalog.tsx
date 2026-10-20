import { useEffect, useRef, useState } from 'react';
import type { AppCommand, AppSnapshot } from '../src/app/types';
import type { CatalogEntry, CatalogId, InstallJob } from '../src/app/catalog-types';
import { Badge, Button, Dialog, Facts, Notice, Panel, SectionHead } from './primitives';
import { Select } from './select';
import { localeFor, useLanguage } from './i18n';
import { AgentMark } from './agent-mark';
import './catalog.css';
import { RemovalActions, RemovalHistory } from './catalog-removal';
import { installationError } from './install-status';
import { CatalogInstallations, installationControlsBlocked } from './catalog-installations';
import { CatalogCleanup } from './catalog-cleanup';

type Filter = 'all' | 'installed' | 'installable' | 'manual';
type Act = (command: AppCommand) => Promise<boolean>;
type Method = NonNullable<CatalogEntry['installMethods']>[number]['method'];
type Waiting = { catalogId: CatalogId; known: readonly string[]; serverInstance: string | undefined };

export function installReviewIsStale(snapshot: AppSnapshot, review: InstallJob, serverInstance: string | undefined): boolean {
  const current = snapshot.installJobs?.find(job => job.id === review.id);
  const entry = snapshot.catalog?.find(row => row.id === review.catalogId);
  return snapshot.service !== 'ready' || serverInstance !== snapshot.serverInstance || !review.official || review.makeDefault === true
    || !current || current.stage !== 'ready' || current.revision !== review.revision
    || JSON.stringify(current.official) !== JSON.stringify(review.official)
    || current.makeDefault !== review.makeDefault || current.previousInstallationId !== review.previousInstallationId
    || !entry || (entry.selectedInstallationId ?? null) !== (review.previousInstallationId ?? null)
    || installationControlsBlocked(entry, snapshot, { automation: false });
}

export function Catalog({ snapshot, act, disabled, initialDetailId = null }: { snapshot: AppSnapshot; act: Act; disabled: boolean; initialDetailId?: CatalogId | null }) {
  const { language, t } = useLanguage();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [detailId, setDetailId] = useState<CatalogId | null>(initialDetailId);
  const [choosing, setChoosing] = useState<CatalogId | null>(null);
  const [method, setMethod] = useState<Method>('official');
  const [review, setReview] = useState<InstallJob | null>(null);
  const [reviewServer, setReviewServer] = useState<string | undefined>();
  const [recovery, setRecovery] = useState<InstallJob | null>(null);
  const [recovering, setRecovering] = useState<string | null>(null);
  const [awaiting, setAwaiting] = useState<Waiting | null>(null);
  const [pending, setPending] = useState(false);
  const [returnTo, setReturnTo] = useState<CatalogId | null>(null);
  const [installingId,setInstallingId]=useState<string|null>(null);
  const busy = useRef(false);
  const entries = snapshot.catalog ?? [];
  const detail = entries.find(entry => entry.id === detailId);
  const choice = entries.find(entry => entry.id === choosing);
  const methods = (choice?.installMethods ?? []).filter(method=>!returnTo||!choice?.installations?.some(row=>row.manager===method.method));
  const selectedMethod = methods.find(row => row.method === method);
  const jobs = snapshot.installJobs ?? [];
  const key = (job: InstallJob) => `${job.id}:${job.revision}`;
  const openReview = (job: InstallJob) => { setReview(job); setReviewServer(snapshot.serverInstance); };
  useEffect(()=>{
    if(!installingId||!returnTo)return;
    const job=jobs.find(row=>row.id===installingId);
    if(job&&['completed','failed','uncertain'].includes(job.stage)){setDetailId(returnTo);setInstallingId(null);}
  },[snapshot.installJobs,installingId,returnTo]);
  useEffect(() => {
    if (!awaiting) return;
    if (snapshot.serverInstance !== awaiting.serverInstance || snapshot.service !== 'ready') { setAwaiting(null); return; }
    const result = [...(snapshot.installJobs ?? [])].reverse().find(job => job.catalogId === awaiting.catalogId && !awaiting.known.includes(`${job.id}:${job.revision}`));
    if (result) {
      setAwaiting(null);
      if (result.stage === 'ready' && result.official) { setReview(result); setReviewServer(awaiting.serverInstance); }
    }
  }, [awaiting, snapshot.installJobs, snapshot.serverInstance, snapshot.service]);
  const choose = (entry: CatalogEntry) => {
    setReturnTo(detailId);
    setDetailId(null); setChoosing(entry.id);
    const choices=(entry.installMethods??[]).filter(method=>!detailId||!entry.installations?.some(row=>row.manager===method.method));
    setMethod(choices.find(row => row.recommended)?.method ?? choices[0]?.method ?? 'official');
  };
  const plan = async () => {
    if (!choice || !selectedMethod || busy.current || disabled || awaiting || snapshot.service !== 'ready'
      || installationControlsBlocked(choice, snapshot, { automation: false })) return;
    busy.current = true; setPending(true);
    setAwaiting({ catalogId: choice.id, known: jobs.map(key), serverInstance: snapshot.serverInstance });
    try {
      if (await act({ kind: 'install-plan', catalogId: choice.id, method, makeDefault: false })) setChoosing(null);
      else setAwaiting(null);
    } catch { setAwaiting(null); }
    finally { busy.current = false; setPending(false); }
  };
  const stale = !!review && installReviewIsStale(snapshot, review, reviewServer);
  const confirm = async () => {
    if (!review || stale || busy.current || disabled) return;
    busy.current = true; setPending(true);
    try { if (await act({ kind: 'install-confirm', jobId: review.id, revision: review.revision })) {setInstallingId(review.id);setReview(null);} }
    finally { busy.current = false; setPending(false); }
  };
  const recover = async (job: InstallJob, action: 'inspect' | 'archive') => {
    if (busy.current || disabled || snapshot.service !== 'ready' || (action === 'archive' && job.official)) return;
    busy.current = true; setPending(true); setRecovering(job.id);
    try { if (await act({ kind: 'install-recover', jobId: job.id, revision: job.revision, action })) setRecovery(null); }
    finally { busy.current = false; setPending(false); setRecovering(null); }
  };
  const recoveryCurrent = recovery && jobs.find(job => job.id === recovery.id);
  const recoveryStale = !!recovery && (!recoveryCurrent || !!recoveryCurrent.official || recoveryCurrent.revision !== recovery.revision || !['failed', 'uncertain'].includes(recoveryCurrent.stage));
  const labels: Record<Filter, string> = { all: t('전체', 'All'), installed: t('설치됨', 'Installed'), installable: t('설치 가능', 'Installable'), manual: t('수동 설치', 'Manual') };
  const stages: Record<InstallJob['stage'], string> = { ready: t('설치 전 확인', 'Confirmation required'), installing: t('설치 중', 'Installing'), verifying: t('설치 확인 중', 'Checking installation'), completed: t('설치 완료', 'Installed'), failed: t('설치 실패', 'Installation failed'), uncertain: t('설치 결과 확인 필요', 'Check installation result') };
  const visible = entries.filter(entry => entry.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()) && (filter === 'all' || (filter === 'installed' ? (!!entry.installed || !!entry.installations?.length) : filter === 'installable' ? !!entry.installMethods?.length && entry.availability === 'installable' : !entry.installMethods?.length || entry.availability === 'manual')));
  const locked = disabled || pending || snapshot.service !== 'ready';
  const versionStates = { checking: t('조회 중', 'Checking'), known: t('조회 완료', 'Verified'), unsupported: t('버전 조회 미지원', 'Version lookup unsupported'), timeout: t('버전 조회 시간 초과', 'Version lookup timed out'), failed: t('버전 명령 실행 실패', 'Version command failed'), unrecognized: t('버전 응답을 해석할 수 없음', 'Unrecognized version output') };
  const progress: Record<string, string> = {
    download_started: t('공식 설치 파일 다운로드 중', 'Downloading official installer'),
    download_complete: t('다운로드 완료', 'Download completed'),
    checksum_verified: t('다운로드 검증 완료', 'Download checksum verified'),
    installer_started: t('설치 프로그램 실행 중', 'Running installer'),
    installer_output_received: t('설치 프로그램에서 진행 응답 수신', 'Installer activity received'),
    verification_started: t('실행 파일 버전 검증 중', 'Verifying executable version'),
    installation_verified: t('설치 버전 검증 완료', 'Installed version verified'),
  };
  const official = (url: string) => <a className="catalog-link" href={url} target="_blank" rel="noopener noreferrer">{t('공식 설치 안내', 'Official installation guide')}</a>;
  const keepExisting = t('기존 설치를 삭제하지 않습니다. 검증된 새 설치만 이 CLI의 단일 자동·일괄 업데이트 관리 대상이 됩니다. 기존 자동화가 꺼져 있으면 계속 꺼져 있습니다. 열린 셸이나 세션은 재시작하지 않습니다.', 'Existing installations are kept. Only the verified new installation becomes this CLI\'s single automatic and bulk update target. Automation stays off if previously off. Open shells and sessions are not restarted.');
  return <div className="catalog stack">
    {!detail&&<>
    <p className="muted">{t('설치된 CLI를 관리하거나 여러 사본을 정리하세요. 자동 업데이트 대상은 CLI별 하나이며 다른 설치를 유지할 수도 있습니다.', 'Manage installed CLIs or organize duplicate copies. Each CLI has one update target; other copies may be kept.')}</p>
    <p className="muted">{t('설치·삭제는 확인창에서 최종 실행됩니다. 설치 안내는 공식 사이트로 이동합니다.', 'Install and Remove open a confirmation. Setup guide opens the official website.')}</p>
    <div className="catalog-toolbar"><label className="field catalog-search">{t('CLI 이름 검색', 'Search CLI name')}<input type="search" value={search} onChange={event => setSearch(event.target.value)} /></label><Select<Filter> label={t('설치 상태 필터', 'Filter installation status')} value={filter} options={(Object.keys(labels) as Filter[]).map(value => ({ value, label: labels[value] }))} onChange={setFilter} /></div>
    {awaiting && <Notice>{t('설치 정보를 확인하고 있습니다. 다음 화면에서 설치할 수 있습니다.', 'Checking installation details. You can confirm installation on the next screen.')}<Button onClick={() => setAwaiting(null)}>{t('닫기', 'Close')}</Button></Notice>}
    <SectionHead title={t('CLI 설치 카탈로그', 'CLI installation catalog')} count={visible.length} />
    {snapshot.catalog === undefined ? <Notice>{t('서비스에서 설치 카탈로그를 아직 제공하지 않았습니다.', 'The service has not provided the installation catalog yet.')}</Notice> : !visible.length && <Notice>{t('조건에 맞는 CLI가 없습니다.', 'No CLIs match these filters.')}</Notice>}
    <div className="catalog-grid">{visible.map(entry => {
      const active = installationControlsBlocked(entry, snapshot, { automation: false });
      const hasMethods = !!entry.installMethods?.length;
      const installed=!!entry.installed||!!entry.installations?.length;
      const legacy=entry.installations?.some(row=>row.manager==='owned')||entry.installed?.managed;
      return <Panel key={entry.id}>
        <div className="page-head"><div className="catalog-title"><span className="catalog-mark" aria-hidden="true"><AgentMark agent={entry.id} size={32} /></span><div className="catalog-identity"><h2>{entry.name}</h2><span className="muted">{entry.inventoryStatus === 'checking' ? t('설치 확인 중', 'Discovering installations') : entry.installations?.length && !entry.installed ? t('관리 대상을 선택하세요', 'Select a management target') : entry.installed ? `${t('설치됨', 'Installed')} · ${entry.installed.version ?? (entry.installed.versionStatus === 'checking' ? t('조회 중', 'Checking') : t('버전 미확인', 'Version unavailable'))}` : !hasMethods ? labels.manual : t('미설치', 'Not installed')}{!!entry.installations?.length && (' · ' + entry.installations.length + t('개 경로', ' paths'))}</span>{legacy && <Badge>{t('레거시 앱 전용 설치', 'Legacy app-owned installation')}</Badge>}</div></div></div>
        <div className="cluster catalog-actions">
          {installed?<Button data-action="catalog-manage" data-catalog-id={entry.id} onClick={()=>setDetailId(entry.id)}>{(entry.installations?.length??0)>1?t('설치 정리','Organize installations'):t('관리','Manage')}</Button>:hasMethods ? <Button data-action="install-methods" data-catalog-id={entry.id} tone="primary" disabled={locked || active || !!awaiting} onClick={() => choose(entry)}>{t('설치', 'Install')}</Button> : <a className="button" href={entry.sourceUrl} target="_blank" rel="noopener noreferrer">{t('설치 안내', 'Setup guide')}</a>}
        </div>
        {active && <p className="muted" data-catalog-notice={entry.id}>{t('설치 목록과 기존 작업 결과를 먼저 확인하세요.', 'Verify inventory and existing job results first.')}</p>}
        {!installed&&<Button className="catalog-detail-trigger" aria-label={`${entry.name} ${t('상세 내역', 'details')}`} onClick={() => setDetailId(entry.id)}>{t('상세 내역', 'Details')}<span aria-hidden="true">↗</span></Button>}
      </Panel>;
    })}</div></>}
    {detail && <section className="stack catalog-workspace" data-catalog-detail={detail.id}>
      <div className="page-head"><h2 className="cli-heading"><AgentMark agent={detail.id} size={24}/>{detail.name}</h2><Button data-action="catalog-back" onClick={()=>{setDetailId(null);setReturnTo(null);}}>{t('목록으로','Back to list')}</Button></div>
      {!!detail.installations?.length && <CatalogInstallations key={detail.id} entry={detail} snapshot={snapshot} act={act} disabled={locked} />}
      {(detail.installations?.length??0)>1&&<details data-role="installation-consolidation"><summary>{t('여러 설치를 하나로 정리','Consolidate multiple installations')}</summary><CatalogCleanup key={detail.id} entry={detail} snapshot={snapshot} act={act} disabled={locked||installationControlsBlocked(detail,snapshot,{automation:false})}/></details>}
      <section className="stack" data-role="add-installation"><h3>{detail.installed||detail.installations?.length?t('다른 위치에 추가 설치','Add another installation'):t('CLI 설치','Install CLI')}</h3>
        <p className="muted">{t('업데이트와 별개로 새 설치를 추가합니다. 기존 설치와 대화는 보존하며 터미널 기본 실행은 바꾸지 않습니다.','Add an installation separately from updating. Existing installations and conversations are preserved; the terminal default does not change.')}</p>
        {!!detail.installMethods?.length ? <Button data-action="add-installation" disabled={locked || !!awaiting || installationControlsBlocked(detail, snapshot, { automation: false })} onClick={() => choose(detail)}>{t('공식 설치 방법 선택', 'Choose official installation method')}</Button> : official(detail.sourceUrl)}
      </section>
      <details><summary>{t('설치 기술 상세','Installation technical details')}</summary>
      <div className="catalog-detail-body stack">
        <p className="muted">{detail.description[language]}</p>
        <section className="stack"><h3>{t('현재 설치', 'Current installation')}</h3>
          {detail.installed ? <Facts items={[
            [t('설치된 버전', 'Installed version'), <>{detail.installed.version ?? versionStates[detail.installed.versionStatus ?? 'unsupported']}{detail.installed.checkedAt && <span className="catalog-source">{t('확인 시각: ', 'Checked: ')}{new Date(detail.installed.checkedAt).toLocaleString(localeFor(language))}</span>}</>],
            [t('실행 파일 경로', 'Executable path'), <span className="path">{detail.installed.path}</span>],
            [t('설치 관리', 'Installation ownership'), detail.installed.managed ? t('레거시 앱 전용 설치', 'Legacy app-owned installation') : t('기존 사용자 설치', 'Existing user installation')],
          ]} /> : <p className="muted">{t('이 컴퓨터에서 설치를 찾지 못했습니다.', 'No installation was found on this computer.')}</p>}
          {detail.installed?.lastVerifiedVersion && <p className="muted">{t('마지막 설치 검증 버전', 'Last verified installation version') + ': ' + detail.installed.lastVerifiedVersion}</p>}
        </section>
        {detail.installed && !detail.installations?.length && <section className="stack"><h3>{t('설치 삭제', 'Remove installation')}</h3><RemovalActions snapshot={snapshot} act={act} disabled={locked || installationControlsBlocked(detail, snapshot)} catalogId={detail.id} /></section>}
        <section className="stack"><h3>{t('설치 및 실행', 'Setup and launch')}</h3>
          <Facts items={[
            [t('설치 방법', 'Installation method'), detail.method === 'Official installation guide' ? t('공식 안내에 따라 설치', 'Follow the official guide') : detail.method === 'Official installer' ? t('공식 설치 프로그램', 'Official installer') : detail.method],
            [t('설치 출처', 'Installation source'), official(detail.sourceUrl)],
            [t('터미널 실행 명령', 'Terminal launch command'), <code className="path">{detail.installed?.managed ? JSON.stringify(detail.installed.path) : detail.executable}</code>],
          ]} />
          {detail.reason && <p className="muted">{installationError(detail.reason, t) ?? detail.reason}</p>}
        </section>
      </div>
      </details>
    </section>}
    {!!jobs.length && <section className="stack" aria-label={t('설치 작업', 'Installation jobs')}><SectionHead title={t('설치 작업', 'Installation jobs')} count={jobs.length} />{[...jobs].reverse().map(job => <Panel key={job.id}>
      <div className="page-head"><h3>{entries.find(entry => entry.id === job.catalogId)?.name ?? job.catalogId}</h3><Badge tone={job.stage === 'completed' ? 'success' : job.stage === 'failed' ? 'error' : ['ready', 'uncertain'].includes(job.stage) ? 'warning' : 'neutral'}>{stages[job.stage]}</Badge></div>
      <p className="muted">{t('작업 경과', 'Elapsed')}: {Math.max(0, Math.floor(((job.stage === 'installing' || job.stage === 'verifying' ? Date.now() : job.updatedAt) - job.createdAt) / 1000))}{t('초', 's')} · {t('마지막 상태 변경', 'Last state change')}: {new Date(job.updatedAt).toLocaleTimeString(localeFor(language))}</p>
      {!!job.log.length && <p role="status">{progress[job.log.at(-1) ?? ''] ?? t('설치 상태가 갱신됐습니다.', 'Installation state updated.')}</p>}
      <Facts items={[[t('목표 경로', 'Target path'), <span className="path">{job.official?.target ?? job.target}</span>], [t('실제로 검증된 버전', 'Actually verified version'), job.installedVersion ?? t('아직 확인되지 않음', 'Not yet verified')], [t('실제 실행 파일 경로', 'Actual executable path'), <span className="path">{job.executablePath ?? t('아직 확인되지 않음', 'Not yet verified')}</span>]]} />
      {job.failure && <Notice tone={job.stage === 'uncertain' || job.archivePath ? 'warning' : 'error'}>{installationError(job.failure, t) ?? t('설치 상태를 확인하지 못했습니다. 실행 환경과 공식 설치 요구사항을 확인한 뒤 상태를 다시 검사하세요.', 'The installation could not be verified. Check runtime and official requirements, then inspect its state.')}<details><summary>{t('진단 코드', 'Diagnostic code')}</summary><code>{job.failure}</code></details></Notice>}
      {['uncertain', 'failed'].includes(job.stage) && !job.archivePath && <><p className="muted">{job.official ? t('공식 설치 경로의 상태만 다시 확인합니다. 전역 설치를 보관하거나 삭제하지 않습니다.', 'Inspect the official installation only. Global installations are never archived or deleted here.') : t('상태를 다시 확인하면 실제 실행 파일의 버전을 검증합니다. 레거시 전용 설치 파일은 별도로 보관할 수 있습니다.', 'Inspect the executable version. Legacy dedicated installation files can be archived separately.')}</p><div className="cluster"><Button data-action="install-inspect" disabled={locked} onClick={() => void recover(job, 'inspect')}>{recovering === job.id ? t('확인 중', 'Checking') : t('설치 상태 다시 확인', 'Check installation')}</Button>{!job.official && <Button data-action="install-archive" disabled={locked} onClick={() => setRecovery(job)}>{t('보관 후 재설치 준비', 'Archive for reinstall')}</Button>}</div></>}
      {job.archivePath && <Notice>{t('기존 파일을 보관했습니다. 위 목록에서 새 설치를 시작할 수 있습니다.', 'Previous files are preserved. Start a new installation from the catalog above.')}<p className="path">{job.archivePath}</p></Notice>}
      {!!job.log.length && <details><summary>{t('진행 기록', 'Progress history')}</summary><p className="muted">{t('계정 정보 보호를 위해 설치 프로그램의 원문 대신 진행 단계만 보관합니다.', 'Only lifecycle events are kept; raw installer output is excluded to protect credentials.')}</p><ol>{job.log.map((event, index) => <li key={index}>{progress[event] ?? t('상태 갱신', 'State updated')}</li>)}</ol></details>}
      {job.stage === 'ready' && (job.official ? <Button data-action="install-review" disabled={locked || installReviewIsStale(snapshot, job, snapshot.serverInstance)} onClick={() => openReview(job)}>{t('설치','Install')}</Button> : <Notice tone="warning">{t('이전 앱 전용 설치 계획은 실행할 수 없습니다. 공식 설치 방법을 새로 선택하세요.', 'Old app-owned installation plans cannot run. Choose an official installation method again.')}</Notice>)}
    </Panel>)}</section>}
    <RemovalHistory snapshot={snapshot} />
    {choice && <Dialog title={`${choice.name} · ${t('설치 방법 선택', 'Choose installation method')}`} onClose={() => {setChoosing(null);setDetailId(returnTo);}}>
      <Notice>{keepExisting}</Notice>
      <Select<Method> label={t('공식 설치 방법', 'Official installation method')} value={method} options={methods.map(row => ({ value: row.method, label: row.label + (row.recommended ? ' · ' + t('권장', 'Recommended') : '') }))} onChange={setMethod} />
      {!methods.length&&<Notice>{t('지원하는 설치 방식이 이미 있습니다. 닫고 기존 설치를 선택하세요.','Supported installation methods already exist. Close and select an existing installation.')}</Notice>}
      {selectedMethod && <Facts items={[[t('설치 출처', 'Installation source'), official(selectedMethod.sourceUrl)]]} />}
      <p className="muted">{t('설치만으로 자동 업데이트를 켜거나 터미널 기본 실행을 바꾸지 않습니다. 기본 실행은 설치 후 상세 화면의 ‘터미널 실행’에서 별도로 설정하세요.', 'Installing does not enable automation or change the terminal default. Configure it separately under Terminal execution in Details after installing.')}</p>
      {choice.availability === 'manual' && method === 'official' ? <a className="button" href={selectedMethod?.sourceUrl ?? choice.sourceUrl} target="_blank" rel="noopener noreferrer">{t('설치 안내', 'Setup guide')}</a> : <Button data-action="install-plan" tone="primary" disabled={locked || !!awaiting || !selectedMethod || installationControlsBlocked(choice, snapshot, { automation: false })} onClick={() => void plan()}>{t('설치 준비', 'Prepare installation')}</Button>}
    </Dialog>}
    {recovery && <Dialog title={t('불완전한 설치 보관', 'Archive incomplete installation')} onClose={() => setRecovery(null)}>
      <Notice>{t('레거시 전용 설치 폴더를 별도 경로로 옮겨 모든 파일을 보존합니다. 실행 중인 프로세스가 있으면 보관하지 않습니다.', 'Move the legacy dedicated installation into an archive and preserve every file. Active processes block archiving.')}</Notice>
      <div className="catalog-detail-body"><Facts items={[[t('대상 폴더', 'Target directory'), <span className="path">{recovery.target}</span>]]} /></div>
      {recoveryStale && <Notice tone="warning">{t('상태가 변경됐습니다. 닫고 다시 확인하세요.', 'The state changed. Close and review again.')}</Notice>}
      <div className="cluster"><Button onClick={() => setRecovery(null)}>{t('취소', 'Cancel')}</Button><Button disabled={locked || recoveryStale} onClick={() => void recover(recovery, 'archive')}>{t('파일 보관하기', 'Archive files')}</Button></div>
    </Dialog>}
    {review && <Dialog title={t('CLI 설치', 'Install CLI')} onClose={() => setReview(null)}>
      <Notice tone="warning">{t('공식 설치 프로그램은 다운로드한 패키지 코드를 이 컴퓨터에서 실행합니다. 출처·방법·실제 설치 위치를 확인한 뒤 직접 승인하세요.', 'The official installer executes downloaded package code on this computer. Review the source, method and actual destination before explicitly approving.')}</Notice>
      <div className="catalog-detail-body"><Facts items={[
        [t('CLI', 'CLI'), entries.find(entry => entry.id === review.catalogId)?.name ?? review.catalogId],
        [t('실제 설치 위치', 'Actual installation destination'), <span className="path">{review.official?.target ?? review.target}</span>],
        [t('실행 파일', 'Executable'), <span className="path">{review.official?.executable}</span>],
        [t('설치 방법', 'Installation method'), review.official?.method ?? review.method],
        [t('설치 출처', 'Installation source'), official(review.official?.sourceUrl ?? review.sourceUrl)],
        [t('새 셸 기본 실행', 'New-shell default'), review.makeDefault ? t('새 대화형 zsh에 설정', 'Configure for new interactive zsh shells') : t('변경하지 않음', 'Keep current configuration')],
      ]} /></div>
      <Notice>{keepExisting}</Notice>
      {stale && <Notice tone="warning">{t('설치 정보 또는 서비스가 바뀌었습니다. 닫고 다시 여세요.','Installation details or the service changed. Close and open it again.')}</Notice>}
      <Button data-action="install-confirm" tone="primary" disabled={locked || stale} onClick={() => void confirm()}>{t('설치하기', 'Install CLI')}</Button>
    </Dialog>}
  </div>;
}
