# CLI updater 사용성 개선 결과

## 요청과 구현 범위

사용자는 격리 재실행 이후 불편한 plugin 개선을 요청했고, 범위 질문 timeout 뒤 추천 범위로 완료하라고 지시했다.
한 명령 진입, 기본 목록 탐색 오류, 읽기 가능한 오류와 doctor, 방향키/Enter 선택/확인,
진행/완료 요약과 상세 분리를 구현했다. 운영 CLI 업데이트/재시작, credential 읽기, Git 쓰기/배포는 하지 않았다.

## 실제 원인과 선택 이유

자동 탐색은 무관한 공유 PATH 폴더의 부모 권한 때문에 전체가 실패했고, system symlink와 없는 cask CLI leaf,
Homebrew .metadata도 후보로 검증했다. 모든 Homebrew 패키지 열거는 디렉터리 한도를 소모했다.
열거와 실행 후보 승인을 분리하고 존재하는 관련 CLI 후보만 검증한다. 알려진 CLI의 소유자/권한/지문/alias
검증과 관찰된 변경 거절은 유지한다. 실제 전체 탐색 약 2.3초에 기존 2초 예산이 부족해 4초로 조정했으며,
TUI 초기 installations/runtimes/jobs 요청들의 직렬 source scan은 15초 요청 deadline 안에서 수행한다.
doctor는 별도 임시 상태를 쓰고 운영 pin을 다시 학습하지 않는다.

## 변경 연결

- scripts/plugin.ts, herdr-plugin.toml: 기본 또는 open 명령은 기존 startWorker의 인증된 idempotent 계약으로
  worker를 시작/재사용하고 TUI를 연다. q는 UI만 닫는다. doctor는 읽기 전용 파일별 진단이다.
- src/service/catalog-sources.ts: 무관한 PATH 열거/숨김 cask/없는 leaf 처리, 관련 Homebrew 범위, sourcePath 오류 진단.
- src/tui/{host,catalog,select,job,recovery}.ts: 방향키/Enter, d 상세, 읽기 쉬운 결과/대상, 실패 다음 행동.
  초기 load 중 q도 정상 복원/종료된다. 내부 socket 해시는 기본 선택/완료 화면에서 숨긴다.
- test/service/plugin-open.test.ts: 실제 Bun PTY에서 기본 진입과 재진입의 worker PID 재사용/정상 q 종료.
- test/plugin-entry.test.ts, test/tui/host.test.ts: 실제 HOME 의존을 제거한 격리 fixture와 새 조작 계약.
- USAGE.md, src/tui/DESIGN.md: 사용법과 표시 원칙. 실제 QA run.mjs의 이전 화면 신호도 새 상태에 맞췄다.

## 실행 증거

- doctor: complete, 검증된 설치 6개, 설치 탐색 실패 0개.
- 전체 bun test: 2,136 pass / 0 fail, 42 files, 68.36초. typecheck/build exit 0.
- 최종 표시 변경 이후 관련 174개 pass / 0 fail, typecheck/build exit 0. LSP 변경 TUI/entry 오류 0.
- 실제 기본 PTY 120x40/80x24: 설치 목록, 방향키 선택, d 상세, Enter 미연결 runner 안내 확인.
- 실제 격리 lifecycle a868117b-d3f8-44e3-b6d7-ebbea76b2668 PASS.
- 최종 표시 lifecycle 3fb291c2-7e4e-486c-a719-8539c919d820 PASS, actualLifecycle true,
  동일 conversation/cwd/options/environment, duplicateEffects 0, cleanup joined/rootRemoved/resourcesRemaining 0.
  confirm.png와 completed-job.png를 직접 확인했다.
- 실패했던 초기 QA의 소유 worker 두 개까지 stopWorker로 종료했고 소유 브라우저/PTY/임시 root를 정리했다.

## 한계와 직접 확인

기본 화면은 목록/버전 확인이며 운영 runner/native 세션 권한은 자동 연결하지 않는다.
미연결 Enter는 Update runner not connected; no changes made를 표시한다. 실행 권한을 추정하지 않는다.
job에 업데이트 후 버전이 없으면 추정하지 않는다. 격리 reader는 이전 지문만 허용하여 완료 후 catalog stale_selection이
남을 수 있으나 job 검증과 재시작은 별도 완료이며 화면도 두 상태를 구분한다.

cd /Users/beomseok/Desktop/herdr-cli-updater 후 bun scripts/plugin.ts 실행.
이전 worker가 살아 있으면 사용자가 q/stop 후 다시 열어 새 코드를 적용한다. 이 작업에서 임의 종료하지 않았다.
방향키, c 확인, Enter 선택/확인, d 상세, u 재조회, 2 jobs, q 닫기를 확인한다.
목록 실패는 doctor에서 실패 경로/권한/지문 원인을 먼저 보고 u로 재조회한다.
전체 실제 업데이트 체험은 USAGE.md의 기존 격리 QA 명령을 쓴다.
