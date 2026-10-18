# 일반 운영 설치 업데이트 연결: 확인된 누락

## 사용자 결과

기본 plugin 화면에서 발견한 실제 설치를 선택해 최신 확인과 업데이트를 실행한다.
격리 QA profile을 주입한 성공을 일반 설치 지원으로 대신하지 않는다.
현재 사용자 CLI·세션·herdr의 업데이트와 재시작은 수행하지 않는다.

## 현재 실행 결과

- 이전 worker는 PID 40041이며 jobs가 비어 있었다. plugin-only reload로 PID 77416이 소유한다.
- 실제 설치 최신 확인: Claude 2.1.247 -> 2.1.289, 두 Codex 0.153.2/0.156.0 -> 0.160.0,
  OMP 17.1.8 -> 18.6.1. 이는 읽기 전용 check 결과다.
- runtime.json은 없다. 기본 open은 unconfigured/read-only다.
- 현재 herdr 0.9.3의 CoreOperationsClient.discover는 unsupported_version이다.
- 실제 Claude는 native 설치다. 기존 npm Claude QA를 그 native 실행 승인으로 사용하지 않는다.
- OmO와 OMP는 ~/.bun/install/global을 공유한다. 작은 독립 prefix처럼 승인할 수 없다.

## 이번에 고친 범위

scripts/plugin.ts의 reload는 인증된 jobs 목록이 비었을 때만 plugin worker를 교체한다.
job이 있으면 resources_busy로 거절한다. CLI·사용자 대화·herdr 교체는 하지 않는다.
src/tui/host.ts는 runtime이 연결되지 않았을 때 Ready 대신 Read-only를 표시한다.
USAGE.md는 u가 데이터를 재조회할 뿐 코드를 교체하거나 runtime을 등록하지 않는다고 설명한다.
관련 84개 테스트, typecheck, build가 통과했다. 실제 PTY 80x24와 120x38 화면을 확인했다.

## 빠진 제품 구현

src/service/package-runtime.ts의 qualified-package-update-only-v1은 설치 discovery를 실행 권한으로
승격하지 않는다. before/after 전체 inventory, original manager closure, target integrity,
독립 postinstall 결과, expected-after, socket/process census와 최대 300초 freshness를 요구한다.

현재 scripts/family-update/acquire-packages.mjs는 소유한 격리 prefix를 생산한다.
qa-package-products.mjs는 그 산출물을 조립한다. 일반 설치 기준의 승인 producer는 없다.
preparePluginRuntime도 이미 native-qualified인 pane과 설치 candidate를 요구한다.

일반 producer는 다음을 실제 관측해서 만들어야 한다.

1. 정확한 실행 alias, 물리 installation, original manager와 shared mutation prefix 식별.
2. 운영 설치는 읽기만 하고 독립 owned scope에서 original target acquisition/calibration 실행.
3. 공유 prefix의 영향 범위 및 original before/expected-after를 충실히 반영하는 profile 생산.
4. 실제 실행 시 source drift·live consumers·다른 socket을 다시 확인하고, update-only를 명시.
5. 업데이트 후 actual files/version을 검증하며 실패나 uncertain 상태는 자동 재시도하지 않음.

HOME와 config 내용 및 credential 파일은 읽지 않는다. 기존 qualified root·HOME 제한에 맞지 않는
운영 설치를 억지로 private profile에 넣거나 source path/version/time을 바꿔 QA receipt를 재활용하지 않는다.
일반 설치 계약이 필요하면 그 경계를 명시적으로 구현·검증해야 하며 기존 guard를 제거하지 않는다.

## 구현 범위 선택 대기

사용자가 `업데이트먼저`라고 명시적으로 선택했다. 일반 설치 update-only 등록을 먼저 연결한다.
업데이트 전용은 현재 herdr를 유지하며 live consumer가 있는 실제 설치를 거절하는 경로다.
동일 대화 재시작은 별도 native host 지원이 필수이고, 현재 host를 바꾸는 마지막 단계는 운영 적용 승인이다.
어느 경우든 일반 운영 설치의 업데이트 등록 구현은 미완료이며 완료로 보고하지 않는다.

## 독립 구현 진행

운영 herdr 교체가 필요 없는 npm Codex update-only 등록을 먼저 구현한다.
일반 prefix는 현재 실제 관측상 755이며, 기존 private prefix 700·동일 owned root 계약과 다르다.
기존 private qualifier를 유지하고 별도 명시적 operating-prefix 경계를 만든다.
운영 prefix를 owned 임시 root처럼 꾸미거나 HOME 권한을 바꾸지 않는다.

- producer: 실제 prefix는 읽기만 하고 별도 owned clone에서 original npm target calibration.
- consumer/runtime: npm Codex 한정 명시적 profile, 실제 prefix exact owner/mode/link/source 검증,
  owned HOME·socket·cache, 동일 whole-prefix lsof gate와 static manager-child confinement.
- 부모: 실제 plugin 명령 연결, producer 결과·회귀·읽기 전용 실제 등록 검증.

공유 ~/.bun/install/global/package.json에는 OmO·OMP 외 여섯 관련 패키지와 trustedDependencies가 있다.
OmO와 OMP 업데이트 등록은 이 전체 의존·native 출력·외부 소비자 영향까지 반영해야 한다.
native Claude와 Cursor, 그리고 OmO exact resume를 npm Codex 등록 성공으로 대체하지 않는다.
