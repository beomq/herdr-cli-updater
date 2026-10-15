# CLI 세션 유지 업데이트

## 현재 상태

- **Codex 실제 버전 인계 통과(2026-10-12)**: `/private/tmp/codex-native-M65yTL/result.json`, exit 0. native 통합 빌드 0.156.0→0.156.1을 같은 설치 경로에서 원자적으로 교체한 동안 기존 PID 3381은 유지됐다. 이후 실제 설치 발견·profile 등록·인증 worker를 거쳐 PID 3899, generation 2로 재개했다. session ID `01a12f4d-37bf-7cf3-9ee1-da3cfd2a3832`는 동일하다. 실제 후속 모델 요청의 user-agent는 `codex-tui/0.156.1`이며 원래 사용자/assistant 메시지를 포함했다. launch/claim/stop/start/release 완료 영수증 5개, 관측 프로세스 3개 종료를 확인했다.
- 최종 검사: 제품 관련 테스트 11개, 타입 검사·빌드 통과. 자동 생성 provider 버전 헤더 수정 후 두 Codex 소스에서 인접 테스트 각 2개와 실제 CLI 빌드·버전 출력 통과. Rust LSP는 daemon timeout으로 결과를 얻지 못했지만 실제 컴파일은 성공했다. 다른 네 CLI의 추가 구현·전체 회귀는 실행하지 않았다.
- 이번 완료 경계: **격리 native 통합 빌드, 동일 실행 경로, 동일 명시적 모델 catalog·설정·환경, 실제 로컬 저장 대화**에서 버전 인계를 확인했다. 설치 교체는 하네스의 원자적 native 바이너리 교체이며 공식 npm 패키지 업데이트 runner를 통과한 증거는 아니다. stock Codex 지원이나 운영 설치 적용 완료가 아니며 운영 설치·사용자 세션은 변경하지 않았다. 구버전에도 정규화된 native bridge가 필요하다. 모델 마이그레이션/설정 변경은 여전히 종료 전 거절한다.
- 직접 확인: 두 native 바이너리가 준비된 환경에서 `CODEX_UPGRADED_BINARY=/Users/beomseok/Desktop/herdr-native-codex-0.156.1/.native-build/codex-native-stripped bun .omo/evidence/session-preserving-cli-updates/codex-channel-r1/upgrade-lifecycle.mjs`를 실행한다. 장애 시 새 바이너리 preflight 거절 사유 → 옵션 해시 → profile/provenance pin → core 영수증 순으로 확인한다. `--version`만으로 실행 중 버전 적용을 판정하지 말고 후속 모델 요청의 user-agent와 동일 대화 문맥을 함께 확인한다.
- 2026-10-12 최신 범위: 다른 네 CLI의 넓은 검사와 추가 구현을 보류하고 Codex의 `설치 업데이트 → 새 버전 적용 → 같은 대화 재개` 한 경로를 먼저 완료한다.
- Codex 인계 연결: `prepareCodexUpgradeProfile`은 기존 core binding/profile을 보존하면서 새 바이너리의 실제 preflight 옵션을 대조하고 별도 start profile을 만든다. 같은 실행 경로·대화·설정·환경 조건을 유지하며 core 종료/입력 보호는 수정하지 않는다. `scripts/prepare-native-restart.ts`의 선택적 `codexUpgrade`로 등록 준비에 연결했다.
- 현재 검증: supplier 거절/승인과 등록 11개 테스트 통과. 테스트 리터럴 타입 수정 후 typecheck/build exit 0. 실제 0.156.0→0.156.1 전환은 새 native 통합 바이너리 준비 후 한 번의 인증 worker 재시작과 이전 대화 문맥을 포함한 모델 요청으로 확인한다. 아직 실제 전환 통과 기록은 없다.
- 채널 구분: 기존 native 통합 Codex는 공식 npm 바이너리와 다르다. 공식 0.156.1 소스 변경을 기존 native 통합에 적용한 격리 빌드를 사용하며 native 바이너리 교체 검증을 npm 공식 배포 업데이트 성공으로 표현하지 않는다.
- 새 버전 출처: 공식 `rust-v0.156.1` commit `b412ff32c417f855c2b2d1581b77058eed87c84b`, base `fe74a774532af67b5a4a3dec03ce9469e17f89af`. 상세는 `/Users/beomseok/Desktop/herdr-native-codex-0.156.1/.native-build/provenance.json`. 소스 준비 자식 세션의 런타임 오류로 컴파일이 중단되어 부모 monitor `mon_DDHBT3X8X6ERXSMD`에서 같은 캐시로 재개했다. 아직 바이너리 완료 근거가 아니다.
- 재개 빌드는 exit 0, 실제 컴파일 4분 43초로 완료했다. `strip` 이후 `/Users/beomseok/Desktop/herdr-native-codex-0.156.1/.native-build/codex-native-stripped --version`은 `codex-cli 0.156.1`, exit 0이다. 실제 전환 검증은 `.omo/evidence/session-preserving-cli-updates/codex-channel-r1/upgrade-lifecycle.mjs`에서 별도로 수행한다.
- 첫 전환 `/private/tmp/codex-native-UPKG5z/result.json`은 설치 교체와 기존 프로세스 유지까지 확인한 뒤 새 버전 preflight에서 거절됐다. 0.156.1이 테스트 모델 `gpt-5.6-terra`에 모델 마이그레이션 결정을 요구했기 때문이다. 종료 전 거절과 프로세스 정리를 확인했으며 해당 보호를 완화하지 않는다. 두 버전 catalog에 모두 있고 upgrade가 없는 `gpt-6-astra`로 격리 시나리오를 변경했다.
- 두 번째 `/private/tmp/codex-native-dkiMXF/result.json`에서는 모델/생각/인자 해시는 같고 실효 설정 해시만 달랐다. 원본 `normalized_config_value`가 전체 `model_catalog`를 포함하므로 공식 0.156.1 catalog 변경도 설정 변경으로 간주된다. 격리 검증은 `model_catalog_json`으로 동일한 catalog 파일을 명시해 수행한다. 기본 catalog가 달라지거나 모델 변경 결정이 필요한 사용자의 세션을 자동 인계할 수 있다고 주장하지 않는다.
- 추가 원인 확정: 동일 catalog에서도 `/private/tmp/codex-native-J2mto6/result.json`이 실효 설정 차이로 거절됐다. 선택하지 않은 기본 OpenAI provider의 자동 `version` 헤더가 전체 provider 목록에 포함되어 버전 전환마다 달라진다(`model-provider-info/src/lib.rs:526`). 두 native 소스의 `provider_settings_value`는 provider 전체가 원본 생성값과 일치할 때만 그 헤더를 빌드 메타데이터로 제외한다. 다른 provider나 사용자 변경 헤더는 그대로 검증한다. 앞선 catalog 설명만으로 원인을 확정할 수는 없으며 이 결함도 해결해야 한다. 인접 회귀와 두 바이너리 재빌드가 진행 중이다.
- 요청일: 2026-10-11.
- 사용자 요청: Codex, OMP, Pi, Claude, OmO 순서로 세션 유지 업데이트 기능을 추가한다.
- 허용 범위: 제품 구현과 격리 검증. 이번 요청으로 실제 사용자 CLI 업데이트, 대화 종료, herdr 재시작을 실행하지 않는다.
- 현재 단계: 기존 계약 조사 완료, Codex부터 구현 중. 대상 세션 질문이 30분 무응답으로 종료되어 권장안인 기존 herdr 터미널 세션을 기준으로 진행한다.
- 2026-10-12 추가 요청 `다 해결해줘`: 누락된 실제 바인딩 공급과 CLI별 연결까지 구현 대상으로 계속 진행한다. 새 범용 증거 프레임워크나 보호 검사 완화 대신 기존 실제 설정·세션 로딩과 native 계약을 연결한다. 운영 설치·사용자 세션 조작은 여전히 실행하지 않는다.
- 대상: 기존 herdr 터미널 세션. 프로세스 자체를 계속 살리는 것이 아니라 업데이트 후 같은 대화를 재개하는 흐름이다.

## 코드에서 확인한 사실

- `src/app/engine.ts`: 설치 목록을 OmO로 제한한다. 현재 업데이트 요청은 `update-only`이며 선택한 native target을 보내지 않는다.
- `src/app/prepare.ts`: 준비 작업은 `prepareOmoInstallationRuntime`만 호출한다.
- `src/app/managed.ts`: 앱 소유 세션 시작은 OmO 전용이다. durable session ID와 세대, 소유 host를 확인한 뒤 재개한다.
- `src/app/controller.ts`: 승인 시 앱 소유 세션만 선택하며 외부 세션은 업데이트를 막는다.
- `src/adapters/codex.ts`: rollout 메타데이터의 thread ID, 작업 폴더, 실행 옵션을 대조하여 정확한 `resume` 명령을 만든다. 완료 bridge와 graceful exit는 명시적으로 미지원이다.
- OMP, Pi, Claude, OmO 어댑터에도 정확한 재개 명령과 완료 증거/claim 계약이 있다. 이 계약의 존재는 실제 native 종료·재시작 연결 성공을 의미하지 않는다.
- `src/core/client.ts`: `updater.restart.v1`의 capability, schema, binding, receipt를 검증하는 native client가 있다.
- `src/service/catalog-provider.ts`의 native 세션 관측과 일반 idle 표시는 전체 작업 완료나 종료 권한이 아니다.

## 다음 구현 단위

### 전역 업데이트 우선으로 순서 분리 (2026-10-11)

사용자가 전역 CLI 설치를 먼저 갱신하고, 기존 세션은 나중에 재시작하면서 새 버전을 적용하는 순서로 구현을 승인했다. 카탈로그 업데이트에서 제거용 `guardRemoval` 재사용을 없애고 설치·삭제·기본값 전환 및 기존 engine operation 충돌만 차단한다. 출처·대상 재확인과 실제 설치 버전 검증은 유지한다. 제거와 기존 native 세션 종료·재개 경로의 보호 조건은 변경하지 않는다.

이 계약은 updater가 기존 세션을 종료하거나 재시작하지 않는다는 뜻이다. npm/Bun의 기존 설치 경로 교체 이후 지연 모듈 로딩이나 자식 실행까지 구버전으로 고정하는 무중단 보장은 아니다. 세션 시작 버전(`launchedVersion`)을 디스크 설치 버전으로 덮어쓰지 않는다. 운영 설치·사용자 세션 변경 권한은 여전히 포함하지 않는다.

변경 전 새 컨트롤러 회귀는 실제 관리 자식 프로세스가 있을 때 수동 계획·승인, 자동 업데이트, 계획 후 시작한 세션의 승인 3개가 실패했고, 동시 engine operation 차단은 통과했다(1 pass, 3 fail, exit 1).

변경 후 컨트롤러·카탈로그 업데이트·제거·제거 가드·설치 실행부·화면 회귀 88개가 통과했다. 뒤이은 타입 검사에서 테스트의 nullable PID 캡처 1건이 실패해 지역 상수로 좁혔다. npm/Bun 격리 실행 회귀 2개를 추가한 최종 변경 파일 검사는 56개 통과, 0개 실패였으며 `bun run typecheck`와 `bun run build`도 exit 0이다. 변경되지 않은 나머지 관련 회귀 34개는 앞선 통과 결과를 유지한다.

실제 자식 프로세스를 사용하는 관리 세션 회귀는 PID·세대·대화 ID·시작 버전 유지와 stop/restart 미호출을 확인했다. 별도 외부 소비 프로세스도 살아 있는 동안 컨트롤러 업데이트를 허용했다. npm/Bun 실행 회귀는 임시 설치 경로와 통제된 패키지 관리자 자식 프로세스로 설치 버전 2.0.0을 검증하면서 이미 시작한 소비 프로세스가 1.0.0으로 응답하는 것을 확인했다. 이는 실제 공급자 CLI의 모든 지연 로딩 동작 검증이 아니다.

화면 안내는 격리 상태 하네스에서 1440px·390px, 라이트·다크 렌더링을 확인했다. 가로 넘침은 없었으며 운영 API는 호출하지 않았다. 직접 재검증: `bun test test/app/controller.test.ts test/app/catalog-update-target.test.ts`. 실패 시 카탈로그 이력의 대상·출처 변경 → 동시 operation → 설치 후 버전 확인 순서로 조사한다. 실제 세션 재개는 아래의 기존 CLI별 후속 작업이며 완료로 간주하지 않는다.

Codex부터 현재 재개 명령 생성을 재사용한다. 대상 세션 범위에 맞춰 실제 완료 증거와 입력 차단, 종료 확인, 업데이트, 동일 대화 재개를 연결한다. 지원 플래그만 켜거나 `/exit`·강제 종료로 기존 확인 절차를 대신하지 않는다.

정상 사례는 대화 ID·작업 폴더·실행 옵션 보존과 새 실행 버전 확인이다. 작업 중, 입력 대기, 소유권 변경, 응답 유실, 재개 실패 사례는 무조건 성공이나 자동 재실행으로 처리하지 않는다. 이후 OMP, Pi, Claude, OmO를 차례로 검증한다.

## 검증 및 미확인

- Codex 전용 `.native-build/cargo-home`에 잠긴 의존성을 복구하고, 과거 적용 성공 기록에서 crossterm 입력 제어 패치 14건을 복원했다. 공용 Cargo 캐시는 수정하지 않았다. 재현용 패치는 `.omo/evidence/session-preserving/codex/recovered-crossterm-patches.json`에 보존했다.
- 현재 소스의 `just test -p codex-core --lib --locked --offline -E "test(updater_native)"`는 21개 통과, exit 0이다. 이어서 `codex-tui`의 `test(updater_native) | test(terminal_probe)`는 26개 통과했다. `cargo +1.95.0 build --locked --offline -p codex-cli --bin codex`도 exit 0으로 완료했다. 이는 종료 신호 분류 수정 전 소스의 빌드이며, 실제 세션 재개 성공을 증명하지 않는다.
- 종료 결과 분류를 `UnifiedExecProcess::native_outcome`으로 옮겨 기존 watcher가 그대로 사용하도록 했다. 이벤트 기반 드라이버로 중단 시도 후 exit 0과 중단 없는 exit 0을 대조하는 회귀 2개를 추가했다. 수정 전 실행은 1개 통과, 1개 실패(exit 100)로 `Natural` 대신 `Cancelled`여야 하는 오분류를 재현했다. 이후 interrupt/terminate/terminate_confirmed 호출 전에 중단 의도를 기록하도록 수정했고 관련 회귀 검증 중이다. 신호 전달 실패도 자연 완료 증거로 승격하지 않는다.
- 중단 의도 분류 수정 후 핵심·프로세스 회귀 28개가 통과했다(exit 0). 이어 원격 terminate 비동기 작업에도 NativeWork를 유지하도록 보완했고 같은 관련 회귀가 다시 exit 0으로 완료했다. 원격 종료 성공·실패 양쪽의 취소 분류 assertion을 기존 테스트에 추가한 최종 집중 검사도 3개 통과, exit 0이다. MCP 비동기 작업 추적 누락은 별도 파일에서 보완 중이다.
- 공통 native client의 `bun test test/core/operations.test.ts`는 24개 통과, 0개 실패, exit 0이다. 실제 socket/WAL 및 응답 유실 계약을 검사하지만 제어된 peer를 사용하므로 실제 Codex 프로세스 재개 증거는 아니다.
- 복원 패치와 Rust 수정의 LSP 진단은 daemon timeout으로 완료하지 못했다. `just fmt`는 이 소스 아카이브에 `.git`이 없어 `git ls-files` 단계에서 exit 1로 실패했으며 포맷 완료로 기록하지 않는다. 위 컴파일·테스트 결과와 구분한다.
- 공통 native client의 OmO 전용 제한을 Codex로 확장했다. 기존 socket/WAL 테스트를 Codex npm 설치 형태에도 적용했으며 변경 전 Codex 세 경우가 `unsupported_family`로 실패하는 것을 확인했다. 변경 후 집중 검사 24개는 통과했지만 제품 진입 연결과 실제 프로세스의 동일 대화 재개 검증은 아직 남았다.
- 실제 사용자 세션 업데이트는 실행하지 않았다.
- 하위 어댑터 테스트의 존재는 조사했지만 이번 작업에서 재실행하지 않았다.
- 공식 CLI 문서와 실제 native producer의 현재 지원 상태는 구현 경로를 정한 뒤 확인한다.
- 사용자 직접 검증과 이해 완료는 확인하지 않았다.
- 운영 연결과 배포 준비는 격리 테스트 통과와 별도로 판단한다.

## 장애 확인 순서

### 실제 producer 연결 진행 (2026-10-12)

현재 세 가족 제품 합성 실제 근거: Codex `/private/tmp/codex-native-pKCwGm/result.json`, OMP `/private/tmp/omp-native-ZhXgOA/result.json`, Pi `/private/tmp/pi-native-fe8EvQ/result.json` 모두 launch + 네 차례 restart로 17개 완료 영수증, 세대 1→5, 각 실행 내 full session ID 1개, 관측 root/supervisor 6개 정리, exit 0이다. 직접 RPC 두 번 + 제품 lifecycle 포트 + fresh native 준비/runtime 합성을 차례로 통과했다. Pi는 실제 `--native-preflight`가 정상 로더 선택 기록을 쓸 수 있으므로 읽기 전용 운영 조회로 취급하지 않는다. OMP의 실제 저장 writer는 첫 title slot 뒤 session header를 쓰므로 product parser도 그 원본 형식을 검증하도록 수정했다. 실제 원본으로부터 확인한 세 가족에만 native runtime을 허용하고 interpreter와 entrypoint 모두 설치 resource에 묶는다. 포트 회귀 30개 통과, package operating 72개 통과(이전 동시 실행의 3개 실패는 Pi fixture의 wrapper 소유자였으며 package owner로 수정 후 포트 재검증). 제품 restart-only 진입 구현은 여전히 별도 진행 중이며 최종 지원 완료로 계산하지 않는다.

Codex 제품 합성 실제 검증 `/private/tmp/codex-native-8zxLg5/result.json`은 두 raw RPC, 제품 lifecycle 포트, `composeCodexRuntime`까지 네 차례 재시작과 launch 총 17개 완료 영수증이다. 실제 원본의 `history_mode=paginated`를 발견하여 제품 parser와 adapter를 `legacy|paginated` 및 필드 없는 legacy로 수정했고 미지 모드는 거절한다. adapter 회귀 60개 통과. 제품 package runtime 테스트 70개도 통과했다. 새 `prepareCodexRuntime`은 fresh core inspect로 binding/identity를 얻고 retained profile pin을 계산하며 `prepareNpmInstallationRuntime`의 선택적 native 입력으로 연결했다. 그 뒤 전역 typecheck는 동시 restart-only 구현의 미완료 타입들과 내가 추가한 private identity 접근 오류로 실패했다. 후자는 읽기 전용 복사 getter로 수정했으며 준비 hook 실제 실행 중이다. 타입 검사 완료로 계산하지 않는다.

OMP bounded 원본 CLI 실제 core 성공: `/private/tmp/omp-native-dW16hy/result.json`, launch + 두 차례 claim/stop/start/release, 같은 session, 세대 1→3, 모델 요청 0, 관측 root/supervisor 정리, 프로세스 exit 0. 이전 VWTTtR 실행은 lifecycle 성공 뒤 하네스 모델 서버 종료 누락으로 남았으므로 정리 수정 후 재검증했다. native 소스 측 291개 테스트와 `bun check` exit 0 보고를 받았다. 지원은 정확한 저장 세션·정적 모델·도구/확장 없는 plain chat뿐이며 full OMP 지원으로 확대하지 않는다. 제품 재시작 전용 operation은 별도 `st_01a12edc`에서 진행 중이고, Pi standalone producer와 Claude supplier 구현도 각각 독립 진행 중이다.

Pi standalone 실제 진입: `.omo/evidence/session-preserving-cli-updates/pi-channel-r1/` 하네스는 실제 `SessionManager`로 저장한 대화와 `createAgentSession`/`nativeEffectiveOptions`를 사용한다. `/private/tmp/pi-native-0G0jeP`는 실제 CLI bind에서 `original_owner_channels_not_installed`로 거절됐다. standalone Pi에는 subagent owner 등록이 없고 OmO의 `TaskManager.admission`에서만 등록되는 소스 구조를 확인했다. 이를 단순 owner 허위 등록·검사 완화로 우회하지 않는다. 현재 Pi 성공 증거는 없다. OMP는 options projection·Activate·종료 계약이 필요해 무수정 조사 이후 deep-high 구현으로 전환했다.

제품 Codex 포트 실제 통과: `/private/tmp/codex-native-bZTOho/result.json`에서 raw RPC 두 번 이후 제품 `createRestartLifecyclePort`를 통한 추가 claim/stop/start/release까지 13개 영수증 모두 Completed/native-qualified다. 같은 저장 대화 세대 1→4와 서로 다른 root PID, 모델 최초 1회만, 관측 프로세스 정리를 확인했다. package-runtime 합성 결과를 기다리며 Pi의 기존 실제 native bridge를 격리 core에 연결하는 하네스도 준비해 실행 중이다. Pi는 기존 제품 식별자 `@code-yeongyu/senpi` 기준이며 공식 다른 포크의 지원 증거로 확대하지 않는다.

제품 포트 QA 보완: `createRestartLifecyclePort`는 TargetSelection을 사전 subscribe한 뒤 claim하고, claim handle로 stop/start하며, release에 재개된 RuntimeBinding을 함께 전달한다. 직접 RPC 하네스에서 포트로 확장하며 이 계약을 잘못 호출한 오류를 수정했다. `/private/tmp/codex-native-X7fHA3`에서는 제품 포트를 통한 claim/stop/start까지 진행됐으나 검증 코드가 존재하지 않는 `processId` 필드를 비교해 실패했다. 실제 필드 `rootIncarnation.pid`와 `session`으로 고쳐 재실행 중이다. 하네스 실패를 제품 성공으로 계산하지 않는다.

실제 Codex/core lifecycle 성공: `/private/tmp/codex-native-XJwq5J/result.json`에서 최초 launch와 두 차례 claim/stop/start/release 총 9개 영수증이 모두 Completed/native-qualified였다. 세대 1→2→3, 같은 대화 `01a12eb4-6033-7861-8196-f4f4081b1544`, 서로 다른 root PID, 추가 모델 요청 없음(최초 1회)을 확인했다. core 종료 후 관측된 root/supervisor 4개가 모두 ESRCH였다. 이 근거는 격리된 실제 CLI lifecycle이며 운영 설치 갱신이나 제품 전체 완료 증거가 아니다. 제품 `createRestartLifecyclePort`를 통한 실제 재시작 검증을 추가했고, 첫 확장 실행은 하네스의 client 미정의로 실패해 변수 범위를 고쳐 다시 실행 중이다. package runtime의 Codex native target 합성은 별도 독립 구현 `st_01a12eb8`에서 진행 중이다.

동결 후 동일 경계 허용 수정은 기존 native 포함 25개 회귀 통과(exit 0), codex-cli 빌드 exit 0으로 확인했다. 원래 입력 ACK·동결 경계 변경 거절·종료 실제 효과 확인을 유지한다. 하네스는 최종 core 종료 후 관측했던 root/supervisor PID가 사라졌는지도 검사하도록 보완했다. 실제 재실행 준비 중이며 두 번 연속 restart 성공으로 계산하지 않는다.

실제 실행 `/private/tmp/codex-native-2hMpU6/result.json`에서 launch와 claim 영수증이 모두 Completed/native-qualified였다. core 시작 순환 수정의 실제 효과는 확인했으나 stop은 Uncertain이며 화면에서 `native input boundary is out of phase`가 확인됐다. NativeTui는 hello 이후 매 progress에서 경계를 보고하지만 native는 Frozen 이후 모든 경계 보고를 거절했다. Frozen부터 SessionClosed까지 이미 커밋된 동일 경계만 부작용 없이 허용하고 다른 sequence·decoder·draft 상태는 거절하도록 수정했다. 이 경계 검사와 기존 native 회귀 실행 중이며 실제 종료 성공은 아직 없다.

Core 수정 검증: native 회귀 14개, 입력 fence 회귀 15개 모두 통과(exit 0)했다. 같은 격리 target의 release 빌드도 exit 0이며 실제 Codex 두 번 연속 lifecycle 하네스를 실행 중이다. 초기 예약은 완료되지 않아도 attestation을 진행하지만 Frozen/ExitPrepared의 Natural 요구는 유지한다. 두 번째 시작은 Release 전 Held 상태를 유지하고 부모 예약에 연결된 후속 예약을 보존하는 회귀를 포함한다.

Core 순환 회귀는 수정 전 `InProgress != Completed`로 실제 실패(exit 100)했다. 이후 `complete_bootstrap_attestation`에서 pending owner의 완료 대기를 제거하되 Error/Cancelled와 모든 입력·증명 조건은 유지했다. 새 세대 Start에서 이전 원장을 비우고 Release는 새 원장을 유지하도록 변경했으며, 승인된 초기화 Start의 비-Root/stop-scope 없는 예약만 claimed 중 허용한다. 정상 두 세대·실패 결과 보존·미초기화/없는 operation/종료 중/복구/종료됨/Root/과거 stop-scope 거절 회귀를 추가했다. `just`가 설치되지 않아 실행 실패(exit 127), 동일 cargo nextest 명령으로 native 회귀를 실행 중이다. Rust LSP는 30초 daemon timeout이라 진단 완료로 기록하지 않는다. 실제 Codex 하네스는 두 번 연속 restart를 검사하도록 보완했고 core 빌드·실행은 아직 남았다.

후속 검증: 최초 접근성 설정 미초기화 시 digest를 내지 않고 config·저장 이력·DB를 변경하지 않는 executable 회귀를 보완하여 2개 통과(exit 0)했다. 독립 소스 검토는 bootstrap에서 예약한 work의 효과가 Activate 후 실행되는 계약을 확인했다. core의 bootstrap 작업 drain 요구가 이 계약과 충돌하며, gen2에서는 claimed 상태의 정상 startup 예약 거절 및 Release의 새 원장 삭제도 확인됐다. core의 입력 ACK·physical seal·attestation·실패 이력 검사는 유지하고 bootstrap 승인과 작업 drain을 분리하는 회귀를 추가해 RED 실행 중이다. 아직 실제 lifecycle 성공은 아니다.

Codex 활성화 순서 조사: argv 수정 후 executable preflight 2개 통과. `/private/tmp/codex-native-hxkbcy`와 최신 심볼 제거 실행 `/private/tmp/codex-native-4Evrmm`에서 이전 options mismatch 오류는 사라지고 실제 대화 UI가 유지되지만 core launch는 uncertain이다. 코드상 native `spawn_owned`는 먼저 Admitted를 보낸 뒤 `wait_admitted`에서 Active를 기다리고, startup auth prewarm도 이 경로를 쓴다. 반면 core `complete_bootstrap_attestation`은 모든 work가 자연 완료돼야 최초 Activate를 보낸다. 이 순환 의존은 소스로 확인했으나 아직 수정·실행 검증하지 않았다. 후속 시작 generation은 release까지 Activate하지 않는 계약도 있어 단순 guard 제거 없이 core/native 양쪽 계약을 검토 중이다. 독립 읽기 전용 검토 `st_01a12ea0` 진행 중이며 실제 완료 증거로 계산하지 않는다.

Codex argv 계약: 환경 출처·초기 접근성 조건 수정 후 core 회귀 4개와 executable preflight 2개는 통과했지만 `/private/tmp/codex-native-rVOxPm`의 live options는 여전히 달랐다. 집계 경로를 대조해 사전 조회만 argv[0]을 포함하고 실제 NativeConnection은 skip(1)하는 차이를 확인했다. 사전 조회를 같은 argv 범위로 수정하고 고정 resume 인자의 실제 SHA256 회귀를 추가했다. 새 executable 검사와 실제 lifecycle은 실행 중이며 성공 판정 전이다.

Codex 설정 비교 결과: 실제 Hello 직전 session/storage/cwd/environment/owner 6종은 일치하고 options만 달랐다. `/private/tmp/codex-native-Jkkafl`의 필드별 digest 비교로 실제 차이를 확인했다. (1) arg0가 매 실행 생성하는 execve wrapper 임시 symlink 경로는 dispatch 이름과 canonical executable 경로로 정규화했다. 동일 target의 다른 임시 디렉터리는 같고 target 교체는 다르다는 회귀 포함 3개 통과. (2) 실제 ThreadEnvironments::selections는 Thread 출처를 FromThread로 되돌리므로 사전 조회만 Ready로 확장하던 코드를 제거하고 local selection이 있는 supplier 회귀로 변경했다. (3) 최초 TUI는 screen_reader_detection_done을 저장해 설정 레이어를 바꾸므로 사전 조회에서 접근성 초기화가 필요한 세션을 명시적으로 거절한다. 정상 격리 fixture에는 이미 초기화된 상태를 설정했다. 앞선 model_providers 차이는 맵 직렬화 순서에 따른 진단상의 차이였고, 실제 canonical digest의 의미 차이는 아니었다. 임시 필드 해시 출력·파일 작성 코드는 제거했으며 새 회귀·실제 lifecycle 실행 결과를 기다린다. Rust LSP는 계속 daemon timeout으로 실행되지 못하여 cargo 컴파일로 확인 중이다.

Codex 실제 초기화 추가 진단: SHA256 crate만 dev opt-level 3으로 빌드한 뒤 초기 해시 검증 비용을 줄였다(같은 target, CARGO_INCREMENTAL=0, 디스크 여유 당시 50GiB). 원래 gpt-5.4 fixture는 모델 업그레이드 확인창에서 managed input 폐기 방지에 걸렸다. 호출 위치는 model_migration.rs:153으로 확인했으며 자동 동의하지 않았다. 정상 경로 fixture는 카탈로그상 upgrade가 없는 gpt-5.6-terra로 바꾸고, preflight에는 정상 TUI와 같은 migration 조건을 재사용해 선택이 필요한 세션을 사전 거절하는 검사를 추가했다(검증 진행 중). 초기 CONTROL은 재개 이벤트 처리 중 busy boundary를 실패로 단정하지 않고 원래 UI handler가 완료될 때까지 보류하며, 비어 있지 않은 상태를 승인하지 않는다. 이 수정으로 실제 저장 사용자/assistant 메시지와 모델·cwd가 화면에 복원됐고 다음 attestation 불일치 검사까지 진입했다. 아직 Hello 성공은 아니며 불일치는 비밀값을 출력하지 않는 필드별 일치 여부로 진단 중이다. 진단 코드의 잘못된 필드명 E0609는 storage_identity와 cwd로 수정했고 재검사 중이다.

OMP subagent 문맥: ToolSession→SDK→ExecutorOptions→실제 createAgentSession과 저장 subagent 복원에 같은 nativeWork를 전달한다. runStructuredSubagent의 준비·실행·병합·정리 전체를 subagent lease로 감쌌고, 실행 함수를 이벤트로 멈춘 회귀에서 parent gate 동일성·작업 수·freeze 거절·종료 후 drain을 검사했다. 관련 36개 회귀 통과 후 최종 수명 변경은 30개 회귀와 전체 bun check exit 0으로 확인했다. 추가 import 순서 오류는 수정했으며 기존 Bazel 링크 경고만 남았다. 상위 gate 없이 실행하는 기존 경로는 동작을 유지한다.

OMP 후속 처리 소유권: 실제 AgentSession의 agent event 전달을 delivery lease로, 예약된 post-prompt 작업을 첫 await 전부터 continuation lease로 감쌌다. session_stop hook을 이벤트로 정지시킨 회귀에서 수정 전 activeCount가 0으로 실패했고, 수정 후 hook 완료 전 freeze 거절을 확인했다. 관련 49개 회귀와 전체 bun check가 통과했으며 변경 소스·테스트 LSP 오류는 없다. 이어 예약된 agent.continue를 실제로 진입시켜 완료 전 freeze 거절을 확인하는 회귀를 추가했고 해당 파일 7개와 Biome이 통과했다. 기존 Bazel 링크 internalError/fs 경고 1개는 남았다. 이는 후속 처리 경계 보완이며 CLI gate 생성·입력 봉쇄·ABI endpoint·전체 재시작은 아직 별도 작업이다.

Codex executable 저장 대화 검사는 2개 통과했다. 이어 증분 캐시를 사용자 승인으로 정리하고 CARGO_INCREMENTAL=0으로 같은 target에 재빌드하여 exit 0, incremental 0B를 확인했다. 격리 core-lifecycle.mjs는 실제 Codex exec로 localhost 모델 응답을 받아 저장 대화를 만들고 실제 preflight 네 digest로 core launch profile을 작성한다. 첫 실행은 core의 15초 bootstrap 제한 이후 native physical seal deadline으로 실패했다. 실제 저장·사전 조회는 성공했지만 Hello·claim·stop·restart 완료 증거는 없다. 디버그 실행 파일의 초기 해시 비용이 원인일 가능성을 검사하기 위해 원본을 보존한 심볼 제거 실행 파일(364MiB)을 준비했으며 core 보호 deadline은 변경하지 않았다. 두 번째 실행은 실제 TUI까지 진입했으나 `native resume has no recorded session cwd`로 실패했다. 확인된 코드 원인은 명시 -C가 resume mode를 Current로 만들어 저장 cwd 조회를 생략하는데, native 검증은 저장 cwd를 필수로 요구한 것이다. 초기 진입과 앱 내 resume 두 경로에서 native일 때 조회를 유지하도록 수정했다. 검증기의 Bun fs.watch가 receipt 변경을 놓친 문제는 제품의 CoreOperationsClient Node observer를 재사용하도록 교체했다. 이 두 수정 후 빌드·재실행 결과는 아직 별도 확인 대상이다.

Codex executable 사전 조회 진입을 연결했다. HERDR_UPDATER_PREFLIGHT가 설정된 exact resume는 lifecycle FD 상속을 거절하고, TUI의 실제 resume 요청 생성기 → 읽기 전용 SQLite/rollout 조회 → 정상 ConfigManager → 공통 실효 설정 resolver 순서로 네 digest만 출력한다. source/originator는 저장 대화에서 복원하며, 모델 조회는 사전 조회에서 offline 전략을 쓴다. 정상 실행은 기존 새로고침 정책을 유지하므로 카탈로그가 달라지면 live digest 검증에서 거절될 수 있다. 현재 지원 경계는 local/disabled 실행 환경이며 remote/Noise 환경과 OSS 초기화는 연결 없이 명시적으로 거절한다. 기존 저장 cwd/workspace 복원도 정상 resume와 같은 함수로 추출했다.

최종 Config·저장 설정·workspace·native 공급 관련 42개 회귀, TUI/환경 경계 8개 회귀가 통과했고 codex-cli 실제 바이너리 build가 exit 0으로 끝났다. 실행 파일을 직접 부르는 격리 저장 대화 통합 테스트는 별도로 진행 중이며, 이 시점에는 core 소유 seal을 거친 Hello/Frozen/종료/재시작 완료 증거가 없다. 초기 신규 호출의 private module 접근·중복 import와 경로 타입 오류는 컴파일 결과를 따라 수정했다.

Codex LocalThreadStore::read_model_context_from_path는 선택된 rollout 경로에서 정상 resume와 같은 metadata 검증·paginated lineage·최신 model context scanner를 사용한다. SQLite 초기화나 decoded copy 게시 없이 읽으며, 정상 로더와 구조 일치·rollout 바이트 보존·다른 UUID 거절을 검사했다. 기존 nested/archived lineage 포함 19개 회귀가 통과했다(nextest exit 0). 최초 테스트의 RolloutItem PartialEq 미구현 컴파일 오류는 JSON 구조 비교로 수정했다. 공급 API의 Unix 전용 구현/공개 조건도 맞췄다. executable preflight 연결은 아직 남아 있다.

Codex 공급 API 인계 후 부모가 실제 --no-daemon 경로를 확인했다. 이 버전은 core 직접 실행이 아니라 InProcessAppServerClient → ThreadProcessor를 통해 resume하며, 저장 SQLite의 model/reasoning과 rollout의 권한 설정 복원이 최종 Config에 반영된다. 준비된 Config만 사용하는 supplier 테스트는 이 복원 경계를 검증하지 않는다. 공통 resolver와 기존 native 회귀 23개는 부모가 nextest로 실행하여 모두 통과했다. CLI 사전 조회 진입·실제 저장 이력 공급·모델 스냅샷 일치는 아직 미연결이다.

Codex StateRuntime::read_thread_metadata를 추가했다. 기존 get_thread SQL과 row 변환을 공유하되 open_read_only_pool로만 열고 성공·쿼리 오류 모두 pool을 닫는다. 정상 reader 일치, 없는 DB 무생성, 호환되지 않는 DB 무마이그레이션/바이트 보존 3개 격리 회귀가 통과했다. 처음 테스트는 해당 crate에 없는 tempfile 의존성으로 컴파일 실패하여 기존 unique_temp_dir 헬퍼로 수정했다. Rust LSP는 daemon timeout이며 실제 컴파일·실행으로 검증했다. 이 조회 API 자체는 아직 executable preflight에 연결되지 않았다.

OMP 확장 타이머 연결: SDK가 같은 gate를 ExtensionRunner/ManagedTimers에 전달한다. 타이머 예약은 monitor lease, 실제 콜백 실행은 별도 자식 lease로 추적한다. clear/clearAll은 예약만 해제하고 실행 중 Promise의 소유권은 완료까지 유지한다. claim 이후 새 예약을 거절하고 진행 중 예약의 인과적 콜백은 보존한다. 반복 예약이 남으면 drain 완료를 주장하지 않는다. 새 이벤트 기반 타이머 회귀 포함 43개, 기존 ExtensionRunner 64개 통과, 전체 bun check exit 0(기존 Bazel 경고 1개). raw timer를 직접 쓰는 확장과 전체 continuation/subagent 경계는 이 API 밖이므로 native 전체 인증은 여전히 미완료다.

OMP 초기 도구 경로 보완: SessionTools 생성 시 agent에 이미 설치된 도구도 같은 native 래퍼로 감싼다. 초기 세트와 동적 재적용 두 경로를 각각 실행하여 40개 회귀 및 전체 bun check가 통과했다. 일반(native gate 없음) 도구 동작은 기존 경로를 유지한다.

OMP 도구 실행 연결: SessionToolsHost에 같은 gate를 전달하고 공통 도구 래퍼가 ACP 승인부터 실제 execute Promise 완료까지 tool lease를 유지한다. 동적 활성화·xdev 실행도 기존 공통 래퍼 경로를 사용한다. 실제 AgentSession 도구 fixture에서 실행 중 freeze 거절, claim 이후 새 execute 거절, 실제 결과 완료 후 drain/freeze 성공을 검증했다. 관련 39 pass, LSP 오류 없음, 전체 bun check exit 0(기존 Bazel 링크 경고 1개). 초기 도구 세트·직접 호출 등 공통 래퍼 바깥 경로, monitor/continuation/subagent 소유권, 입력 경계는 별도 확인이 필요하며 전체 native 지원은 아직 미완료다.

OMP 비동기 실제 연결: AgentSession이 nativeWork와 실제 agentId를 갖는 경우 공유 AsyncJobManager에 해당 owner의 gate를 등록하고 세션 close 후 해제한다. manager는 job 실행·전달에 같은 owner gate를 사용하며 중복 owner 등록은 거절한다. 실제 AgentSession fixture에서 claim 후 thunk 미실행, 다른 상태를 바꾸지 않는 거절, dispose 후 등록 해제를 검증했다. 관련 38 pass, 변경 파일 LSP 오류 없음, 전체 bun check exit 0(기존 Bazel 경고 1개). 모든 도구·후속 작업과 입력의 native 봉쇄 및 endpoint는 여전히 미연결이다.

OMP 후속 연결: CreateAgentSessionOptions → AgentSessionConfig → 실제 AgentSession.prompt에 선택적 nativeWork를 전달했다. gate가 있는 세션은 prompt 진입 전 root lease를 확보하고 실제 Promise 완료까지 유지한다. claim 이후 새 prompt는 메시지 추가 전에 거절한다. 기존 실제 AgentSession fixture를 포함한 회귀 37개 통과, 변경 네 파일 Biome 및 전체 bun check exit 0. 기존 Bazel 링크 경고 1개는 남아 있으며 Rust는 변경 없음으로 저장소 스크립트가 생략했다. 아직 실행 진입에서 gate를 생성하지 않고 tool/monitor 등 나머지 owner와 입력 봉쇄·ABI4 endpoint가 연결되지 않았으므로 전체 native qualification으로 간주하지 않는다.

Codex canonical options는 원래 설정 전체를 문자열로 담았고 provider token/header와 CLI override가 포함될 수 있었다. 사전 공급자를 만들기 전에 네 값 각각의 canonical JSON을 SHA256으로 바꾸고 키를 argv_sha256/effective_settings_sha256/model_sha256/thinking_sha256으로 명시했다. live attestation도 같은 함수를 사용한다. 원문 노출 없이 설정 변경과 배열 순서 변경은 계속 감지한다. 기존 private profile은 새 옵션·빌드 해시로 다시 생성해야 하며 과거 profile을 그대로 사용할 수 없다. Core는 options map을 불투명하게 해시하므로 별도 wire 필드는 추가하지 않았다. native canonical options 3개 회귀가 통과했다(nextest exit 0). Rust LSP는 daemon timeout이었으며 컴파일과 실행 회귀로 확인했다. 실제 CLI 재빌드와 공급자 연결은 진행 중이다.

OMP에는 session/updater-work.ts와 AsyncJobManager의 선택적 nativeWorkForOwner 연결을 구현했다. 일곱 작업 종류, claim 이후 외부 admission 차단과 진행 중 작업의 자식 허용, 취소 후 실제 Promise 완료 대기, 전달 의무 추적, 원자적 lease 이전, generation/zero 조건 freeze를 제공한다. 인접 회귀 30개와 Biome/LSP/diff 검사 및 bun check exit 0이다. 부모가 lease finish/transfer/drain/freeze와 실행·전달 연결을 검토했다. 실제 세션 생성에서의 gate 주입, 모든 root/tool/monitor/continuation 진입점, decoder/composer 입력 봉쇄, ABI4 endpoint와 동일 대화 재시작은 아직 연결되지 않았다. 이 단위를 OMP 전체 지원으로 표시하지 않는다.

### Codex 대형 실행 파일 검증 수정 (2026-10-12)

추가 계약 회귀: native resume에 필요한 `--no-daemon`은 기존 private options digest와 다르면 identity_mismatch로 거절하고, 현재 digest와 일치할 때만 명세에 보존한다. 실행 없는 adjacent regression을 추가했다. 최종 Codex 57 pass, 타입 검사 exit 0이며, 버전 deadline 변경 후 빌드도 exit 0이다. 실제 대화 재개 증거로 승격하지 않는다.

후속 원인 확정: 새 복사본의 첫 기본 probe는 약 2015ms에서 timeout이었다. Codex 어댑터에 공통 probe가 이미 허용하는 5000ms 제한을 명시했다. 예열 없는 새 복사본의 어댑터 재검증은 버전 0.156.0과 재개 명세를 확인하고 exit 0, 버전 조회와 전후 해시 검사 합계 약 4213ms였다. Codex 회귀 56개와 타입 검사도 exit 0이다. 가짜 타이밍 테스트나 자동 재시도는 추가하지 않았다. 아래 초기 실패 기록은 이 변경 이전의 관찰이다.

설치 탐색은 스트리밍 해시를 사용하지만 Codex 어댑터의 재개 전 검사는 64MiB 전체 읽기 제한으로 정상 대형 바이너리까지 거절했다. 기존 격리 빌드는 641,583,160바이트다. `src/adapters/codex.ts`의 실행 리소스·관리자 해시를 64KiB 버퍼 기반 전체 파일 해시로 변경했다. 읽기 전후 inode·크기·모드·mtime/ctime 및 경로 동일성도 확인하며, 세션 JSONL의 기존 크기 제한은 유지한다. 새 로더나 native 완료 증거 경로는 추가하지 않았다.

정상 64MiB 초과 파일과 마지막 바이트 변조 회귀는 수정 전 모두 verification_failed로 실패했다(0 pass, 2 fail). 수정 후 정상 파일은 재개 명세를 반환하고 변조 파일은 external_writer로 거절한다. `bun test test/adapters/codex.test.ts test/discovery.test.ts` 99 pass, 0 fail, 255 assertions. 타입 검사와 빌드 exit 0, 변경 파일 진단 오류 없음.

실제 빌드의 격리 복사본 검사 `.omo/evidence/session-preserving-cli-updates/codex-channel-r1/verify-large-resource.ts`는 전체 리소스 검증과 재개 명세 생성을 통과했으나 adapter.version에서 verification_failed로 종료했다(exit 1). 같은 복사본의 후속 5초 제한 probe는 codex-cli 0.156.0을 반환했다. 기본 2초 probe의 시작 시간 초과 가능성은 추론이며 원인이 확정된 것은 아니다. 실패 검사를 제거하거나 제품 deadline을 늘리지 않았다. 이 실행의 세션 메타데이터는 fixture이며 실제 대화 로드·재시작 검증이 아니다. 원본 바이너리·사용자 세션은 변경하지 않았고 임시 복사본은 정리했다.

OMP 읽기 전용 조사에서는 정확한 파일 기반 SessionManager.open과 ctx.shutdown 경로를 확인했다. 그러나 제품 catalog-provider.ts의 OMP readRuntime은 null이며 readCoreEvidence 연결도 없다. Pi도 runtime/core가 null이다. 기존 종료 API만으로 전체 작업 완료·입력 차단 증거를 대체하지 않는다. Codex의 실제 설정 공급 및 OMP/Pi/Claude native 연결은 계속 미완료다.

직접 회귀 확인: `bun test test/adapters/codex.test.ts --test-name-pattern "large Codex"`. 장애 시 리소스 출처·해시 → 버전 probe → 실제 native 바인딩 순서로 확인한다. 이번 수정은 첫 단계의 크기 제한을 해결한 것이며 사용자 직접 검증·전체 CLI 지원 완료는 의미하지 않는다.

### 전역 갱신 후 독립 재시작 계약 확인 (2026-10-12)

컨트롤러의 개별 restart 분기만 보고 설치 중 재시작 경합을 의심했으나, 새 회귀가 변경 전부터 통과했다. 공통 명령 진입의 기존 update_in_progress 검사가 이미 차단하므로 제품 수정은 하지 않았다. 추가 회귀는 실제 관리 자식과 이벤트로 정지한 설치 실행을 사용해 갱신 중 재시작 거절·PID/세대 보존, 갱신 완료 후 같은 durableSessionId 재시작과 세대 증가를 확인한다. 이는 실제 공급자 CLI가 아니라 기존 관리 RPC fixture에 대한 통합 검사다.

`bun test test/app/controller.test.ts` 38 pass, 0 fail, 147 assertions. `bun run typecheck`도 exit 0이며 변경 파일 LSP 오류 없음. OMP 소스 packages 범위에서 native updater producer가 없음을 확인했고, 제품 package-runtime은 update-only로 제한되어 있다. 가족 허용 목록만 늘리거나 임의 완료 신호를 붙이는 변경은 하지 않았다. Codex의 실제 바인딩 공급, OMP/Pi/Claude의 실제 producer 연결은 여전히 미완료다.

### Codex 실제 재개 연결 검증 재개 (2026-10-11)

전역 업데이트 선행 변경 이후 Codex 작업을 재개했다. 부모가 MCP 변경의 요청 전 NativeWork 예약·활성화, 성공/취소/오류 구분, 취소 작업의 causal scope와 retained join, reconnect 상태 전달까지의 소유권을 코드에서 확인했다. 현재 회귀는 결과 분류와 backpressure 후 전달을 확인하지만 실제 observer의 admission 거부·causal parent·join 보존까지 직접 검증한 것은 아니다.

수정된 native 소스는 `cargo +1.95.0 build --locked --offline -p codex-cli --bin codex`로 다시 빌드해 exit 0을 확인했다. 기존 private Cargo cache와 target-bridge-r1만 사용했다. 제품의 `bun test test/adapters/codex.test.ts test/core/operations.test.ts`는 78 pass, 0 fail, 334 assertions, exit 0이다. 이 결과는 실제 공급자 CLI의 동일 대화 재개 완료 증거가 아니라 명령 생성·바인딩·통제된 코어 연결 회귀다.

현재 단계는 빌드된 실제 Codex를 기존 격리 native QA 경로에 연결하는 것이다. 실제 프로세스 결과 또는 구체적 연결 결함이 확보되기 전에는 Codex 전체를 완료로 표시하지 않는다. 운영 설치·사용자 세션·자격증명은 사용하지 않는다.

실제 Codex 격리 실행에서 기존 ABI1 실행기의 초기화 프레임이 ABI4 요구사항과 맞지 않아 세션 로드 전에 거절됐다. 실행기 `node .omo/evidence/session-preserving-cli-updates/codex-channel-r1/probe-existing-runner.mjs`는 예상 거절 검사 exit 0, Codex는 exit 1, stderr는 `Error: invalid native command frame`, native Hello는 0건이다. 결과는 같은 디렉터리 `result-r2.json`에 있다. FD3 socket 연결은 통과했지만 Freeze·PrepareExit·재개는 실행하지 않았다.

현재 Codex native 진입은 정확한 저장 UUID의 `resume`만 허용하며, Initialize에 physical_bootstrap_epoch와 실제 설정·저장 경로·환경 해시가 필요하다. `core/src/session/updater_native.rs:2600`의 실제 session configuration 해시는 임의 fixture 해시로 대체할 수 없다. 기존 QA만 고쳐서는 제품용 초기 바인딩 공급 경로가 확보되지 않는다. 과거 새 snapshot/loader/kernel proof infrastructure 금지 범위와 충돌할 수 있으므로 최소 실제 바인딩 공급 경로의 범위 결정을 사용자에게 질문했다. 보호 검사는 우회하지 않았다.

독립 진행한 OMP·Pi·Claude 기존 어댑터 회귀는 311 pass, 0 fail, 977 assertions, exit 0이다. 이는 fixture 기반 계약 검증이다. 공통 core client의 실제 lifecycle 허용은 현재 OmO·Codex뿐이고 제품 `plugin-runtime.ts`의 구체 실행 연결은 OmO 중심이다. 해당 family 허용 목록만 늘리는 것으로 실제 CLI 지원 완료를 주장하지 않는다.

범위 질문은 사용자 답변 없이 만료됐다. 최선 판단으로 기존 제한을 유지하고 새 snapshot/loader/kernel 증거 수집 경로 대신 기존 실행기만 ABI4에 맞추는 작업을 진행했다. 버전·physical_bootstrap_epoch·해시형 launch_nonce·실제 격리 환경 해시를 반영했다. 첫 ABI4 실행은 해시형 nonce 누락으로 초기화 거절, 수정 후 실행은 10초 제한에 SIGKILL됐으며 Hello는 없었다. 바이너리가 641,583,160바이트의 unoptimized 빌드이고 시작 시 자기 해시를 계산하는 것을 확인해 QA 외부 제한만 120초로 늘렸다. 제품의 검사·deadline·바인딩 비교는 변경하지 않았다. 실행 성공과 동일 대화 재개는 계속 미확인이다.

후속 격리 실행에서 `native bootstrap environment mismatch`를 관찰했다. 명시 환경과 ps의 초기 환경은 같았으나 macOS CoreFoundation용 `__CF_USER_TEXT_ENCODING`을 명시하자 환경 검증을 통과했다. 이어 `--no-daemon` 요구와 stdin TTY 요구를 확인하고 적용했다. macOS script를 파이프에서 실행한 시도는 tcgetattr 오류로 실패했고, 모니터의 실제 PTY를 직접 상속하도록 변경했다. 그 결과 Codex가 native 393바이트를 전송하고 `native physical seal deadline`으로 종료했다(`abi4-result-r8.json`).

현재 실행기는 ABI4 프레임을 파싱해 실제 BootstrapReady를 확인하고, 코어가 독립 관찰한 seal이 없으면 Hello가 발생하지 않고 종료되는 부정 검사를 수행한다. 임의 expected 옵션·저장 바인딩은 qualification에 쓰지 않으며 seal을 되돌려 보내 우회하지 않는다. `updater_native.rs`의 실제 코어 physical actor·CONTROL 증거와 실제 저장 세션 설정 공급이 연결되기 전에는 같은 대화 재개가 미완료다.

최종 부정 검사 완료: `abi4-bootstrap-negative.json`에서 실제 Codex의 ABI4 BootstrapReady 1건, physical_bytes 0, native 전송 393바이트, Hello 0건을 확인했다. Codex는 `native physical seal deadline`으로 exit 1, 실행기는 이 거부 동작과 정확한 nonce·epoch·순서를 검증해 exit 0이다. 외부 강제 종료가 아니라 native 자체 deadline 종료다. 이 결과는 초기 채널과 seal 누락 시 차단을 검증한 것이며 세션 로드·Freeze·PrepareExit·설치 갱신·동일 UUID 재개는 실행하지 않았다. 실행기 LSP 오류 없음. 다음 실제 구현 지점은 기존 core launch profile에 실제 Codex 설정·저장 세션 바인딩을 공급하는 연결이며, 기존 제약 아래 해당 공급 경로를 새로 만들지는 않았다.

기존 경로 재사용의 최종 확인: core `src/server/updater_launch.rs:34`는 `options: BTreeMap<String, String>`을 받고, Codex `core/src/session/updater_native.rs:2067`도 argv/effective_settings/model/thinking을 동일 자료형으로 정규화한다. 자료형 충돌이 아니라 실제 설정값을 profile 작성자에게 제공하는 경로가 없는 문제다. 실제 Codex는 `:982`에서 로드한 전체 바인딩과 사전 예상값을 동일 비교하므로 placeholder를 허용하거나 자기 응답을 기대값으로 채택하는 수정은 하지 않는다. 질문 만료 뒤 판단은 기존 수집 경로 신설 금지 유지로 확정했다. 따라서 초기 ABI4 연결 부정 검증만 완료이고, 같은 대화 재개는 공급 경로 제약으로 미완료다.

실패 시 설치/실행 경로 일치 → native capability → 전체 session binding → 완료/입력 차단 증거 → 종료 receipt → 설치 검증 → 재개 ID와 실행 버전 순서로 확인한다. 결과가 불확실하면 먼저 기록을 조회하며 종료나 업데이트를 자동 반복하지 않는다.
