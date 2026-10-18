# 기본 패널 조회 실패 및 OmO 업데이트 불가

## 실제 원인

사용자 제보: OmO 외 모두 Failed, OmO도 업데이트 불가.
별도 owned worker의 check/targets 기록: `/Users/<user>/Desktop/herdr-cli-updater/.omo/evidence/catalog-sessions/1791132325789/checks-and-targets.json`.
- claude, codex 두 설치, cursor, omp: check는 unavailable/unsupported. 실제 통신 실패로 확정한 결과가 아니다.
- omo: installed 5.1.9, available 5.1.17. targets는 unsupported.
- 전체 targets unsupported. 로컬 기본 runtime.json 존재 여부는 false이며 내용/자격 증명을 읽지 않았다.
- 운영 herdr 읽기 전용 ping: version 0.9.3, protocol 22, capabilities live_handoff/detached_server_daemon/endpoint_protocol_generation/surface_interest/health_check/ssh_agent_registration. updater native 광고 없음.

코드: `src/service/check-runtime.ts` packageName은 omo/pi만 제공한다. `src/service/worker.ts`는 명시적 private runtime 설정이 없으면 runner를 만들지 않는다. `src/service/domain.ts`는 실제 native runtime이 없으면 targets unsupported를 반환한다. `src/service/plugin-runtime.ts`의 지원 프로필은 omo-5.1.9-to-5.1.10-native-abi4 하나다.

## 교정

`src/tui/host.ts`, `src/tui/catalog.ts`: unsupported와 실제 Failed 구분. 선택된 CLI의 공개 failure code를 별도 유지해 다른 자동 check가 원인 표시를 덮지 않는다. stock catalog는 version discovery와 runner/native 권한이 별개임을 표시한다. unsupported 선택 이후 해당 설치에 update unavailable 상태를 유지한다.
`src/tui/presentation.ts`: unsupported는 기존 warning 색. `DESIGN.md`, `USAGE.md`: 기본 모드와 격리 프로필을 구분한다.

## 검증과 남은 한계

catalog unsupported 회귀는 수정 전 실제 Failed 출력으로 실패했고, 수정 뒤 전체 TUI 183 pass / 0 fail, typecheck/build exit 0. host LSP error 없음.
기존 QA에 실제 CLI별 check와 targets 응답, OmO Enter 거절 및 jobs=[] 확인을 추가했다. 첫 재현 run은 응답 기록까지 완료했으나 전체 화면 검증 timeout(exit 1)이 있었고 cleanup은 terminal/browser joined/rootRemoved true. 이를 성공 QA로 보고하지 않는다.
두 번째 run `/Users/<user>/Desktop/herdr-cli-updater/.omo/evidence/catalog-sessions/1791132768581`도 timeout: 실제 목록은 omo가 첫 행인데 고정 codex 행을 기대한 QA 이동 조건이 틀렸다. failure.txt에는 omo 최신5.1.17, 타 계열 unsupported, claude 선택이 기록됐다. 정렬된 실제 프레임에서 행을 파싱해 다음 행과 OmO 위치를 추적하도록 harness를 수정했다. 제품의 버전 결과나 지원 제한을 이 조건에 맞춰 바꾸지는 않았다. 해당 run 자원도 joined/rootRemoved true.

현재 일반 사용자 설치 OmO를 최신 버전으로 자동 업데이트하고 대화를 재개하는 기능은 미구현/미연결이다. 이 UI 교정은 그 기능을 완성한 것이 아니다. stock native authority와 일반 설치의 updater 구성은 새 작업이 필요하며 운영 CLI 업데이트/세션 재시작 금지는 유지했다. 이전 격리 5.1.9→5.1.10 성공을 일반 5.1.17 업데이트 성공으로 대체하지 않는다.

최종 QA `/Users/<user>/Desktop/herdr-cli-updater/.omo/evidence/catalog-sessions/1791133005041`: PASS, exit 0. actual stock discovery/owned worker/PT Y에서 OmO 최신5.1.17과 타 계열 unsupported 표시, 선택 후 runner/native 미연결 안내를 확인했다. jobs-after-refusal.json은 jobs=[]이다. automatic-latest.png(120×40) 및 omo-update-unavailable.png(80×24)를 직접 확인했다. cleanup.json: terminal joined, browserJoined, serverStopped, rootRemoved true. 이는 차단 동작 및 표시의 검증이며 업데이트 성공 검증이 아니다.
