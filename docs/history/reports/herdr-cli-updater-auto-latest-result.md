# Latest 자동 확인

## 구현

- `src/tui/host.ts`: 로컬 catalog refresh 후 CLI별 check를 백그라운드로 시작한다. 시작 프레임과 설치 버전은 즉시 보이고 입력 큐를 막지 않는다.
- `c`는 선택한 CLI 재확인이며 같은 CLI의 진행 중 Promise를 재사용해 중복 check를 보내지 않는다.
- 자동 첫 확인은 각 CLI를 순차 발행한다. 공유 인증 클라이언트의 큐에 모든 조회를 한꺼번에 넣어 뒤쪽 요청이 시작 전에 timeout되지 않게 한다.
- check 결과로 host의 lastCheck/Latest 표시와 필요 시 CatalogComponent snapshot을 갱신하고 즉시 draw한다. 별도 u 재조회는 필요 없다.
- `src/tui/catalog.ts`: host의 조회 중 상태를 받아 Checking/Not checked/Failed/버전으로 구분한다. up-to-date는 확인된 installedVersion을 표시한다.
- 실패 시 설치 증거를 덮어쓰지 않는다. 공개 오류 코드를 상단에 표시하며 업데이트는 기존 명시적 선택/최종 확인을 유지한다.
- `USAGE.md`, `DESIGN.md`: 자동 첫 확인과 c 재확인, 상태 의미를 기록했다.

## 검증

관련 서비스 포함 검사 369 pass / 0 fail. 이후 마지막 변경 대상으로 host/catalog 70 pass, 중복 c 회귀 host 25 pass, 전체 TUI 182 pass / 0 fail. 최종 typecheck/build exit 0; host/catalog/test host 언어 서버 오류 없음.

결정적 실제 UDS 회귀는 first check를 Promise로 보류한 상태에서 초기 Checking과 방향키 입력 응답을 확인하고, c를 눌러도 호출이 1회인지 검증한다. 해제 뒤 update-available 버전이 즉시 반영되고 두 번째 c의 up-to-date 값이 별도 u 없이 반영됨을 확인한다. 고정 sleep은 없다.

실제 stock herdr를 읽는 별도 owned worker와 PTY/xterm 캡처는 기존 `scripts/qa-catalog-sessions.mjs`를 확장해 사용한다. 운영 worker/CLI 세션은 재시작하지 않았다. 외부 최신 버전 조회는 각 설치의 기존 check qualification 결과에 의존한다. 이 작업이 unsupported 설치를 지원하는 것은 아니다.

최종 실제 QA PASS/exit 0: `/Users/<user>/Desktop/herdr-cli-updater/.omo/evidence/catalog-sessions/1791129898604`.
automatic-latest/rechecked-latest/catalog-small 캡처에서 자동 조회와 c 결과 즉시 반영, regular 120×40과 small 80×24를 확인했다. OmO 설치 5.1.9의 최신 버전은 실제 5.1.16으로 조회됐다. 다른 설치는 기존 check qualification이 unsupported 등의 실패를 반환해 Failed로 표시됐다. 이는 해당 계열 check 지원을 추가했다는 결과가 아니다. cleanup.json은 terminal joined, browserJoined/serverStopped/rootRemoved true다.
최종 순차 조회 수정 뒤 host/catalog 70 pass / 0 fail, typecheck/build exit 0. 자동 조회/재확인 UX는 실행 검증됐고 모든 설치의 외부 check 지원은 범위 밖 기존 한계다.

QA의 부분 PTY 프레임이나 병렬 xterm 판독이 완료 캡처로 잘못 해석되는 문제를 수정했다. wait가 종료되면 기존 predicate 큐를 정리하고 완전한 6개 행·하단 border 및 Checking 없음이 확인된 raw 프레임을 캡처한다. 이전 증거는 보존했다.

## 직접 확인

진행 중 updater job이 없다면 기존 패널 q → 저장소에서 `bun scripts/plugin.ts stop` → `herdr plugin action invoke updater --plugin beomq.cli-updater`로 새 worker/패널을 연다. CLI 대화 재시작이 아니다.
Latest가 자동으로 Checking에서 버전 또는 Failed로 바뀌는지 확인한다. 선택한 CLI에서 c를 누르면 즉시 다시 Checking 후 결과가 바뀐다. 네트워크/권한 실패는 상단 코드로 확인하며 설치 버전은 유지된다.
사용자 직접 확인은 아직 미확인이며, 커밋·푸시·PR·배포·자격 증명 접근은 하지 않았다.
