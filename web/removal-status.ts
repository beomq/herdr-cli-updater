type Translate=(ko:string,en:string)=>string;
export function removalExplanation(code:string,t:Translate):string|null {
  const messages:Record<string,string>={
    reference_scan_incomplete:t('이 설치를 참조하는 설정 검사를 완료하지 못했습니다. 삭제하지 않았습니다. 플러그인·설정 파일의 크기, 접근 권한 또는 검사 중 변경 여부를 확인하세요.','The configuration reference scan could not complete. Nothing was removed. Check plugin and configuration size, access permissions, or changes during the scan.'),
    removal_archive_exists:t('이 실행 파일의 이전 보관본이 있습니다. 덮어쓰지 않았습니다. 보관본을 확인한 뒤 다시 검토하세요.','An archive of this binary already exists. It was not overwritten. Inspect it before reviewing removal again.'),
    removal_dependency_installation:t('다른 앱이 사용하는 하위 패키지입니다. 독립 CLI처럼 삭제하지 않습니다. 해당 앱의 패키지 관리에서 확인하세요.','This is a dependency of another app, not an independent CLI. Inspect it through the owning app’s package manager.'),
    removal_receipt_mismatch:t('앱의 설치 기록과 현재 경로 또는 설치 방식이 다릅니다. 설치 상세의 경로와 기록을 확인하세요.','The installation receipt differs from the current path or method. Compare the installation details and receipt.'),
    removal_lock_mismatch:t('Bun의 직접 의존성과 잠금 파일이 일치하지 않습니다. 패키지 관리자 상태를 정리한 뒤 다시 검토하세요.','Bun’s direct dependency and lockfile do not match. Repair the package-manager state before reviewing removal.'),
    removal_manager_missing:t('설치를 관리할 npm 또는 Bun을 서비스 PATH에서 찾지 못했습니다. 관리자 실행 경로를 확인하세요.','The owning npm or Bun executable is missing from the service PATH. Check the package-manager path.'),
    removal_scan_limit:t('설치 파일 검사 한도를 넘었습니다. 삭제하지 않았습니다. 설치 크기와 파일 수를 확인하세요.','The installation exceeds the verification budget. Nothing was removed. Inspect its size and file count.'),
    removal_metadata_invalid:t('설치 메타데이터를 해석하지 못했습니다. 패키지 파일과 설치 기록을 확인하세요.','Installation metadata could not be parsed. Inspect package files and the installation receipt.'),
    removal_permission_denied:t('설치 파일을 읽을 권한이 없어 검증하지 못했습니다. 파일 소유자와 권한을 확인하세요.','Installation files cannot be verified because access was denied. Check ownership and permissions.'),
    removal_source_unverified:t('실행 파일은 발견했지만 제거할 설치 범위를 검증하지 못했습니다. 상세 경로와 공식 제거 방법을 확인하세요.','The executable was found, but its removal scope could not be verified. Inspect the exact paths and official uninstall instructions.'),
    removal_package_source_unverified:t('직접 설치된 패키지 출처로 확인되지 않았습니다. 연결된 작업 폴더나 하위 의존성인지 확인하세요.','This is not a verified direct package installation. Check for a linked workspace or transitive dependency.'),
    removal_standalone_unverified:t('독립 설치의 공식 경로와 실제 실행 파일이 일치하지 않습니다. 기본 경로·심볼릭 링크를 확인하세요.','The standalone installation does not match the supported official layout. Check its paths and symbolic links.'),
  };
  return messages[code]??null;
}
