# herdr plugin action / styled updater 제품 연결

## 범위

`/Users/beomseok/Desktop/herdr-cli-updater`의 workspace action → overlay pane →
`scripts/plugin.ts open` → 실제 worker → 기존 OmO 한 계열 runner/native 재개를 연결했다.
운영 CLI·현재 사용자 세션·인증 파일은 건드리지 않았다. 커밋·푸시·PR·배포는 하지 않았다.

## 실제 성공 증거

최종 제품 코드 실행:
`.omo/evidence/herdr-cli-updater/one-family/actual-qa/execution/runs/c626e143-0069-49be-800b-445a98f1f3e0/`
(경로 기준은 `/Users/beomseok/Desktop/herdr-cli-updater`이다.)

- `plugin-action.json`, `plugin-link.json`: 실제 workspace action과 overlay 진입.
- `catalog.png`, `checked-catalog.png`, `selected-target.png`, `confirm.png`: 목록·최신 버전·명시적 pane 선택·확인.
- `job.json`, `completed-job.png`: 실제 설치와 선택 pane 재시작 검증 완료.
- `native-before-after.json`: 같은 full conversation ID, storage identity, cwd, options hash.
  새 PID와 pane generation은 재시작에 따라 바뀌었다.
- `result.json`: PASS, actualLifecycle=true, duplicateEffects=0.
- `harness-cleanup.json`, `core-cleanup.json`, `isolation-cleanup.json`: owned child join,
  worker stop exit 0, failures=[], actionState=joined, resourcesRemaining=0.

실행 명령:

```sh
cd /Users/beomseok/Desktop/herdr-cli-updater
ONE_FAMILY_PARENT_RELEASE=1 ONE_FAMILY_PLUGIN_ACTION=1 bun .omo/evidence/herdr-cli-updater/one-family/actual-qa/execution/run.mjs
```

## 관련 검사

최종 제품 변경에 대해 worker/runtime/entry/manifest 회귀 54 pass, 0 fail;
`bun run typecheck`, `bun run build` exit 0.
styled TUI 관련 `bun test test/tui` 179 pass, 0 fail.
runtime·worker·runtime 테스트 LSP error 없음.

실제 검증 중 발견하여 수정한 문제:

- 실물 입력은 11,974,185 bytes여서 8MB 제한을 넘었다. 64MB bounded 입력으로 조정하고
  8MB 이상 설정 load 회귀를 추가했다.
- 28,379개 독립 핀의 이차 비교를 같은 의미의 Set 포함 검사로 교체했다.
- action은 PATH 대신 host가 제공하는 `HERDR_BIN_PATH`를 사용한다.
- worker 시작 실패는 IPC로 제한된 runtime 원인 코드를 전달한다.
- worker stop은 디렉터리·정규 파일 retirement를 구독하고 control HTTP 연결을 닫는다.
- 저장 대화 파일 누락은 mutation admission 이전 lifecycle inspect에서 거절한다.
- QA 준비가 worker 독점 디렉터리를 선점하지 않도록 owned 입력을 분리했다.
- 격리 herdr onboarding 키 가로채기를 해제했고 cursor 차분 출력은 xterm 현재 화면으로 판정한다.

## 사용과 한계

기본 진입은 `bun run build`, `herdr plugin link /Users/beomseok/Desktop/herdr-cli-updater`,
`herdr plugin action invoke updater --plugin beomq.cli-updater`이다.
색상·테두리·선택 강조가 있는 목록에서 `c` 확인, Enter 선택·확인, Space pane 선택,
`m` 모드, `u` 진행 재조회, `q` 화면 닫기를 사용한다.

업데이트 권한은 `omo-5.1.9-to-5.1.10-native-abi4`의 별도 승인된 private JSON 설정이 필요하다.
설정 없는 일반 진입은 관찰 전용이다. stock herdr/임의 OmO 버전 지원은 아니다.
QA 성공은 사용자 이해 확인이나 운영 적용 승인이 아니다.

실제 제품 action 실패 시나리오:

- 저장 대화 누락: `21d7c5a9-4ffb-4adc-b479-15e99dfe984c` PASS.
  `jobs=[]`, installerEffects=0, unsafeStarts=0, 기존 binding 유지.
- 설치 실행 파일 누락: `0ee094c1-a8e6-44bd-bc3e-f82c5100b19b` PASS.
  job/install/target는 `recovery_required`, `receipt_uncertain`을 표시하며 unsafeStarts=0.
  성공으로 오인하거나 새 대화로 fallback하지 않는다.
- 두 경우 모두 harness failures=[], worker stop exit 0, actionState=joined,
  rootRemoved=true, resourcesRemaining=0.
- 재시작 profile 불일치: `91b31d8d-3686-4908-83bc-95e7b3802fc6` PASS.
  설치는 succeeded지만 job/target는 recovery_required와 receipt_uncertain을 표시한다.
  unsafeStarts=0이며 새 대화로 fallback하지 않는다.
  harness failures=[], worker stop exit 0, actionState=joined, rootRemoved=true,
  resourcesRemaining=0.

## 완료 감사

- 실제 workspace action → overlay → production entry는 최종 성공 run의 plugin action,
  화면 캡처, 실제 job/native receipts로 확인했다. QA factory는 제품 worker에 주입하지 않았다.
- 목록의 CLI/installed/latest/panes/eligibility, 선택/확인, 관찰 진행은 실제 캡처와
  179개 TUI 회귀로 확인했다. 80x24 폭·높이와 조작은 TUI 회귀 범위이며,
  실제 herdr 전체 흐름 캡처는 120x40 터미널이다.
- 업데이트/재시작 성공, exact conversation/storage/cwd/options 보존, 중복 효과 0회는
  최종 성공 run의 result와 native before/after로 확인했다.
- 실패 세 종류는 각각 실제 제품 action을 거쳐 확인했다. 대화 누락은 admission 전 거절,
  설치/재시작 실패는 recovery_required로 기록하고 unsafe start를 하지 않는다.
- 관련 54개 회귀, 179개 TUI 회귀, typecheck/build를 통과했다. 사용자 직접 검증과
  운영 적용은 수행하지 않았으며 이 결과와 구분한다.
- 최종 소유 프로세스 조회에서 격리 QA/worker/pane 자식 잔여가 없었다.
  저장소 staging/commit/push/PR/deploy와 운영 CLI/사용자 세션 변경은 수행하지 않았다.
- 사용 명령과 private 승인 설정의 제한은 제품 `USAGE.md`에 기록했다.
