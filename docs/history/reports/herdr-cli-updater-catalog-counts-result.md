# 단일 행 catalog와 표시용 세션 연결

## 완료 범위

- `src/tui/host.ts`, `src/tui/catalog.ts`: 기본 목록은 CLI/Installed/Latest/Open/Working/Ready 한 줄이다. 방향키는 강조만 바꾼다. channel/installed/check 자동 확장을 제거하고 d 진단에만 추가 정보를 둔다.
- `src/tui/presentation.ts`: 6열 너비를 regular와 80×24 terminal에 맞춘다.
- `src/protocol.ts`, `src/service/client.ts`, `src/service/domain.ts`: 표시용 sessions DTO와 엄격한 검사. 기존 runtimes/targets/create-job의 권한 검증은 유지한다.
- `src/catalog.ts`, `src/service/catalog-provider.ts`: stock herdr agent.list 상태를 표시 관찰로 전달한다. 정확히 발견된 OmO plugin --extension 경로가 foreground argv에 있어야 Pi 엔진을 OmO로 표시한다. argv와 저장 대화 값은 DTO에 노출하지 않는다.
- 목록의 기본 refresh에서 사용하지 않는 권한용 runtimes 조회를 제외했다. 업데이트 선택 시 권한 검증은 별도로 수행한다.
- `DESIGN.md`, `USAGE.md`: 단일 행 계약과 개수 의미, 미확인 상태를 문서화했다.

## 실제 실행과 한계

실제 stock herdr를 읽기 전용으로 조회하는 소유 worker/PTY 실행:
`bun scripts/qa-catalog-sessions.mjs`

최종 화면 증거:
`/Users/<user>/Desktop/herdr-cli-updater/.omo/evidence/catalog-sessions/1791121688890`

`sessions.json`은 12개 OmO 세션을 관찰했다. 화면에서 Open=12, Working=2, Ready=-였다.
다른 계열은 관찰된 세션이 없으므로 Open/Working/Ready=0이었다.
catalog.png/catalog-moved.png/catalog-small.png를 직접 확인했다. regular 120×40과 small 80×24 모두 세 개 count 열이 보였고 방향키 이동 시 진단 행이 펼쳐지지 않았다.
cleanup.json은 owned terminal joined, browser joined/server stopped, rootRemoved=true를 기록한다.

Ready는 idle 개수가 아니다. stock herdr는 producer-local 또는 detector 상태만 관찰되며 qualified all-work/hook 완료 증명이 없어 해당 값은 null/`-`다.
실제 완료 근거가 존재하는 경우에만 update-available 및 supported update/readiness/completion/resume/gracefulExit 조건과 결합해 Ready를 계산한다.
같은 계열의 여러 설치는 family 개수를 공유하며 설치 파일 소유권으로 해석하지 않는다.
운영 세션/CLI나 기존 updater worker는 재시작하지 않았다. 기존 worker에 새 백엔드 코드를 적용하는 것은 별도 사용자 조작이다.

## 검증

관련 단일 실행 대상:
`bun test test/tui test/protocol.test.ts test/service/client.test.ts test/service/catalog-provider.test.ts test/service/domain.test.ts test/service/socket.test.ts test/plugin-entry.test.ts && bun run typecheck && bun run build`

최종 직접 실행: 495 pass / 0 fail, typecheck/build exit 0. host/catalog/domain/provider 언어 서버 error 없음.

UI 중복 제거로 기존 자동 상세 테스트는 d를 명시적으로 입력하도록 갱신했다. 6열 padding 테스트는 6개 machine 값으로 검증한다.
stock UDS 회귀는 sessions 성공에도 runtimes/targets/create-job unsupported를 유지함을 검증한다. 소스 실패/unknown 상태를 0으로 바꾸지 않고 엄격한 wire shape를 검증한다.
실제 QA 초기 실패 원인은 macOS /tmp 별칭 canonical 경로와 불필요한 권한용 조회의 timeout이었다. QA root를 realpath로 만들고 기본 표시 조회를 분리해 최종 PASS를 얻었다. 이전 실패 증거는 보존했다.

## 직접 확인

진행 중 updater job이 없는 상태에서 기존 패널 q → `cd /Users/<user>/Desktop/herdr-cli-updater` → `bun scripts/plugin.ts stop` → `herdr plugin action invoke updater --plugin beomq.cli-updater` 순서로 updater worker만 새 코드로 연다.
이는 CLI 대화를 재시작하는 명령이 아니지만 진행 중 updater job이 있다면 종료하지 않는다.
방향키로 목록 선택, u로 최신 관찰 재조회, d로 진단을 확인한다. 새 상태 숫자는 재조회 시점의 관찰이며 추정 count나 polling이 아니다.
업데이트 실행은 native 설정과 최종 확인이 별도로 필요하다. 사용자 직접 확인은 미확인이다.
