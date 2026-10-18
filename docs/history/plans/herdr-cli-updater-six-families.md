# 여섯 CLI 실제 연결과 단순 터미널 UI

## 승인과 결과

사용자: Claude, Codex, OMP, Cursor, AGY, Grok도 이어서 지원하고 현재처럼 터미널 UI를 단순하게 유지한다.
기존 OmO native/P/C/check-store/queue/worker를 재사용한다. 운영 CLI·herdr·현재 세션 업데이트/재시작,
credentials, git staging/commit/push/PR/deploy는 허용하지 않았다.

최종 사용자에게 필요한 상태는 설치 버전·공식 최신·업데이트 가능 여부가 분명하고,
Enter로 선택/확인한 설치만 실제 업데이트되며 열린 작업이나 다른 CLI를 건드리지 않는 것이다.
같은 대화 재개는 실제 native 완료·정상 종료·exact resume가 검증된 계열에만 표시한다.
미지원 부분을 adapter의 존재나 help parser 성공으로 지원 완료라 하지 않는다.

## UI 범위

현재 단순 목록, 방향키, c 재조회, Enter 선택/확인, jobs 진행, q 닫기를 유지한다.
새 대시보드·웹·복잡한 메뉴를 추가하지 않는다. 기존 설치/최신/열린 세션/진행 상태로 충분하다.
update-only와 verified restart capability를 구분하고 실패 원인을 짧은 공개 code로 표시한다.
변경하면 실제 일반/작은 terminal screenshot을 확인한다.

## 현재 사실과 독립 범위

2026-10-05 공식 읽기 전용 조회: Claude npm/native latest2.1.289, stable2.1.285;
Codex npm/GitHub0.160.0; OMP18.6.1; Grok stable/npm1.0.46, alpha1.0.49;
AGY darwin_arm64 manifest1.2.16; Cursor public distribution2026.10.01-e373342.
Cursor public distribution은 effective channel release와 구분한다.

- 공통 부모: check-runtime, stored receipts, update-context/types/install consumer, runner/domain/worker,
  필요한 runtime 연결·scope census·격리 actual QA·최종 보고.
- npm 최신 worker: `src/service/npm-family-release.ts`, 전용 test만. Claude/Codex/OMP.
- native 최신 worker: `src/service/native-family-release.ts`, 전용 test만. Cursor/AGY/Grok.
- native 설치 worker: catalog-sources/catalog-provider와 인접 tests만. 과거 hash 제한과 현재 파일 관측.
- 공통 실행 권한은 독립 읽기 전용 설계로 contract change 검토 후 부모 구현.

## 실행 계약과 확인 순서

Claude native update는 `claude update`, npm/Bun은 실제 관리 설치에 결속한 공식 패키지 방식.
Codex는 원본 InstallContext의 manager·source 선택을 결속. bare PATH manager를 신뢰하지 않는다.
OMP 원본 updater는 native packages 동시 버전 고정·선택 설치·PATH/환경 결속이 필요하다.
Cursor updater는 부동 channel과 agent alias 충돌을 다루며 static exit0을 성공이라 하지 않는다.
AGY bootstrap은 설치된 CLI를 건너뛰므로 updater로 대체하지 않는다.
Grok native updater는 shared leaders relaunch가 있으므로 다른 세션을 건드릴 수 있는 경로를 update-only로 허용하지 않는다.

공식 archive/source와 격리된 원본 manager를 사용해 실제 update contract를 확인한다.
원본 실행 성공뿐 아니라 선택 설치 identity와 after 파일/버전·환경·scope를 대조한다.
자격 증명 없는 source/parser/loader 검증은 실제 모델 작업·자연 완료·재개 검증과 구분한다.
불가능한 external prerequisite는 다른 독립 작업을 끝낸 뒤 정확한 범위로 기록한다.

## QA 성공 기준

각 family: 최신 응답의 package/channel/name/version 일치, malformed·downgrade·equal·newer,
설치 drift와 다른 family alias 거절, HTTP bounded cancellation/실패를 검증한다.
actual owned installation: 원본 CLI artifact와 manager로 설치/버전/업데이트 또는 정확한 공식 제한 확인.
mutation: before selection와 resource census, durable intent/dispatch, 독립 after 검증, 다른 설치 불변.
restart: missing saved conversation/fresh fallback 금지, UUID/cwd/options 전체 일치, 작업 완료 선행.
전체 관련 bun test는 단일 실행 통과, typecheck/build/LSP, 소유 worker/core/browser/process cleanup0.
상태 목록을 각 작업 직후 갱신한다. source-only mock/fixture를 actual CLI 성공으로 보고하지 않는다.

## 관측된 결과

여섯 계열의 genuine 격리 product update-only 흐름을 모두 확인했다. Claude 2.1.288→2.1.289,
Codex 0.159.3→0.160.0, OMP 18.6.0→18.6.1, Grok 1.0.45→1.0.46,
Cursor 2026.01.23-916f423→2026.10.01-e373342, AGY 1.2.15→1.2.16이다.
각 기록은 실제 원본 실행·완료 job·독립 after inventory·owned cleanup을 구분한다.
package SUMMARY와 native-product-qa/REPORT는 herdr-cli-updater의 six-families evidence에 있다.
Grok 최종 run은 `packages/grok-product-qa/run-1791180717932/`이다.

현재 새 여섯 경로의 native exact resume는 지원하지 않는다. 운영 설치의 자동 권한 부여·등록도
이 격리 검증의 범위가 아니다. Claude는 실제 npm 원본 경로를 검증했으며 native 설치 mutation은
별도 지원으로 주장하지 않는다. Cursor의 운영 channel이 미확인일 때 최신 조회 실패를 유지한다.
AGY는 원본의 floating official-latest와 after 검증을 사용한다.

UI는 같은 한 줄 목록·Enter 확인·live job·d 진단을 유지했으며 80x24와 120x38에서 관측했다.
전체 단일 회귀 gate는 56개 파일의 2,948개 테스트 통과 뒤 typecheck와 build까지 exit 0으로 완료했다.
별도 변경한 profile routing 경계와 Grok dispatch HOME 회귀도 통과했다. Source LSP는 45개 파일에서 오류 0이다.
여섯 actual job의 owned worker·child·socket 정리를 확인했으며 운영 적용은 수행하지 않았다.
