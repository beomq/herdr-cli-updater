# 앱 밖에서 설치됐을 때 복구와 세션 재시작 (2026-10-13)

## 문제

사용자가 `bun add -g omo-ai`로 OmO 5.1.32를 직접 설치하자(10:01) 두 가지가 끊겼다.

1. worker는 관리 중인 설치 파일을 해시로 pin해 두고(`run/worker.catalog/auto-sources.json`), 파일이 바뀌면 `stale_source`로 보고 관리 목록에서 뺀다. 설계 주석대로 "pins are a first observation, not an automatic rebaseline"이다. 그래서 대시보드 "업데이트 관리 대상"이 0개가 됐고 자동 업데이트 정책이 할 일이 없어졌다.
2. "대기 중 세션만 다시 시작" 정책은 업데이터가 수행한 업데이트 작업 직후에만 돌았다. 앱 밖 설치는 작업 기록이 없어 세션 재시작이 호출되지 않았고, 대기 중 세션 9개가 구버전으로 남았다.

## 구현

### A. pin 기준 자동 초기화 (`src/app/catalog-rebaseline.ts`, 컨트롤러 `rebaselineCatalogs`)

worker가 스스로 pin을 바꾸게 하지 않는다. 그 대신 앱이 아래 조건을 모두 확인한 뒤 pin 파일을 `auto-sources.json.stale-<시각>`으로 보관한다. worker는 파일이 없으면 첫 관측으로 다시 pin하므로, 이는 "서비스를 처음 켠 것"과 같은 신뢰 수준이다.

- 그 카탈로그의 자동 업데이트가 켜져 있고(`mode: update`) 바인딩이 있다.
- 앱 인벤토리(`discoverCatalogInstallations`: 패키지 매니저, package.json, bin 링크를 독립 검증)가 바인딩과 같은 manager·root·실행 파일·패키지의 설치를 `ready`로 본다.
- worker 관리 목록에 그 family가 없다.
- 그 설치의 버전이 지난 확인 때 기록한 버전보다 낮지 않다.
- 1시간 안에 초기화한 적이 없다.
- `owned`(앱이 직접 설치)·`brew` 바인딩은 대상이 아니다.

실행 시점: `refresh()`(서비스 시작·새로고침)와 정책 틱 시작 직후.

### B. 앱 밖 설치를 재시작 트리거로 (컨트롤러 `tick` 카탈로그 분기)

정책에 `lastInstalledVersion`을 기록한다. 틱에서 디스크 버전이 그 값과 다르면 업데이터가 설치하지 않았어도 `requestId: external:…`인 완료 작업을 기록하고, 기존 `restartCatalogPaneSessions`를 그대로 태운다. 업데이터가 직접 설치한 틱에서는 결과 버전을 바로 기록해 다음 틱이 오인하지 않는다. 기록 화면에는 "이 앱 밖에서 설치됨 · 세션 정책만 적용"으로 표시한다.

## 실제 결과

- 서비스 재시작 직후 A가 깨진 pin을 `auto-sources.json.stale-20261013T013610`으로 보관했고, worker가 새로 pin해 OmO 5.1.32가 관리 대상으로 돌아왔다(`lastRebaselineAt` 10:36:10).
- 자동 업데이트를 껐다 켜서 틱을 돌리니 `lastInstalledVersion=5.1.32`가 기록됐고 잘못된 external 기록은 없었다.
- 한계: 이미 구버전으로 떠 있던 세션 9개는 기준이 방금 기록됐으므로 이번에는 자동 재시작되지 않는다. 카드 버튼으로 재시작하거나, 다음 앱 밖 설치 때부터 B가 돈다.

## 검증

- `test/app/catalog-rebaseline.test.ts`: 버전 비교, 바인딩 파싱, 조건별 판정.
- `test/app/controller.test.ts`: 앱 밖 설치 뒤 틱이 external 기록을 남기고 대기 세션을 재개하며 다음 틱에 반복하지 않는다. worker가 뺀 바인딩 설치는 pin이 보관·초기화되고 1시간 안에는 반복하지 않는다.
- app+web 회귀 430개 통과, 타입 검사·빌드 exit 0.

## 장애 시 확인 순서

1. 대시보드 "업데이트 관리 대상"이 0이면 `run/worker.catalog/`에 `.stale-*`가 새로 생겼는지 본다. 없으면 A 조건 중 어느 것이 빠졌는지 정책(`catalogBinding`, `mode`)과 설치 화면의 그 설치 행(manager·경로·버전)을 대조한다.
2. 자동 재시작이 안 되면 자동 업데이트 화면의 `lastInstalledVersion`과 디스크 버전을 비교한다. 같으면 "바깥 설치"가 아니라고 본 것이다.
3. 1시간 안에 두 번 깨지면 두 번째는 의도적으로 복구하지 않는다(무한 회전 방지).
