# Native 운영 전환 준비

## 2026-10-06 현재 버전 재시작 검증

운영 전환용 release 빌드는 `.local/native-target/release/herdr`이며 실제 버전은
0.9.3, SHA-256은 `af41e6590d98e0ab3bb37e0712aded51afe6e9ee7ce19792d4fb8b65e259f0db`이다.
원본 Rust 1.96.1과 Zig 0.16.0 환경에서 `cargo build --locked --release` exit 0을 확인했다.
release에서도 플러그인 update-and-restart 전체 흐름을 다시 실행해 PASS를 확인했다.
증거는 execution/runs/54e263b4-ae58-4ef4-95c9-3ad4f4ca55a2이며 PID는 27785에서
30632로 바뀌고 대화 ID·storage·cwd·options·환경이 유지됐다. 최종 설치는
OmO 5.1.19 / Senpi 2026.10.10이며 중복 실행 0회, cleanup 잔여 리소스 0이다.
이 바이너리를 현재 운영 서버에 적용한 것은 아니다.

release 실패 처리 5개도 실제 실행 결과에서 PASS를 확인했다. 잘못된 대상 선택과
정상 종료 실패는 unsafeEffects 0, 대화 파일 누락은 installerEffects 0 및 unsafeStarts 0,
업데이트 실패와 재개 실패는 recovery_required 및 unsafeStarts 0이었다.
자동 재실행이나 다른 대화로의 대체 실행은 없었다. 모든 실행의 core 종료 exit 0,
rootRemoved true, resourcesRemaining 0을 확인했다. 마지막 monitor 알림은 세션이
분리된 동안 소실됐지만 아래 result·cleanup 파일은 모두 기록돼 있어 재실행하지 않았다.
증거 위치는 `.omo/evidence/herdr-cli-updater/one-family/actual-qa/execution/runs/` 아래다.

- wrongtarget: `a97ef6ec-8724-47d8-a4ad-9d32f925fa25`
- missingconversation: `86720bef-180d-403b-8bf7-baf1f35aed95`
- gracefulexit: `96ca4783-9ff4-4ade-8606-aebaed7221a7`
- update: `eba36435-fc90-4283-9213-05d232ce5307`
- resume: `6b0f0989-702f-40a8-87b0-fa6d42210b2c`

운영 0.9.3과 같은 upstream tag에 ABI4 native 계약을 이식한 별도 작업 경로는
`/Users/beomseok/Desktop/herdr-updater-core-source-cache/.worktrees/session-restart`이다.
debug 바이너리는 `.local/native-target/debug/herdr`이며 실제 버전은 0.9.3이다.
debug 데이터 위치는 `herdr-dev`이므로 release용 `herdr` profile 위치와 구분한다.
운영 `/Users/beomseok/.local/bin/herdr`와 기존 열린 세션은 교체하거나 재시작하지 않았다.

실제 plugin `launch`로 연 격리 OmO 대화에서 claim·자연 작업 종료·stop·start·release를
검증했다. 대화 ID·storage identity·cwd·options·환경을 유지하면서 PID는 12996에서
13147로, generation은 1에서 2로 바뀌었다. 결과는
`.omo/evidence/herdr-cli-updater/one-family/actual-qa/execution/native-runs/5ee8303c-5a13-4454-88cf-63cdf7bcc2e3/native-restart-only.json`이다.
cleanup은 rootRemoved true, processes 빈 배열, resourcesRemaining 0이다.
이 결과는 재시작만 증명하며 최신 버전 업데이트와 결합한 결과를 대신하지 않는다.

최신 OmO 5.1.19 / Senpi 2026.10.10의 원본 source·native hook overlay는
`/private/tmp/herdr-session-restart-native-519-r3/preparation.json`에 준비했다.
source gates 9개와 source resolution 회귀 121개는 통과했으며 이 receipt 자체는
설치·native lifecycle 권한을 발급하지 않는다. 실제 업데이트 및 재시작 검증은 별도다.

### 최신 버전 실제 제품 통합 결과

플러그인 설치·workspace action·pane TUI 경로로 5.1.9에서 5.1.19까지 실제 설치하고,
진행 중 bash 작업의 자연 종료를 기다린 뒤 동일 대화를 재시작했다.
`.omo/evidence/herdr-cli-updater/one-family/actual-qa/execution/runs/dd2bc1b4-f41e-4da6-addd-af63b047f625/result.json`
결과는 PASS, actualLifecycle true, duplicateEffects 0이다. 최종 설치 그래프에서
OmO 5.1.19와 Senpi 2026.10.10을 확인했다. `native-before-after.json`의 대화·환경·cwd
불변 증명과 native stop/start receipt를 함께 확인했다. 완료 UI에는 restart 1/1 verified가
표시되며 넓은 화면과 좁은 화면의 PNG를 직접 확인했다. isolation cleanup은 잔여 리소스 0이다.

제품 관련 회귀 116개, source 준비 회귀 121개, 타입 검사와 빌드가 통과했다.
이 결과는 새로운 현재 버전 서버의 제품 경로에서 얻었으며 현재 운영 socket의 native
지원이나 이미 열린 일반 세션의 자동 채택을 의미하지 않는다. 운영 적용은 서버 교체와
새 관리 profile·세션 등록 단계가 별도로 필요하다.

## 현재 적용 상태

### 2026-10-06 운영 native 전환

후속 표시·최신 검사 수정: live handoff 뒤 title 기반 `agent.list`가 새 출력을 내보낸 3개만
반환하는 동안 실제 foreground OmO pane는 15개였다. native 관찰 1개가 일반 표시 source를
가리던 문제를 분리했다. 일반 세션은 pane·foreground argv·실제 wrapper/engine manifest와
entrypoint로 분류하고 소켓·pane별 중복을 제거한다. 새 채팅 없이도 열린 세션은 표시하지만
`unknown` 작업 상태를 완료로 승격하거나 일반 세션에 native 권한을 부여하지 않는다.

최신 검사 수정은 동일 worker의 인증된 연결 3개로 최대 3건 동시 실행, refresh의 목록·세션·job
병렬 조회, installations 요청에서만 fresh scan, 선택 candidate만 다시 검증하는 방식이다.
같은 snapshot을 재사용해도 파일·alias 검증을 생략하지 않으며 최초 요청 취소를 이후 검사에
전파하지 않는다. 명시적인 `u` 또는 패널 재열기는 새 설치를 탐색한다.
통합 관련 테스트 231개가 통과했고, 다른 기존 prefix 분류·취소 회귀 추가 후 각각 관련
118개·68개 테스트와 typecheck/build가 통과했다. 실측과 화면은
`operating-native/evidence/catalog-latency.json` 및 `evidence/ui/timing.json`에 남겼다.

사용자 승인 후 검증된 herdr 0.9.3 / protocol 22 바이너리로 live handoff를 실행했다.
기존 24개 pane와 12개 workspace ID를 보존했다. 기존 대화의 CLI를 종료하거나 재시작하지 않았다.
`~/.local/bin/herdr`도 같은 검증 바이너리로 교체했다. 이전 바이너리는
`~/.local/share/herdr-cli-updater/operating-rollout/20261006/herdr-before`에 보관했다.

기본 `omo` 두 launcher는 `operating-native/prefix-r6`의 OmO 5.1.19 / Senpi 2026.10.10을 실행한다.
설치는 SHA 고정 Bun 1.3.6 원본 manager를 사용했으며, 실제 실행은 Bun 1.4.2를 사용한다.
별도 prefix에서 원본 frozen 설치와 launcher를 재실행해 패키지 출력 28,892개를 비교했다.
lock은 원본 graph를 비교하고 localhost registry 주소·prefix와 서식 차이만 구분했다.
사용자 `.npmrc`는 읽거나 바꾸지 않았으며 updater installer에만 별도 빈 HOME을 사용한다.

새 workspace `OmO 운영 native` / pane `w22:p1`은 실제 사용자 모델 설정으로 등록했다.
선택 필드 `promptPreset`의 undefined 처리 누락을 원본 source에서 수정해 재패키징했다.
새 pane에서 PID 9560 → 14750, generation 1 → 2의 restart를 검증했고 대화 ID·저장 위치·cwd·옵션·환경을 보존했다.
`--offline`은 시작 시 다운로드·카탈로그 갱신을 제한하며 LLM 요청을 막지는 않는다.
유료 프롬프트는 실행하지 않았다. 등록 profile의 도구 목록은 `bash`로 제한되어 있으며,
기존 일반 세션의 자동 native 채택이나 모든 기본 새 세션의 자동 관리 등록까지 검증한 것은 아니다.

기본 updater는 새 설치와 native runtime을 반환하며 최신 검사는 `up-to-date / 5.1.19`다.
현재 버전에는 불필요한 update target을 발급하지 않는다. 미래 버전 업데이트에는 새 source-qualified
target 준비가 필요하다. 현재 후보는 5분 승인 유효기간을 갖고 있고, 종료 후 worker 재로딩에는 새 준비가 필요하다.
기존 completed job과 mutation 기록은 `worker.retired-*`에 보존했다. 새 worker의 Jobs 목록으로 이관하지는 않았다.
기존 다른 설치·runtime 설정은 runtime set에 보존했다. Cursor의 기존 최신 검사 실패도 그대로 남았다.

직접 확인은 `omo --version`, updater 메뉴에서 `omo 5.1.19` 행의 Latest 열,
`OmO 운영 native` workspace의 대화 입력창 순서로 한다.
문제가 생기면 `operating-native/evidence/operating-api.json`, `operating-restart.json`,
`applied.json`과 worker owner를 먼저 확인한다. native profile/receipt를 손으로 수정하지 않는다.
서버 롤백은 위 백업 바이너리로 동일 protocol/version live handoff 후 executable을 교체하는 절차다.
OmO 롤백은 보존된 이전 prefix로 두 launcher를 되돌리고 해당 설치에 맞는 updater 설정을 다시 준비한다.
롤백은 별도 운영 작업이며 이 기록 작성 중 실행하지 않았다.

증거: `~/.local/share/herdr-cli-updater/operating-native/evidence/`.
관련 제품 테스트 55개, typecheck, build가 통과했다. 원본 native source 테스트 54개와 build가 통과했다.

2026-10-06 실제 updater로 기본 `omo`를 OmO 5.1.19 / Senpi 2026.10.10으로 업데이트했다.
기본 launcher 두 개만 승인받아 연결했고, HOME·설정·대화 위치는 유지했다.
인증된 `create-job`의 `update-only`로 실행한 job
`job:1eacdc60ff62f5890b03aa5dc52b789663575cf7230b0f8615548dbb035f8cb4`의 최종 revision 3은
`completed`, 설치 `succeeded`, failure null이다. 원본 Bun exit 0과 durable
`files-verified` journal, 기본 명령의 버전 출력을 확인했다. 대화·herdr는 재시작하지 않았다.

초기 이벤트는 `receipt_uncertain`으로 보였지만 최종 상태는 성공이었다.
완료 뒤 공식 `bun-bin-shim.js`가 버전 실행 시 독립 prefix의 `bin/omo`를 재생성하면서
prepared expected-after hash와 달라져 당시 updater 목록이 `stale_selection`을 거부했다.
공식 generator·의존 모듈·qualified Bun을 source pin으로 인증하고 정확한 두 경로 표현의
생성 shim만 검증하도록 수정했다. drift 회귀 30개가 통과했다. 이전 운영 준비에는 새
module pin이 없으므로 새 준비를 만들어야 하며 hash를 임의 재승인하지 않았다.

다른 설치의 alias 해석 실패 전에 family hint를 기록하도록 `catalog-sources.ts`를 수정했다.
관련 회귀 59개, 타입 검사·빌드는 통과했다.

운영 herdr 0.9.3의 core socket은 읽기 전용 native 확인에서 `unqualified_core`를 반환한다.
동일 대화의 안전 종료·업데이트·재개는 운영에 연결되지 않았다.
기존 일반 세션을 뒤늦게 native 관리 세션으로 전환할 수 없다.

## 재시작 없이 확인할 항목

저장소에서 다음 명령은 버전·설치 관측만 확인한다. `doctor`는 세션을 시작하지 않는다.

```sh
/Users/beomseok/.bun/bin/omo --version
/Users/beomseok/.local/bin/herdr --version
bun scripts/plugin.ts doctor
```

기본 실행 경로는 다음 두 파일이다. 두 파일 모두 `BUN_INSTALL`을 독립 prefix로 지정한다.

- `/Users/beomseok/.bun/bin/omo`
- `/Users/beomseok/.bun/install/global/node_modules/.bin/omo`

독립 설치 경로는 `/Users/beomseok/.local/share/herdr-cli-updater/isolated-omo/prefix`다.
기존 공유 OmO 패키지는 삭제하지 않았으므로 목록에 OmO 설치가 둘 보일 수 있다.
`d`로 경로를 확인해 독립 설치를 구분한다.

업데이트 권한은 준비 후 5분 동안 유효하다. 만료되면 최신 조회는 유지되지만 업데이트 선택은
거절된다. `c` 조회로 권한이 연장되지는 않는다. 다시 준비하는 명령은 아래와 같다.
이 명령은 설치를 업데이트하지 않지만 검증용 복제·다운로드와 plugin worker 교체를 수행한다.
다시 실행하기 전에 작업이 없고 검증 복제를 위한 디스크 공간이 충분한지 확인한다.
마지막 측정 여유는 1.8 GiB이므로 지금 반복 실행하지 않는다.

```sh
HERDR_SOCKET=/Users/beomseok/.config/herdr/herdr.sock \
  bun scripts/plugin.ts prepare-omo \
  /Users/beomseok/.local/share/herdr-cli-updater/isolated-omo/prefix \
  /opt/homebrew/Cellar/bun/1.3.6/bin/bun
```

## Native 적용 순서

1. 현재 herdr 0.9.3을 기준으로 ABI4 restart 및 native launch를 지원하는 빌드를 검증한다.
   기존 검증 바이너리 `/Users/beomseok/Desktop/herdr-updater-toolchain/task20-core-r2-target/release/herdr`는
   현재 존재하지만 `--version` 결과가 0.9.1이다. 이를 운영 바이너리에 덮어쓰지 않는다.
2. 검증 빌드를 별도 환경·별도 core socket에서 검증한다. 운영 socket이나 작업 중인 pane를
   재사용하지 않는다. 실제 ping에서 `updater_restart_v1`, schema digest와 native launch 지원을
   확인해야 한다. 버전 출력 또는 과거 QA 통과만으로 현재 연결을 승인하지 않는다.
3. 선택한 OmO와 exact paired Senpi에 native overlay를 준비한다.
   `scripts/native-prepare/README.md`의 원본 archive·hook source·독립 결과 검증을 따른다.
   현재 기본 독립 설치에는 native overlay가 적용되지 않았다. 과거 QA candidate를 복사하지 않는다.
4. 아직 입력하지 않은 별도 shell pane에 core 소유 private launch profile로 관리 세션을 시작한다.
   `scripts/plugin.ts launch`에는 실제 pane ID와 core에 등록된 실제 profile ID만 사용한다.
   2026-10-06 사용자가 새 테스트 세션에서 같은 대화 재시작 검증을 승인했고 격리 환경에서 완료했다.
   기존 운영 세션의 종료·재시작·자동 채택은 이 승인이나 검증에 포함하지 않는다.
5. 새 native binding, 실제 현재/target 설치 관측과 자원 census로 private candidate를 생성한다.
   `scripts/plugin.ts prepare`가 실제 qualifier를 통과한 뒤에만 업데이트·재시작 선택을 허용한다.
6. 운영 바이너리 교체와 host 전환은 작업을 끝낸 후 별도 승인을 받아 수행한다.
   현재 실행 중인 세션의 유지·저장 대화 복구·실패 시 이전 host 복귀를 먼저 검증한다.
   현재까지 운영 host 교체나 기존 세션 재시작은 실행하지 않았다.

## 기본 launcher 복구

백업 디렉터리는 `/Users/beomseok/.local/share/herdr-cli-updater/launcher-backups/20261005-default-connection`이다.
복구 승인을 받은 경우 `bun-bin-omo`를 `/Users/beomseok/.bun/bin/omo`로,
`node-modules-bin-omo`를 `/Users/beomseok/.bun/install/global/node_modules/.bin/omo`로 복원한다.
두 launcher의 실행 권한은 `0755`를 유지한다. 자동 발견 registry에서도 두 launcher의 검증값만
복구 파일에 맞춰 이관하고, 다른 설치의 pin이나 alias는 변경하지 않는다.
복구 후 `omo --version`과 updater의 경로를 확인한다. 진행 중인 대화는 재시작하지 않는다.

## 검증 한계

최종 catalog launcher 회귀 58개와 TUI 회귀 25개, 타입 검사·빌드는 통과했다.
이전 전체 실행은 종료 코드 1로 끝났고 종료 원인은 확인되지 않았다.
최종 재실행은 60개 파일의 테스트 3,053개 통과·0개 실패, 타입 검사·빌드와 `FINAL_EXIT=0`을 확인했다.
전체 테스트 통과와 native 운영 연결은 별개다. 운영 core는 여전히 `unqualified_core`이므로
native 운영 적용 완료로 보고하지 않는다.
