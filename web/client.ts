import type { AppCommand, AppResponse, AppSnapshot, CommandEnvelope } from '../src/app/types';

export class AccessError extends Error {}
export function newerSnapshot(current:AppSnapshot|null,next:AppSnapshot):AppSnapshot{
  return !current||next.serverInstance!==current.serverInstance||next.revision>=current.revision?next:current;
}
export async function readSnapshot(): Promise<AppSnapshot> {
  const response = await fetch('/api/state', { credentials: 'same-origin', cache: 'no-store' });
  if (response.status === 401 || response.status === 403) throw new AccessError();
  if (!response.ok) throw new Error('unavailable');
  return response.json();
}
export async function exchangeFragment(): Promise<void> {
  const fragment = location.hash.slice(1);
  // The service launches #token=<token>. A bare token is also accepted locally.
  const token = fragment.includes('=') ? new URLSearchParams(fragment).get('token') : fragment;
  if (!fragment) return;
  history.replaceState(null, '', location.pathname + location.search);
  if (!token) { await readSnapshot(); return; }
  const response = await fetch('/api/session', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  if (response.status === 401 || response.status === 403 || response.status === 400) {
    // A consumed/expired bookmark must not invalidate an already approved browser.
    await readSnapshot();return;
  }
  if (!response.ok) throw new Error('unavailable');
}
export async function sendCommand(command: AppCommand, requestId: string): Promise<AppResponse> {
  const envelope: CommandEnvelope = { requestId, command };
  const response = await fetch('/api/command', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(envelope) });
  if (response.status === 401 || response.status === 403) throw new AccessError();
  // Typed failures may use a non-2xx status. Never replay the POST.
  const result: AppResponse = await response.json();
  if (typeof result.ok !== 'boolean' || !result.snapshot) throw new Error('uncertain');
  return result;
}
export const errorCopy: Record<string, string> = {
  invalid_request:'입력 내용을 확인하세요.', unauthorized:'접근이 만료되었습니다. CLI에서 웹 화면을 다시 여세요.',
  not_found:'선택한 항목이 없어졌습니다. 상태를 다시 확인하세요.', conflict:'선택 이후 상태가 바뀌었습니다. 최신 상태에서 다시 검토하세요.',
  busy:'진행 중인 작업이 있어 기다려야 합니다. 작업을 강제로 중단하지 않습니다.', unsupported:'이 설치에서는 해당 기능을 지원하지 않습니다.',
  unavailable:'서비스 또는 최신 버전 정보를 확인할 수 없습니다.', timeout:'응답 시간을 초과했습니다. 실제 작업 상태를 먼저 확인하세요.',
  protocol:'서비스와 화면의 데이터 형식이 맞지 않습니다.', uncertain:'작업 결과가 불확실합니다. 다시 실행하지 말고 상태를 확인하세요.',
  source_changed:'설치 정보가 바뀌었습니다. 준비 결과를 다시 확인하세요.', cleanup_failed:'정리가 완료되지 않았습니다. 작업 상태를 확인하세요.',
  cancel_unsafe:'이미 변경이 시작되어 안전하게 취소할 수 없습니다.', update_failed:'업데이트에 실패했습니다.', verification_failed:'설치 검증에 실패했습니다.',
  waiting_for_quiet:'관리 세션이 작업 중입니다. 안전한 종료 조건을 기다립니다.', external_consumers:'외부 세션이 이 설치를 사용 중입니다. 자동으로 종료하지 않습니다.',
  policy_off:'자동화가 꺼져 있습니다.', admission_sealed:'설치 작업 중이므로 새 세션을 받지 않습니다.', host_unavailable:'세션 연결이 없어 실행 결과를 확인할 수 없습니다.',
  process_observation_unavailable:'프로세스를 다시 관찰하지 못했습니다. 마지막 관찰 시각 이후의 실행 여부는 확인되지 않았습니다.',
};
export function explain(code: string | null) { return code ? errorCopy[code] ?? '서비스가 확인이 필요한 상태를 보고했습니다. 작업 상태를 확인하세요.' : null; }
