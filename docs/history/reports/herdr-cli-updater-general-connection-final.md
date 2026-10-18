# 일반 OmO 실제 연결 구현 결과

## 요청과 적용 범위

일반 supported stable OmO 설치가 검증한 target을 선택해 현재 작업 자연 완료 → 정상 종료 →
원래 패키지 매니저 업데이트 → 동일 대화/cwd/options/environment 재개를 herdr plugin에서 수행한다.
기존 P/C/native를 재사용했고 고정5.1.9→5.1.10 제품 제약을 제거했다. 모든 CLI 계열 확장,
새 proof/loader/kernel, 운영 CLI나 herdr/session 변경, credentials, staging/commit/push/PR/deploy는 수행하지 않았다.
기존 paused 계획과 shared 변경·실패 증거는 보존했다.

## 실제 정상 흐름

P: `/Users/<user>/Desktop/herdr-cli-updater`.
C: `/Users/<user>/Desktop/herdr-updater-core`.

실행 폴더: `/Users/<user>/Desktop/herdr-cli-updater/.omo/evidence/herdr-cli-updater/one-family/actual-qa/execution/runs/fa7b839e-2fbf-4775-a3ec-2e115f8a56db`.

- 원본 genuine OmO5.1.9→5.1.17, paired Senpi2026.10.1-3→2026.10.8. 실제 public archives와 source 빌드, 원래 isolated Bun install 사용.
- plugin `launch`/`prepare`/herdr action/overlay/실제 worker job을 통해 수행, QA가 native lifecycle을 대체하지 않음.
- busy native work의 natural claim 완료 뒤 Stop, 원래 Bun update, 독립 installed file 검증, Start/Release 완료.
- `result.json` PASS/actualLifecycle true/duplicateEffects0. final global manifest 및 installed graph의 최신 버전 부모 확인.
- WAL의 초기/최종 전체 session 객체 동일(id/storage/cwd/options/env), root pid11833→12408.
- isolation-cleanup rootRemoved true/actionState joined/processes[]/resourcesRemaining0.
- 실제 waiting-for-work 및 completed-job-small screenshot 부모 직접 확인. 일반/작은 viewport에서 세션·작업 대기·정상 종료·재개 완료 표기 확인.

## 구현과 이유

- `src/adapters/update-context.ts`: stable exact installed version과 실제 qualification target 사용. 기존 provenance/원본 manager/vendor archive/resource/postinstall guards 유지.
- `src/service/plugin-runtime.ts`: `omo-qualified-native-abi4` 지원. private candidate와 실제 inspect/qualifier를 연결. config/qualification/설치/provenance/응답만 검증하는 readFence로 catalog3.5초 예산 유지, mutation은 archive·overlay 전체 검증 유지.
- `scripts/plugin.ts`, `src/core/client.ts`: native capability/schema discovery, pristine shell private profile launch, 실제 WAL 완료 뒤 성공 출력. stock 거절.
- core `src/app/api/plugins/runtime.rs`, `panes.rs`: core 소유 native coordinates 전달·override 방지.
- `scripts/native-prepare/omo.mjs`, `latest-hook-resolution.mjs`: exact wrapper/paired engine 원본 source와 기존 hook를 병합. 최신 upstream stopSettlement/abort-skip 동작 및 native cancellation 보존. exact revision/bytes 밖은 거절.
- overlay source pin은 실제 packed stage copies. emitter 후속 QA가 바꿔도 input은 변하지 않음. 재패키징 exclusive attempts/previous receipts 보존.
- harness beforeArtifacts와 targetArtifacts 분리. 바뀌는 기존 dependency manifest의 before digest와 독립 target digest 결속. after native profile은 독립 target closure/bridge pin 사용.

## 검사와 설명된 기존 문제

- 최종 `bun test && bun run typecheck && bun run build`: `mon_HJCK6FCYYKE414FR`, exit0, 2333 tests/47 files. 마지막 runtime source/test LSP 오류 없음.
- core75 related nextest pass, release build exit0 (기존 이번 연결 실행 결과). 운영 binary 교체 없음.
- latest source bridge54/managed input18 pass, source-only tsgo 및 reviewed8file Biome exit0. native-prepare100 tests pass, 원본 설치/build/staging/pack6 commands exit0.
- 기존 native root 타입 오류3건 및 서식 오류12건은 baseline에서 재현하고 별도 기록. source-only/new reviewed files 검사 성공과 혼동하지 않음.
- 실패한 latest 시도 보존. source pin drift와 before/after harness 오류를 고쳤으며 guard를 완화하지 않음.

## 운영 적용과 직접 확인

운영 적용은 하지 않았다. stock herdr0.9.3는 native updater 미지원이므로 plugin 등록만으로 실제 update/restart가 생기지 않는다.
검증 native binary: `/Users/<user>/Desktop/herdr-updater-toolchain/task20-core-r2-target/release/herdr`.

별도 native 지원 환경에 실제 설치별 candidate/profile이 준비돼야 한다.
`USAGE.md`와 `scripts/native-prepare/README.md`에 private 입력 계약·준비·재사용 명령을 기록했다.

```sh
cd /Users/<user>/Desktop/herdr-cli-updater
# native 지원 herdr 별도 환경에서 등록·열기
herdr plugin link /Users/<user>/Desktop/herdr-cli-updater
herdr plugin action invoke updater --plugin beomq.cli-updater
# 실제 core private profile이 준비된 pristine shell pane
bun scripts/plugin.ts launch <pane-id> <private-profile-id>
# 실제 설치별 private candidate, worker 없는 상태에서
bun scripts/plugin.ts prepare /absolute/private-candidate.json
```

장애 확인 순서: `doctor`의 native capability → runtime 설정/원본 pin → 실제 saved conversation과 profile →
설치 ownership/census → job/public failure와 native operations WAL. unknown outside consumer·대화 누락·잘못된 target은 update를 허용하지 않는다.
사용자 본인의 이해·직접 운영 확인을 완료했다고 대신 선언하지 않는다. 준비 자료는 재사용 증거로 남기고 live 자원은 정리한다.

## 완료 감사

요청 계약/host 범위는 조사 evidence와 source 구현·tests, 일반 profile은 stable version 회귀와 실제5.1.17 flow,
자연 완료/정상 종료/원래 update/동일 재개는 실제 WAL·final installation·전체 session 비교,
UI는 실제 screenshots, code gate는 위 실행 결과, operating 비적용은 별도 binary/격리 root 사용으로 결속한다.
필수 최신 failure 결과 및 마지막 todo 완료는 아래에 이어 기록한다.

### 최신 실패 시나리오 최종 결과

모두 기존 actual execution/runs 아래 결과·cleanup을 부모가 직접 읽었다.

| 시나리오 | run | 실제 결과 |
| --- | --- | --- |
| 잘못된 대상 | 84b9569c-381c-47a0-8f39-c6faf6c6dd7a | PASS, unsafeEffects0 |
| 정상 종료 실패 | 43f5ccaf-6861-4496-9194-c0a7ed86542e | PASS, unsafeEffects0 |
| 대화 누락 | 54db1199-f8aa-412e-8f65-ac183129ae13 | PASS, installerEffects0/unsafeStarts0 |
| update 실패 | 65eb43c5-399f-427d-ae00-9ade0ec1a6e7 | PASS, unsafeStarts0 |
| resume 실패 | aafa55f1-f8a8-4b91-b46e-15cc8b52e024 | PASS, unsafeStarts0 |

5개 모두 rootRemoved true/actionState joined/processes[]/resourcesRemaining0.
update/resume 동시 첫 실행은 screenshot/selection 관측과 teardown deadline이 부하에서 실패하여
그대로 실패 기록을 보존했고, 단독 실행에서 전부 통과했다. 고정 sleep/poll로 테스트를 바꾸지 않았고
기존 event/receipt/키 입력 구독을 사용했다. 전체 bun test는 단일 실행으로2333개 통과했다.

최종 완료 감사: 모든 요청 deliverable은 위 source/실제 실행/검사/문서로 확인됐다.
최신 버전 이후 미검토 source conflict는 exact-byte guard가 차단하므로 임의 미래 버전 지원을 주장하지 않는다.
일반 stable runtime 계약과 실제 검증된5.1.17 source preparation을 제공한다. 사용자 현재 stock 운영 세션은 그대로다.
소유 live child/build/QA 프로세스와 브라우저/worker/core는 모두 종료·정리됐으며, 이전 계획과 증거는 보존한다.
