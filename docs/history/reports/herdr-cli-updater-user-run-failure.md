# 사용자 실행 b34ceed0 후속 수정

## 확인한 실패

사용자 명령은 `ONE_FAMILY_PARENT_RELEASE=1 bun .omo/evidence/herdr-cli-updater/one-family/actual-qa/execution/run.mjs`다. 실패 b34ceed0는 정상 Claim·Stop 이후 실제 installer exit0였으나 독립 target 대비 `@aws-sdk/token-providers/@smithy/types` 물리 슬롯이 달랐다. 실패를 업데이트 성공으로 간주하지 않는다. 소유 root hq-krjlQx는 제거됐고 프로세스 목록과 resourcesRemaining은0이었다.

## 수정 진행

`--network-concurrency 1`로 요청 순서를 제한해도 실제 재실행이 실패했다. 이 실험은 제거했다.

`src/adapters/update-context.ts`는 이미 qualified된 artifact의 버전·physical installName·archive SHA512·manifest 의존성으로 Bun lock을 구성하고 `--frozen-lockfile`로 설치한다. 기존 파일 지문·nearest dependency·안전한 목적지·canonical lock 검증은 그대로다. 실행 직전 기존 lock은 기존 durable intent·dispatch 기록 이후에만 교체한다.

독립 QA는 실제 target 설치에서 관찰한 lock을 사용하되 그 플랫폼에 실제 설치된 슬롯만 유지한다. 별도의 초기5.1.9 설치에서 같은 frozen target으로 원본 Bun installer를 실행해 after 파일을 생성한다. 실제 제품 실행의 after 결과는 독립 정답 생성에 사용하지 않는다.

회귀182개/typecheck/build exit0, 변경 TypeScript LSP 오류0. 기존 lock 회귀는 이전 임의 URL 제거와 dispatch 이전 원본 보존을 계속 검증하며, 새 lock의 qualified 슬롯·version·archive SHA512·frozen 인자까지 검사하도록 갱신했다.

## 검증 과정과 최종 결과

슬롯 한정 실행은 Bun이 `--frozen-lockfile`과 `--trust` 동시 사용을 금지해 종료했다. 재해석 불변성을 위해 frozen을 유지하고 새 trust 등록 옵션만 제거했다. 기존 manifest/lock의 검증된 trustedDependencies는 유지한다.

Trust 조정 후 실제1a962b46 installer exit0/files-verified, after 파일 전체 지문 일치. 그 뒤 resource lease가 lock 지문 불일치를 거절했다. 제품의 archive-manifest lock과 independent Bun metadata lock의 peer/os/cpu 표현 및 slot 순서가 달랐다. 설치 배치 재해석 실패가 아니라 expectedAfter lock 발급 불일치다.

제품·독립 target은 각각 archive manifest 기준 metadata와 동일한 installName 정렬로 lock을 발급하도록 수정했다. 기존 자원 지문 검증은 완화하지 않았다. 실제0cc9db15는 package267 entries가 모두 일치했지만 제품 lockfileVersion1 vs original Bun2 차이 하나로 receipt가 거절됐다. 제품도 현재 manager의 lock version2로 작성하고 해당 machine value를 회귀에 추가했다.

실제19c46512는 동일 사용자 명령으로 PASS exit0. 원본 installer 업데이트 후 독립 after 파일28,599개와 canonical lock bytes가 전부 일치했다. 동일 full conversation/cwd/options/environment, generation1->2, duplicateEffects0, 실제 completed revision9 화면을 직접 확인했다. Owned cleanup joined/rootRemoved/resources0.

병렬 실제 설치 부하와 겹친 전체 회귀에 기존5초 real-worker/TUI timeout이 관찰됐다. 코드를 바꾸거나 timeout을 늘리지 않고 무부하 최종 실행 mon_NVC3CQPAC65KWZXZ/bash_295로 전체2,129개·typecheck·build exit0을 확인했다(102.89초).

설치 그래프는 frozen lock으로 고정했으며 기존 nearest dependency guard와 after resource fingerprint 모두 실제 통과했다. 별도 새 환경 동일 명령 재실행5d89b6df-86c4-42aa-8b97-32797b69dd26도 PASS exit0. 독립 파일28,151개 전부 일치, lock bytes 동일, full conversation/cwd/options/environment 동일, generation1->2, duplicateEffects0, 실제 completed revision9 화면을 직접 확인했다. root hq-ub3VgD removed/joined/resources0, harness failures0, 최종 ps에서 소유 QA 프로세스0.

두 별도 초기 target 해석의 파일 수는 다르다. 초기 target discovery 전체를 결정적이라고 주장하지 않는다. 이번 수정이 보장하는 것은 각 실행에서 qualified된 physical graph를 원본 Bun updater가 다시 해석하지 않고 frozen lock대로 설치한다는 범위다. 검증된 그래프와 실제 after graph·files·resource lock 모두 두 실행에서 일치했다. 외부 registry·다른 Bun 버전·다른 CLI 계열·운영 배포는 검증하지 않았다.

사용자는 저장소에서 원래 명령을 다시 실행할 수 있다. 결과의 status PASS/actualLifecycle true/duplicateEffects0/cleanup.resourcesRemaining0과 destination 아래 completed-job.png를 확인한다. 일반 start/tui 자동 catalog의 verification_failed 문제는 이 격리 QA 수정과 별도이며 해결했다고 주장하지 않는다. 운영 CLI 업데이트·재시작, Git staging/commit/push/PR/deploy는 하지 않았다.
