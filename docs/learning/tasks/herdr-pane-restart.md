# herdr 창 안 세션의 같은 대화 재시작 (2026-10-12)

## 문제와 결론

배포본 CLI(omo-ai 5.1.30 등)에는 herdr native 브리지가 없어 core의 엄밀한 종료·재개 계약을 쓸 수 없다. 그러나 herdr 서버 자체가 pane별 `agent_status`(idle/working/blocked/done)와 pane 입력·화면 읽기를 제공하므로, **사람이 키보드로 하는 것과 같은 방식**으로 종료→재개가 가능하다. 이 경로를 구현했고 실제 herdr에서 두 시나리오를 통과했다.

## 구현

- `src/app/herdr-panes.ts`: herdr 소켓 클라이언트. `agent.list`+`pane.process_info`로 pane별 상태·전경 PID, `agent.get`, `pane.read`, `pane.send_text`+`send_keys(Enter)`, `agent.wait`. 멀티라인 입력 거부. 에이전트 lifecycle 권한(report-agent 등)은 주장하지 않는다.
- `src/app/observations.ts`: 외부 세션의 PID 조상 체인이 어떤 pane의 전경 PID와 만나면 `herdrPane {paneId,status,stateChangeSeq}`를 붙이고 `control: "herdr-pane"`로 표시. `controller.ts`가 주기 관측 전후로 agent 목록을 비동기 갱신한다(관측 자체는 동기 유지).
- `src/app/pane-restart.ts` `restartInPane`: (1) pane 전경 PID가 세션 PID인지 확인, 아니면 `pane_changed` (2) `blocked`면 `agent_blocked` 거부 (3) `working`이면 서버 `agent.wait`로 idle까지 대기(기본 30분) (4) 종료 명령 전송(OmO/Pi/OMP/Codex/Claude 모두 `/exit`) 후 전경 PID 사라짐+프로세스 종료 확인, 안 되면 `exit_not_observed`(강제 kill 없음) (5) 화면에서 재개 ID 파싱(CLI별 정규식, 셸 메타문자 거부) (6) 재개 명령 전송 후 새 전경 PID가 살아 있고 idle/working이면 완료.
- `pane-restart` 명령(`validation.ts`/`types.ts`), 스냅샷 `paneRestarts`, UI: 세션 카드에 herdr 상태 배지, "같은 대화로 다시 시작"/"작업 끝나면 같은 대화로 다시 시작" 버튼, 단계 배지, 실패 사유 문구, 완료 시 PID 전환 표시.

## 실제 검증 (격리 워크스페이스 w28, 정리 완료)

1. idle 세션: `waiting-idle→exiting→resuming→completed`, PID 70297→71786, 같은 세션 ID `01a1301f-…`, 화면에 `omo (omo-ai 5.1.30)` 재기동.
2. working 세션: 세션에 `sleep 20` 작업을 주고 working 확인 후 재시작 요청 → 23초 동안 `waiting-idle`에서 대기 → 작업 완료 후 exiting/resuming/completed(PID 72250→73343). 같은 세션 파일에 `LOCAL_WORK_DONE` 결과가 남아 있음.
3. 첫 실행에서 `resume_not_observed` 실패: `agent.wait`가 재개 직후 옛 상태로 즉시 반환해 새 PID를 못 봤다. 재개 확인을 `agent.get` 폴링(새 PID 생존 + idle/working)으로 바꿔 해결. 폴링 간격은 `pause` 주입으로 테스트에서 즉시 진행.
- 회귀 108 pass(pane-restart 5, herdr-panes 4, observations/controller/server/validation), typecheck·build exit 0. 실제 UI 1440px 캡처 `session-ui-pane-restart.png`.

## 한계

- 작업 중 판정은 herdr의 `agent_status`에 의존한다. OmO 안에서 `!` 셸 명령을 직접 실행한 경우는 working으로 보고되지 않았다(모델 턴이 아니므로). 모델 턴 중인지는 정확히 잡힌다.
- 파일 쓰기 중간 보호·입력 경합 차단·옵션 해시 일치 증명은 native 브리지 경로에만 있다. 이 경로는 "idle일 때 정상 종료 명령"이라는 사람 수준의 안전성이다.
- 재개 ID는 CLI가 종료 시 화면에 출력하는 문구에 의존한다. OmO는 확인했고 Codex/Claude/OMP/Pi 패턴은 어댑터 재개 명령 형식에서 가져왔으나 실제 화면 문구는 각 CLI로 검증 필요.
- 실행 버전 수집은 여전히 미지원. herdr 밖 일반 터미널 세션은 pane이 없어 대상이 아니다.

## 직접 확인

웹 UI → 터미널 세션 → herdr에서 실행 중인 카드에 "대기 중/작업 중" 배지와 재시작 버튼. 문제 시 확인 순서: herdr 상태 배지 → 실패 사유 문구 → `herdr pane read <pane>` 화면 → 실행 상세의 pane ID.

## 업데이트 흐름에 통합 (2026-10-12 후속)

세션별 버튼은 보조 수단으로 남기고, 업데이트 시 herdr 창 세션 처리를 **설치별 정책**으로 정했다.

- 정책 값 `paneSessions`: `keep`(업데이트만) / `restart-idle`(대기 중만 재시작, **기본**) / `restart-all`(작업 중은 idle까지 대기 후 재시작, 상한 30분). `blocked`(응답 대기)는 어느 정책에서도 건드리지 않는다. `UpdatePolicy`에 저장되고(`validation.ts` 기본값), 기존 정책은 로드 시 `restart-idle`로 채워진다.
- 수동 승인(`confirm`): 대화상자에 "herdr 창 N개(대기 a · 작업 중 b · 응답 대기 c) · herdr 밖 d개는 관리하지 않음"과 정책 라디오를 보여주고 선택을 작업에 `paneSessions`로 기록한다. 명시하지 않으면 설치 정책을 쓴다.
- 자동 업데이트(`tick`→`confirm(automatic)`, 카탈로그 경로 `updates.confirm`): 같은 설치 정책을 쓴다. 자동 업데이트 화면의 각 CLI 카드(`Policy`, `CatalogPolicy`)에 라디오가 있고, 바꾸면 `policy` 명령으로 저장하되 스케줄(다음 확인 시각·대기 사유)은 유지한다. 지원 안 되는 CLI(자체 업데이트)에는 표시하지 않는다.
- 설치 완료 검증 직후(`finishUpdate` / 카탈로그 `updated` 콜백) `restartPaneSessions`/`restartCatalogPaneSessions`가 승인 시점에 기록된(또는 catalogId가 같은) herdr 창 세션을 정책대로 `restartInPane`에 넘기고, 세션별 결과를 작업의 `paneResults`(pending/completed/failed/skipped-working/skipped-blocked, PID 전환)에 남긴다. 업데이트 기록 화면에서 "herdr 창 세션 다시 시작 n/m"으로 펼쳐 볼 수 있다.
- 폴링 대기·프로세스 생존 확인은 `panePause`/`paneAlive` 의존성으로 주입해 테스트가 실시간 대기 없이 돈다.
- 회귀: 컨트롤러 정책 5개 시나리오(restart-idle×idle→completed, restart-idle×working→skipped-working, restart-all×working→wait 후 completed, blocked→skipped-blocked, keep→결과 없음), 카탈로그 정책 UI 1개. app+web 전체 415 pass, typecheck/build exit 0. 실제 화면: `policy-1-automation.png`.
- 한계: 작업 중 판정은 herdr `agent_status` 기준. 관리 세션(업데이터가 띄운 것)의 기존 restart 흐름과는 별개로 동작한다. 실제 설치 업데이트와 함께 끝까지 돈 것은 격리 테스트 pane의 같은 버전 재시작까지이며, 실제 새 버전 업데이트 직후 자동 재시작은 다음 OmO 릴리스에서 관찰해야 한다.

## 하위 프로세스 보호 (2026-10-13 수정)

- 발견: OmO가 모델 호출용으로 실행한 `claude --output-format stream-json …`(PID 61449)가 부모 OmO와 같은 전경 프로세스 그룹(pgid 63326)에 있었다. 그래서 herdr `pane.process_info`의 전경 목록에 함께 나왔다. 관측 코드가 이를 창 `w1R:pC`의 세션으로 연결해 Claude 카드에 재시작 버튼이 붙었다. 버튼을 누르거나 Claude 업데이트 정책이 돌면 `/exit`가 창의 실제 주인인 OmO에 입력돼 OmO가 종료될 수 있었다.
- 수정 1 (`observations.ts`의 `parentCli`): 조상 중에 다른 CLI 세션이 있으면 창을 연결하지 않고 `parentCliPid`만 기록한다. 카드에는 "하위 프로세스 · 관리 안 함"으로 표시한다.
- 수정 2 (`pane-restart.ts`): 입력하기 전에 herdr가 보고한 창의 에이전트 종류와 세션의 CLI를 비교한다. 대응 관계는 `pi`→OmO/Pi/OMP, `claude`, `codex`, `omp`다. 맞지 않으면 `pane_agent_mismatch`로 아무것도 입력하지 않고 중단한다. 알 수 없는 종류도 거부하며, 라벨이 없을 때만 통과한다.
- 회귀 테스트: 중첩 CLI는 같은 전경 그룹에 있어도 창에 연결되지 않는다(`observations.test.ts`). 다른 에이전트의 창은 입력 전에 거부한다(`pane-restart.test.ts`).

## herdr 상태가 실제와 다를 때 (2026-10-13)

- 발견: `agent.list`가 `working`이라고 보고하는 창 중 둘(AimBe-vault, social_login_buttons)은 화면이 `❯` 입력 프롬프트에 멈춰 있고 CPU도 1% 안팩이었다. herdr의 pi 감지 규칙 파일에는 "Working…" 스피너를 찾는 `working` 규칙 두 개뿐이고 `idle` 규칙이 없다. `agent.explain`(화면 재판정)은 작업 중인 창까지 idle로 나와 그 자체로는 믿을 수 없다. 실시간 상태는 OmO가 보내는 신호로 바뀜는 것으로 보이고, 두 창은 "turn 끝남" 신호가 빠진 채 `working`에 멈췄다. 이 때문에 09:03 재시작이 `idle_wait_timeout`(30분)으로 실패했다.
- 앱 쪽 대응(herdr를 고칠 수는 없으므로 어긋남을 드러내고 사람이 결정한다):
  - 관측: 컨트롤러가 갱신 때 창 화면(`pane.read`)과 `ps -o time=` 누적 CPU를 모아 `herdrPane.screenIdle`(프롬프트 보임 · 스피너 없음), `cpuPercent`(두 관측 사이 CPU 사용률), `cpuQuiet`(5% 이하가 두 번 연속)를 붙인다. `ps %cpu`는 평생 평균이라 쓰지 않는다.
  - 표시: herdr `working` + 화면 프롬프트 + CPU 조용함 2회 연속이면 "작업 중(herdr) · 화면은 입력 대기 · CPU n% · 상태 미갱신 의심"으로 바꾼다.
  - 재시작: 위 상태에서만 "화면 기준으로 지금 다시 시작" 버튼이 드러난다(`pane-restart` + `trustScreen`). 서버는 입력 직전에 화면과 CPU(2회 연속)를 다시 검사하고 아니면 `screen_not_idle`로 거부한다. 자동 정책은 그대로 "작업 끝날 때까지 대기"다.
  - 한계: 프롬프트는 하위 에이전트가 일하는 동안에도 보이고, 모델 응답 대기 중에는 CPU도 낮다. 그래서 자동 종료에는 쓰지 않고 사람이 누른 때만 쓴다.
- herdr 밖 세션(일반 터미널, ChatGPT, 브라우저 확장): 대시보드와 세션 목록에서 빼고 "N개는 관리하지 않습니다" 한 줄만 남긴다. 서버 관측은 그대로라 설치 통합 때 "실행 중이면 제거 안 함" 보호는 유지된다.
- 설치 화면 문구: "정리/제거" → "하나로 통합 (옛 사본 N개 정리 가능)". 결과가 한 설치로 통합되는 것이고 지우는 것은 PATH에서 밀려 실행되지 않던 예 사본이기 때문이다.
- 검증: app+web 회귀 425개 통과, 타입 검사·빌드 exit 0. 실제 화면에서 AimBe-vault(CPU 0.6%)와 social_login_buttons(2%)에만 배지와 버튼이 붙었고, 작업 중인 portfolio(6.9%)에는 붙지 않았다. 대시보드 "실행 중 세션"은 15→12, herdr 밖 3개는 한 줄 안내만 남았다.
