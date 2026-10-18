# 보관과 정리

2026-10-06 사용자가 보관 정책 적용과 기존 중복 정리를 승인했다.
실제 CLI 업데이트, 대화 재시작, herdr 재시작은 이 작업에 포함하지 않는다.

## 업데이트 준비

- `resolve`, `calibration-a/b`의 `prefix`, `cache`, `tmp`, `home`은 준비 명령이
  성공하거나 실패한 뒤 제거한다. 명령 로그와 sandbox 정책은 남긴다.
- 성공한 준비는 실행에 필요한 공식 archive, metadata, runtime 설정, qualification,
  출처와 전후 해시를 유지한다. 실패한 준비의 다운로드는 제거한다.
- 등록 성공 시 현재 runtime이 참조하는 준비와 설치별 직전 성공 준비의 다운로드만
  보관한다. 그 밖의 준비는 작은 진단 기록만 보관한다.
- `.preparing` 디렉터리로 준비 명령을 직렬화한다. 남아 있는 잠금은 실제 실행 여부를
  확인하기 전 제거하지 않는다. worker에 작업이 있으면 등록 후 정리를 실행하지 않는다.
- runtime 권한 만료는 별개다. 정리는 만료 시간을 갱신하거나 새 업데이트 권한을 만들지 않는다.

## QA 패키지

- `inputs`가 최신 input manifest를 만든 뒤 해당 manifest의 선택 설치와 전후 사본을 유지한다.
- 이전 `selected-original*`, `captured-before*`, `captured-after*`의 설치와 캐시는
  제거하지만 원본 실행 로그와 이전 completion 기록은 유지한다.
- 같은 계열의 패키지 준비 명령은 `.계열-preparing` 잠금으로 겹치지 않게 한다.
- 실패한 신규 취득은 resolver 설치·캐시와 archive만 제거하고 JSON과 로그를 남긴다.
- 보관 종료된 이전 기록은 당시 결과의 기록이지, 모든 경로가 남아 있는 재실행 입력이 아니다.
  보존해야 하는 회귀 사례는 이 일반 패키지 사본 경로와 분리해야 한다.

## 보호 대상과 확인

기본 `omo`의 `isolated-omo/prefix`, 현재 runtime이 참조하는 필수 파일,
worker 상태와 작업 DB, launcher 백업, `registry.json`, 최신 QA 사본은 보호한다.
별도 toolchain 빌드와 native host는 이 정책의 자동 삭제 대상이 아니다.

직접 확인:

```sh
bun test test/service/preparation-retention.test.ts scripts/family-update/retention.test.mjs
bun scripts/cleanup-retained.ts /Users/<user>/.local/share/herdr-cli-updater
omo --version
du -sh ~/.local/share/herdr-cli-updater/worker-preparations
```

`cleanup-retained.ts`는 기본적으로 계획만 출력한다. 사용자 승인 후 `--apply`로
현재 참조·작업 없음·열린 파일 없음·준비 잠금을 다시 확인하고 실제 정리를 수행한다.

문제가 생기면 `runtime.json`의 configuration 경로, 해당 준비의 `acquired`와
qualification pin, 실제 CLI launcher 순으로 확인한다. 보관 종료된 준비의 archive는
다시 다운로드해야 하며, 이전 설정을 되살려 업데이트 권한을 재사용하지 않는다.
자동 QA와 사용자 직접 검증은 별개이며, 사용자의 이해와 직접 확인은 아직 미확인이다.
