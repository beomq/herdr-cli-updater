# 세션 중심 updater UI 완료

## 요구와 구현

- `src/tui/host.ts`: 인증된 runtime의 socket/pane 조합을 중복 제거해 열린 세션 수를 표시한다. 탐색 실패는 0으로 바꾸지 않고 unknown으로 유지한다.
- `src/tui/select.ts`: 열린 세션 수와 재시작 선택 수를 함께 표시한다. Space로 명시적으로 선택하고 Enter로 확인한다. 최종 확인 전에는 실행되지 않으며 선택한 세션만 대상이다.
- `src/tui/job.ts`: 작업 완료, 안전 종료, 설치 검증, 같은 대화 재시작 검증을 실제 job 상태에서 따로 표시한다. 현재 작업을 강제로 중단하지 않는다.
- `src/service/client.ts`, `src/service/socket.ts`, `scripts/plugin.ts`: 원자적 current 구독 후 상태 조회로 패널을 연다. 기존 이벤트와 엄격한 sequence 검증을 재사용하며 추정 진행률이나 주기적 polling은 없다.
- `USAGE.md`: 조작법, 세션 수 의미, 자연 종료 후 재시작, live 진행 및 연결 제한을 설명한다.

## 실행 증거

최종 실제 QA 디렉터리:
`/Users/<user>/Desktop/herdr-cli-updater/.omo/evidence/herdr-cli-updater/one-family/actual-qa/execution/runs/ef1b9610-691d-48fd-afa1-e070f3b39089`

실행 명령:
`ONE_FAMILY_PARENT_RELEASE=1 ONE_FAMILY_PLUGIN_ACTION=1 bun .omo/evidence/herdr-cli-updater/one-family/actual-qa/execution/run.mjs`

- herdr plugin action → 실제 overlay → 제품 entry → 실제 busy 작업의 자연 종료 → 안전 종료 → 실제 설치 변경 → 같은 대화 재시작: PASS, exit 0.
- `native-before-after.json`: full_id, storage_identity, cwd, options_sha256, environment_sha256 보존. 새 프로세스와 증가한 binding generation 확인.
- `automatic-progress.json`: 완료 화면에 도달할 때 수동 `u` 입력 없음.
- `selected-target.png`, `waiting-for-work.png`, `completed-job.png`, `completed-job-small.png`: 120×40과 80×24 직접 시각 확인. 선택 수, 자연 종료 안내, 완료 수가 읽히며 겹침 없음. 작은 화면의 긴 진단·단축키는 폭에 맞게 축약한다.
- 초기 크기 변경 캡처는 이전 grid의 출력과 섞여 잘못 보였다. QA 캡처를 크기 변경 후 출력만 사용하도록 수정하고 헤더·완료·재시작 문구를 함께 확인한 최종 실행으로 대체했다. 이전 실행 증거는 보존했다.
- `harness-cleanup.json`: failures 없음. `isolation-cleanup.json`: rootRemoved true, actionState joined, resourcesRemaining 0.
- 관련 검사: `bun test test/tui test/service/client.test.ts test/service/socket.test.ts test/plugin-entry.test.ts` 296 pass / 0 fail, typecheck와 build exit 0.
- 확인 전 예약 안내 최종 수정 후 `bun test test/tui/select.test.ts` 52 pass / 0 fail, typecheck와 build exit 0. client/host/socket 언어 서버 error 없음.

## 직접 사용과 한계

등록된 herdr에서 `herdr plugin action invoke updater --plugin beomq.cli-updater`로 연다.
CLI를 선택하고 `c`로 확인한 뒤 Enter, Space로 재시작 대상 선택, Enter로 최종 확인한다.
최종 확인은 실제 업데이트 실행 의사 표시이며, 화면 확인만 하려면 확인 전에 Esc 또는 q로 닫는다.

지원 범위는 기존 한 계열 프로필 `omo-5.1.9-to-5.1.10-native-abi4`와 검증된 native 연결이다.
일반 stock herdr/임의 CLI에서 운영 업데이트가 지원된다는 뜻은 아니다.
기존 worker에 새 코드를 적용하려면 사용자가 별도로 종료·시작해야 한다. 이 작업에서는 운영 worker나 사용자 CLI 세션을 재시작하지 않았다.
실패 시 Live 연결 오류 → runtime 설정/qualification → 설치 pin → native binding/저장 대화 파일 → recovery 상태 순서로 확인한다.
QA 통과와 사용자 직접 확인은 별개이며 후자는 아직 미확인이다. 커밋·푸시·PR·배포와 자격 증명 접근은 수행하지 않았다.
