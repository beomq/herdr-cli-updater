# OmO 한 계열 실제 업데이트·재시작 검증

## 결과

2026-10-04, 별도 HOME·설치 prefix·작업 디렉터리·core socket에서 실제 OmO CLI를 실행했다. 제어형 테스트 프로세스를 실제 CLI로 간주하지 않았다. 실제 원본 설치와 로컬 native bridge overlay가 포함된 대상 패키지를 사용했으며, 운영 CLI나 현재 대화를 업데이트·재시작하지 않았다.

최종 성공 실행: `c8e8f4ee-31f8-408c-9205-c3b6e5d9a399`, monitor `mon_NRHDPYCY9CKRHE0X`, exit 0. 실제 `!bash` FIFO 작업을 자연 완료시킨 뒤 native Claim·Stop, 원본 installer로 5.1.9에서 5.1.10으로 업데이트, exact Start·Release를 수행했다. installTxn succeeded, target completed, job completed revision 9, duplicateEffects 0을 확인했다. 수동 `u` refresh 후 실제 TUI에 `persisted: completed | result: completed`, `targets: 1/1 verified`가 표시된 PNG를 부모가 직접 확인했다.

이전·이후의 full conversation ID, storage identity, cwd, options SHA-256, environment SHA-256이 모두 일치했다. root PID와 pane generation만 새 실행으로 바뀌었다. 같은 create-job requestId를 다시 전송해 existing job을 받았고, 추가 설치·재시작 없이 binding이 그대로였다.

성공 증거 경로: `/Users/<user>/Desktop/herdr-cli-updater/.omo/evidence/herdr-cli-updater/one-family/actual-qa/execution/runs/c8e8f4ee-31f8-408c-9205-c3b6e5d9a399/`. `job.json`, `native-before-after.json`, `operations.jsonl`, `installer-*.jsonl`, `transition-input-refusal.json`, `actual-bash-proof.json`, `completed-job.png`, `harness-cleanup.json`, `isolation-cleanup.json`에서 확인할 수 있다. before PID 27522, after PID 28751, generation 1→2이며 session identity는 동일하다. 독립 after 파일 28,375개가 모두 일치했다. 성공·실패 소유 root는 제거했고, 부모의 최종 프로세스 조회에서도 `/private/tmp/hq-` QA 프로세스 0건이었다.

이전 성공 b9abffd5의 completed-job 캡처는 수동 refresh 전 queued 화면이어서 완료 UI 근거에서 제외했다. 추가 QA에서 독립 target을 target 위에 재설치한 반면 실제 updater는 before 5.1.9 위에 설치해 nearest dependency layout이 달라졌다. 독립 target도 같은 before-version layout에서 생성하도록 수정했다. 실제 시나리오의 after 결과를 정답으로 복사하거나 product guard를 완화하지 않았다. 진단용 임시 제품 코드는 제거했고 `src/adapters/update-context.ts` Git diff가 비어 있음을 확인했다.

## 실패 사례

모두 실제 격리 CLI·core에서 실행했고, 잘못된 새 대화나 root를 시작하지 않았다. 각각 exit 0, owned root 제거, resourcesRemaining 0을 확인했다.

| 사례 | 실행 ID | 판정 |
| --- | --- | --- |
| 잘못된 target root binding | `d5a7aac7-4c36-4bba-ab36-c0afe2a2f5f3` | native Claim 거절, unsafeEffects 0 |
| 정상 종료하지 않는 정지된 root | `3b7738ff-ea0c-4967-add3-fbdc94d896ad` | 완료 영수증·설치·Start 승인 없음 |
| 저장된 대화 파일 누락 | `34aecace-6a35-49b6-97c2-307e16cc2186` | update dispatch 및 fallback Start 없음 |
| 실제 installer manager 누락 | `3a294a93-1082-4e3e-960d-788b0c667c75` | recovery_required, unsafeStarts 0 |
| exact resume profile의 대화 ID 변조 | `30ef439e-159b-4703-94db-a818c2abed75` | 다른 대화 Start 없음 |

Node 경로 제거는 installer 실패 조건이 아니었다. 해당 과거 실행을 update 실패 통과로 집계하지 않았고 실제 qualified manager를 제거하는 시나리오로 교체했다.

## 선택 이유와 실제 수정

- `src/service/job-runner.ts`와 `src/install/resources.ts`: stage operation ID의 `op:`를 `op-`로 변경했다. 실제 core는 영문·숫자·하이픈·밑줄만 허용한다. 동일 job/target/stage의 digest와 중복 방지 성질은 유지한다.
- `src/core/client.ts`: pinned Bun에서 계속 열린 WAL descriptor의 write 알림이 누락되는 것을 실제 실행에서 확인했다. 기존 Node 파일 관찰 방법을 lifecycle에 연결했다. helper READY 후 mutation을 한 번 dispatch하고, WAL은 알림으로만 사용하며 authenticated Result가 완료 권한을 결정한다. helper는 close 시 kill·join한다. 입력 Node runtime은 소유 조립 경로에서 공급한다.
- controlled fixture의 lock after-image를 기존 issuer가 실제 쓰는 lock seed와 맞췄다. catalog unavailable 테스트는 자동 HOME/PATH 대신 빈 candidates·sockets를 명시했다. assertion·timeout을 약화하지 않았다.
- QA는 실제 claimed 이벤트, intent 진행 상태와 terminal recovery의 구분, 설치 직후 임시 partial 이후 Start·Release를 기다리도록 수정했다.
- `src/service/worker.ts`: genuine payload qualification이 실제로 7,281ms 걸려 기존 5,000ms readiness 한도를 넘었다. authenticated readiness와 실패 정리를 유지하면서 30,000ms로 조정했다. worker 19개 회귀와 타입·빌드를 통과했다.

## 검증·한계·직접 확인

부모 직접 최종 검증: `bun test` 2,129 pass, 0 fail, 41개 파일, 110.19초. 이어서 `bun run typecheck`, `bun run build` 모두 exit 0. 변경 제품 파일 LSP 오류 없음. 새 held-descriptor 회귀는 watcher를 먼저 준비한 뒤 append하고 authenticated Result를 기다리며 고정 sleep·polling을 사용하지 않는다.

이 결과는 한 계열과 격리 설치의 증거다. all-eight parity나 게시 패키지·운영 배포 검증은 아니다. 커밋·스테이징·푸시·PR·배포는 수행하지 않았다. native source tree의 기존 root formatting 12건과 test TypeScript 3건은 남겨 두었으며 해당 로그는 최종 실행의 `native-existing-check-failures.json`에 연결돼 있다. 변경 범위 native/core 회귀와 original build는 통과했다.

최종 화면 상단의 `installations: stale_selection`은 QA private reader가 업데이트 전 설치 지문만 발급하도록 제한되어 업데이트 후 catalog 재조회가 거절된 결과다. persisted job revision 9의 완료와 1/1 exact restart는 별도로 검증됐다. 일반 설치 catalog의 업데이트 후 재발급·다른 CLI 계열·운영 준비는 이번 한 계열 검증으로 통과했다고 주장하지 않는다.

장애 확인 순서는 persisted job revision/transaction state → native operation receipt → installer durable journal → before/after session identity → cleanup 기록이다. `recovery_required`만 보고 mutation을 다시 보내지 않는다. 직접 확인은 위 증거 JSON을 비교하거나 명시적으로 요청한 별도 격리 실행으로 한다. 운영 세션에서 재현하지 않는다. 사용자 본인의 이해·직접 검증·운영 준비는 QA 통과와 별도이며 확인했다고 대신 선언하지 않는다.
