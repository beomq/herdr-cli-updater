import { removalExplanation } from './removal-status';
type Translate=(ko:string,en:string)=>string;
export function versionStatusLabel(status:string|undefined,t:Translate):string {
  switch(status){
    case 'checking':return t('조회 중','Checking');
    case 'timeout':return t('조회 시간 초과','Lookup timed out');
    case 'failed':return t('버전 명령 실행 실패','Version command failed');
    case 'unrecognized':return t('버전 응답 해석 실패','Unrecognized version response');
    case 'unsupported':return t('버전 조회 미지원','Version lookup unsupported');
    default:return t('아직 확인 전','Not checked yet');
  }
}

export function installationError(code:string,t:Translate):string|null{
  const removal=removalExplanation(code,t);if(removal)return removal;
  if(code.startsWith('latest_'))return t('최신 버전을 확인하지 못했습니다. 업데이트하지 않았으며 다음 확인 시간에 다시 시도합니다.','Could not check the latest version. Nothing was updated; the next scheduled check will try again.');
  const messages:Record<string,string>={
    pi_source_changed_senpi:t('기존 자동 업데이트는 Senpi 설치에 연결되어 중지됐습니다. 설치와 기록은 유지됩니다. 원본 Pi를 사용하려면 설치 출처와 관리 대상을 검토한 뒤 자동 업데이트를 다시 설정하세요.','Automation is paused because it is bound to Senpi, not upstream Pi. The installation and history are preserved. Review the upstream Pi source and management target before configuring automation again.'),
    select_management_target_first:t('이 CLI의 다른 설치가 관리 대상으로 선택돼 있습니다. 설치 위치에서 관리 대상을 먼저 바꾸세요.','Another installation is this CLI’s management target. Select the intended installation first.'),
    official_destination_shadows_default:t('새 설치가 현재 명령을 바로 가리는 경로라 전환을 중단했습니다. 기존 기본 실행을 유지할 수 있는 설치 방법을 선택하세요.','The destination would immediately shadow the current command. Choose a method that preserves the existing default.'),
    official_setup_required:t('이 공식 설치 프로그램은 추가 설정이나 앱 실행이 필요합니다. 공식 안내로 설치한 뒤 목록을 새로고침하세요.','This official installer needs additional setup or app launch. Follow the official guide, then refresh the inventory.'),
    official_manual_install_required:t('이 방법의 자동 설치는 지원하지 않습니다. 공식 안내를 이용하세요.','Automatic installation is not supported for this method. Follow the official guide.'),
    official_installation_not_discovered:t('설치 후 예상 경로에서 관리 가능한 설치를 찾지 못했습니다. 기존 관리 대상은 유지됩니다.','The expected installation was not discovered after installing. The previous management target is retained.'),
    official_installation_use_manager:t('공식 설치는 전역 폴더를 통째로 보관하지 않습니다. 해당 설치 도구로 관리하세요.','Official installations must be managed with their installer; global directories are never archived.'),
    default_requires_official_installation:t('앱 전용 설치는 기본 실행으로 새로 연결하지 않습니다. 공식 설치로 이전하세요.','Legacy app-owned installations cannot become a new default. Migrate to an official installation.'),
    official_install_plan_stale:t('공식 설치 계획의 경로 또는 출처가 바뀌었습니다. 새 계획을 검토하세요.','The official installation paths or source changed. Review a fresh plan.'),
    official_destination_exists:t('공식 설치 위치에 기존 파일이 있습니다. 덮어쓰지 않았습니다. 다른 방법을 선택하거나 기존 설치를 관리 대상으로 선택하세요.','The official destination already contains files. Nothing was overwritten. Choose another method or select the existing installation as the management target.'),
    official_platform_unsupported:t('이 플랫폼에서는 공식 설치 안내를 이용하세요.','Follow the official installation guide on this platform.'),
    official_method_unsupported:t('이 플랫폼에서 선택한 방법을 실행할 수 없습니다. 다른 공식 방법을 선택하세요.','The selected method cannot run on this platform. Choose another official method.'),
    official_package_unverified:t('공식 패키지 출처가 확인되지 않아 설치하지 않았습니다. 공식 안내를 확인하세요.','The official package source is unverified. Nothing was installed. Follow the official guide.'),
    manual_update_required:t('이 설치의 업데이트 경로를 확인하지 못했습니다. 설치 출처와 공식 업데이트 방법을 확인하세요.','The update method for this installation could not be verified. Check its source and official update instructions.'),
    update_in_progress:t('업데이트가 진행 중입니다. 완료 후 다시 시도하세요.','An update is running. Try again after it finishes.'),
    stale_update_plan:t('업데이트 검토 내용이 바뀌었습니다. 다시 검토하세요.','The update plan changed. Review it again.'),
    update_target_changed:t('승인한 설치와 현재 설치가 다릅니다. 경로를 확인하고 다시 설정하세요.','The current installation differs from the approved target. Check its path and configure it again.'),
    inspect_interrupted_update:t('이전 업데이트 결과가 확인되지 않았습니다. 설치 경로와 버전을 직접 확인해야 하며 자동으로 재실행하지 않습니다.','The previous update result is uncertain. Inspect the installation path and version; it will not be retried automatically.'),
    catalog_policy_unsupported:t('이 CLI는 업데이트만 지원합니다. 세션 재시작은 포함하지 않습니다.','This CLI supports update-only automation, without session restart.'),
    policy_changed:t('자동 업데이트 설정이 변경되어 실행하지 않았습니다.','Automation settings changed, so the update was not started.'),
    running_sessions:t('이 설치를 사용하는 프로세스가 있어 기다립니다. 자동으로 종료하지 않으며 다음 일정에 다시 확인합니다.','This installation is in use. Processes are not stopped; it will be checked at the next scheduled run.'),
    install_platform_unsupported:t('이 운영체제에서는 앱 내 업데이트를 지원하지 않습니다. 공식 설치 안내를 확인하세요.','In-app updates are unsupported on this operating system. Check the official installation guide.'),
    updated_version_unverified:t('업데이트 후 버전을 확인하지 못했습니다. 실행 파일과 설치된 패키지 버전을 확인하세요. 자동으로 재시도하지 않습니다.','The version could not be verified after updating. Inspect the executable and installed package version. No automatic retry will run.'),
    installer_download_failed:t('설치 파일을 다운로드하지 못했습니다. 네트워크 연결과 공식 배포 상태를 확인하세요.','Download failed. Check the network and official release availability.'),
    installer_checksum_mismatch:t('다운로드 파일의 검증값이 다릅니다. 실행하지 않았습니다. 파일을 보관하고 공식 배포 상태를 확인하세요.','The download checksum differs. It was not executed. Preserve the files and check the official release.'),
    installer_timeout:t('설치 제한 시간을 넘겼습니다. 설치 상태를 다시 확인한 뒤 복구하세요.','Installation exceeded its time limit. Check the actual installation before recovery.'),
    installer_output_limit:t('설치 출력이 허용 크기를 넘었습니다. 상태를 다시 확인하세요.','Installer output exceeded its limit. Check the actual installation.'),
    installer_start_failed:t('설치 프로그램을 실행하지 못했습니다. 필요한 실행 환경과 파일 권한을 확인하세요.','The installer could not start. Check its runtime requirements and file permissions.'),
    installed_executable_missing:t('실행 파일을 찾지 못했습니다. 공식 설치 위치와 실제 파일 상태를 확인하세요.','No executable was found. Inspect the official destination and actual files.'),
    installed_version_unverified:t('실행 파일은 있지만 버전 확인에 실패했습니다. 실제 설치 상태를 다시 확인하세요. 자동으로 삭제하지 않습니다.','The executable exists but its version could not be verified. Inspect the actual installation. Nothing is automatically deleted.'),
    installed_executable_outside_target:t('실행 파일이 검토한 설치 위치 밖을 가리킵니다. 자동으로 실행하거나 정리하지 않습니다.','The executable points outside the reviewed installation. It will not be run or removed automatically.'),
    service_restarted:t('설치 도중 서비스가 재시작됐습니다. 설치 상태를 다시 확인하세요.','The service restarted during installation. Check the actual installation.'),
    recovery_target_in_use:t('설치 폴더를 사용하는 프로세스가 있습니다. 직접 종료한 뒤 다시 확인하세요.','A process is using this installation. Close it yourself before checking again.'),
    recovery_target_missing:t('이 작업의 설치 폴더가 없습니다. 위 목록에서 새 설치를 시작할 수 있습니다.','This installation directory no longer exists. You can start a new installation above.'),
    installation_archived:t('기존 설치 파일을 보관했습니다. 새 설치를 진행할 수 있습니다.','Previous installation files were archived. You can start a new installation.'),
    recovery_target_unsafe:t('대상 폴더가 일반 전용 폴더가 아닙니다. 경로와 심볼릭 링크를 확인하세요.','The target is not a normal dedicated directory. Check its path and symbolic links.'),
    recovery_root_unsafe:t('설치 보관 위치가 변경됐습니다. 경로를 확인하세요.','The installation storage location changed. Check its path.'),
    recovery_target_changed:t('확인 중 설치 경로가 변경됐습니다. 실행 중인 작업을 확인한 뒤 다시 검사하세요.','The installation changed during inspection. Check active work before inspecting again.'),
    recovery_archive_exists:t('이 작업의 보관 폴더가 이미 있습니다. 기존 파일을 덮어쓰지 않았습니다.','An archive already exists for this job. Existing files were not overwritten.'),
    stale_install_plan:t('작업 상태가 바뀌었습니다. 최신 상태에서 다시 확인하세요.','The job state changed. Review its current state.'),
    inspect_interrupted_install:t('중단된 설치가 있습니다. 설치 작업에서 실제 상태를 확인하세요.','An installation was interrupted. Inspect its actual state in installation jobs.'),
    install_in_progress:t('설치 또는 복구 작업이 진행 중입니다. 완료 후 다시 시도하세요.','An installation or recovery is running. Retry after it finishes.'),
    npm_required:t('npm을 찾지 못했습니다. Node.js와 npm 설치 및 서버의 PATH를 확인하세요.','npm was not found. Check Node.js/npm and the server PATH.'),
    bun_required:t('Bun을 찾지 못했습니다. 설치 및 서버의 PATH를 확인하세요.','Bun was not found. Check its installation and the server PATH.'),
    brew_required:t('Homebrew를 찾지 못했습니다. 설치 및 서버의 PATH를 확인하세요.','Homebrew was not found. Check its installation and the server PATH.'),
    uv_required:t('uv를 찾지 못했습니다. 설치와 서버의 PATH를 확인하세요.','uv was not found. Check its installation and the server PATH.'),
  };
  if(/^installer_exit_\d+$/.test(code))return t('설치 프로그램이 오류로 종료됐습니다. 공식 설치 요구사항을 확인하고, 기존 파일 상태를 검사한 뒤 재시도하세요.','The installer exited with an error. Check official requirements and inspect existing files before retrying.');
  return messages[code]??null;
}
