# 일반 OmO 실제 연결 진행

## 승인 범위

2026-10-04 사용자: 실제 연결 구현 승인. 플러그인과 herdr native 연결 구현 및 격리 QA. 운영 CLI 업데이트, 사용자 대화/herdr 재시작, credential, Git staging/commit/push/PR/deploy 금지 유지.

## 제품 변경

- `src/adapters/update-context.ts`: 이전 버전5.1.9 고정 제거; 실제 stable exactVersion 설치 identity 사용. vendor/source/resource/postinstall/manager/provenance guard 유지.
- `src/service/plugin-runtime.ts`: `omo-qualified-native-abi4` profile, target version은 qualification에서 검증 후 읽음. legacy profile 호환. `preparePluginRuntime`은 private candidate의 exact q observation receipt 생성과 actual native inspect를 거쳐 configure. worker path는 존재하면 거절하며 prepare가 시작 소유권을 선점하지 않음.
- `src/core/client.ts`: 실제 ping으로 native capability/schema identity 발견. stock host 거절.
- `scripts/plugin.ts`: `launch <pane> <profile>`은 core-owned profile/WAL 메타데이터와 prearmed observer로 actual launch 완료를 확인. `prepare <candidate>`는 runtime receipt/config 생성. 임의 CLI command나 executable path 입력을 받지 않음.
- core `src/app/api/plugins/runtime.rs`, `panes.rs`: `HERDR_UPDATER_CONNECTION_JSON` ABI4/native launch/WAL/profile path 주입. pane 요청으로 덮을 수 없음. 기존 native lifecycle reuse, 모든 공유 변경 보존.

## 현재 검증

부모: 전체 제품2253 pass0fail, typecheck/build exit0. core75개 nextest pass, core release build exit0. just 미설치로 기존 isolated Rust toolchain cargo nextest 사용.
실제 제품 `launch → prepare → action` whole flow: `/Users/<user>/Desktop/herdr-cli-updater/.omo/evidence/herdr-cli-updater/one-family/actual-qa/execution/runs/2b84079a-0219-49df-83ee-88ae897c564d` PASS exit0. genuine current native packages5.1.9→5.1.10. Busy 자연 완료, transition input refusal, graceful stop, original Bun install, native resume, release, duplicate effects0. before/final session 전체 object(full id/storage/cwd/options/env) 동일, root PID73125→73700. cleanup rootRemoved/action joined/resourcesRemaining0. 정상·작은 화면 직접 확인.

## 미완료

일반 최신5.1.17↔Senpi2026.10.8 원본 소스와 native overlay의 원본 설치·빌드·staging·완전성 확인 6개 명령이 완료됨. 부모가 로그 pin과 exit0을 확인함. 준비 경로: `/private/tmp/herdr-native-prepare-latest-ready-1791136780232/preparation.json`. 실제 적용 source의 native bridge 54개 테스트를 부모가 독립 실행해 exit0으로 확인함. 최신 원본 의존성241개와 original Bun 슬롯266개, edge491개 획득 완료, 획득 격리 설치는 제거되어 resourcesRemaining0. 아직 최신 whole flow PASS 없음. 기존 pinned whole flow를 일반 최신 성공으로 바꿔 보고하지 않음.
실제 missingconversation/resume/update/wrongtarget/gracefulexit 실패 시나리오는 새 제품 entry로 완료됨.

최종 실패 관측: missingconversation `edfd20cf-a30e-4ed5-bfdb-7a6e722f3178` PASS/installEffects0/unsafeStarts0, resume `93f84cc4-8499-4bfe-90e9-8f454f2bf14d` PASS/unsafeStarts0, update `207f60fd-f022-4c65-aee9-9413f95e04af` PASS/unsafeStarts0. 세 result.json/isolation-cleanup.json 부모 직접 읽음. 모두 rootRemoved/actionState joined/resourcesRemaining0. 일반 target recipe/version을 기존 actual harness에서 읽도록 교체 중이며, native build gate나 verification guard를 생략하지 않음.

추가 실패 관측: wrongtarget `5b2297ca-24de-4d05-94c3-8e2f1a2e2eda`, gracefulexit `e9e6d4b8-4ba8-4952-bd2c-4558ee7a49eb` 모두 PASS/unsafeEffects0. 부모가 두 result와 cleanup을 읽었고 모두 rootRemoved/actionState joined/resourcesRemaining0.

최신5.1.17 vendor archive의 self-update.js/package-paths.js/update-args.js hash를 Bun.Archive로 읽어 기존 official installer source pin과 비교: 셋 모두 동일. 원래 installer source contract를 임의 dynamic source 허용으로 약화하지 않아도 최신 source 출발 identity 검증은 유지할 수 있음. source 실행 없이 hash 관측만 수행.

## 실행 실패 교정

초기 managed QA는 install.bun 없는 필드 참조를 실제 복사 manager path로 교정. 다음 실패는 prepare가 empty worker dir를 요구하는 반면 startWorker는 existing path를 live worker로 인식하는 계약 충돌: 제품 prepare가 parent private만 검증하고 worker path absent를 요구하도록 교정. timeout run들도 resourcesRemaining0. 오래된 manual check/refresh QA 기대는 automatic check 결과로 변경. 검증 실패를 성공으로 취급하지 않음.

최신 actual QA 초기 실행은 before5.1.9 패키지에 target5.1.17 overlay만 전달해 native bridge가 없었음. 기존 검증된 before overlay를 원본 packaging handoff에서 재검증해 추가하도록 harness 교정. 다음 실행은 실제 native launch까지 진행했지만 runtime captured guard에서 거절됨. 원인: packaging 이후 원본 unbundled build 검사가 dist/client/index.js와 index.d.ts를 바꿔 overlay source pin 2개가 stale. digest guard를 유지하며 원본 build/staging/pack 재실행 중. 두 격리 실행 모두 오류 결과의 resourcesRemaining0, 첫 root 제거 확인, 두 번째 core exit0/joined 및 harness cleanup failures[] 확인. latest 전체 성공으로 보고하지 않음.

부모 추가 확인: 최신 source-only tsgo와 reviewed8file Biome exit0. 기존 native baseline에서 같은12개 서식 오류 재현, 7개 실패 파일 byte 동일, 나머지 index/run-eval-cell의 native block 서식 실패 유지. root tsgo3개는 기존 native test signature 오류로 source build와 분리. managed input Node runner18 pass. Vitest로 Node test 파일을 실행한 부모 첫 시도는 runner 부적합으로 실패했으며 원본 Node runner로 바로잡음.

재패키징 attempt1 완료, overlay source pin은 실제 packed staging copy로 결속되어 emitters 재빌드에 영향받지 않음. 전체 native-prepare100 pass/typecheck exit0. 최신 실행의 추가 거절 원인은 before와 target overlay 혼합 및 기존 dependency version 변경의 resource snapshot 누락. beforeArtifacts를 targetArtifacts와 분리함. 실제 qualifier의 verifyDestinations는 기존 버전 변경 시 해당 manifest의 before fingerprint를 요구함을 격리 메모리 진단으로 확인한 뒤 진단 코드는 제거. harness는 실제 before manifest 및 독립 target manifest digest를 기존 installation resources에 추가하고 다시 실행 중. 제품 guard/권한/원본 파일을 완화하지 않음.

최종 제품 전체 bun test/typecheck/build 부모 실행 `mon_XHF799CCQGM25KHR`/`bash_47` exit0. 최신 actual는 qualification, native launch, plugin action/worker 시작까지 통과했고 catalog의 Checking 대기에서 timeout. 오류 cleanup resourcesRemaining0/core joined. 최신 worker installations/check 구조화 결과를 화면 대기 전 기록하도록 harness 진단을 추가해 다음 실제 조회 원인을 확인 중. 최신 whole flow 성공은 아직 미확인.

latest-precheck 실제 installations 응답은 resources_busy,8.4초로 checker3.5초 예산 초과. 원인: 카탈로그 조회가 target archive150MB+overlay 파일4122개 full fence를 여러 번 반복. 조회는 config/qualification/설치 관측/provenance/원본 acquired response pin만 검증하고 mutation은 전체 sourcePins/아카이브/파일 재검증 유지하도록 제품 readFence 분리. archive 변조는 catalog를 막지 않지만 실제 mutation profile.observe가 거절하는 회귀 추가. 첫 회귀는 checker admission의 남은 full fence를 잡았고 해당 read path도 교정. actual 최신 실행은 원래 Bun update와 독립 파일 검증 succeeded까지 통과했으나 Start 전 원래 before profile을 after에도 복사한 QA bug로 receipt_uncertain. 독립 targetPackagePins로 after closure/bridge를 생성하도록 교정 후 실제 재개 재검증 중.

최종: latest genuine5.1.9→5.1.17 전체 제품 flow PASS `fa7b839e-2fbf-4775-a3ec-2e115f8a56db`. 동일 전체 session true/pid11833→12408/duplicateEffects0. 최신5개 실패 모두 PASS/unsafe effects0, rootRemoved/joined/resourcesRemaining0. 최종 전체2333 tests/47 files·typecheck·build exit0 `mon_HJCK6FCYYKE414FR`. 실제 screenshots 직접 확인. 최종 보고서 `herdr-cli-updater-general-connection-final.md`. 운영 적용·커밋·푸시·PR·배포 없음.
