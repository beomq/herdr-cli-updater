# 글로벌 우선 업데이트와 세션 버전 적용 (2026-10-12)

## 요구와 결론

사용자의 목표: 설치를 먼저 업데이트하고, 멈춰 있는 세션은 종료 후 같은 대화로 재개, 작업 중인 세션은 끝난 뒤 재실행.

이번에 코드에 반영된 것은 **글로벌 우선 업데이트**와 **관리 대상 발견 복구**이다. 세션 자동 재개는 배포본 CLI에 native 브리지가 없어 아직 불가능하며, 아래 "한계"에 정확히 적었다.

## 변경

### 글로벌 우선 (`src/app/controller.ts`)
- 승인(`confirm`)과 자동 정책(`tick`)에서 외부 세션 존재 시 `external_session`으로 거부하던 두 지점을 제거했다. 대신 승인 시점의 외부 세션 ID를 작업에 `externalSessionIds`로 기록한다(`validation.ts`, `types.ts`).
- 외부 세션은 종료하지 않는다. 설치 교체 중 열린 파일 보호는 update runner의 lsof census(`omo-update-runtime.ts`)가 그대로 담당한다.
- UI: 승인 대화상자에 "외부 세션 N개는 이전 버전으로 계속 실행, 직접 재시작 필요" 경고; 작업 기록에 외부 세션 수 표시; 세션 카드에 "이 세션 시작 후 설치가 업데이트됨" 경고(`web/app.tsx`). 판정은 세션 시작 시각 vs 검증된 설치 완료 시각 비교다.
- 회귀: `test/app/controller.test.ts` "global-first" 테스트 — 외부 세션이 있어도 업데이트가 진행되고 stop 0회.

### 관리 대상 발견 복구 (`src/service/catalog-sources.ts`)
- 원인 1: nvm/npm-global의 옛 OmO(5.0 베타)는 엔진 `package.json`이 `bin.pi = dist/bundle/cli.js`를 선언하지만 실제로는 `dist/cli.js`만 있다. 이를 `identity_mismatch`로 거절하면서 **스캔 전체가 incomplete가 되어 ~/.bun OmO까지 숨겨졌다.** 선언 경로가 없고 실제 진입점이 `dist/cli.js`인 경우만 "미분류(unclassified)"로 두고 거절하지 않는다. 다른 불일치는 그대로 거절한다. 회귀 추가(74 pass).
- 원인 2: 웹 서비스 worker의 `auto-sources.json`이 세대 0(미완료)인 채로 omo-ai 5.1.29 시절 해시를 pin하고 있었다. 설계상 "실패한 스캔은 재학습 권한이 아니다"라 영원히 `verification_failed`였다. 서비스 정지 후 파일을 `auto-sources.json.stale-20261012-*`로 보존 이름 변경하고 새 첫 관측을 받았다(세대 4, 169 pins). 자동 코드 변경이 아니라 운영 데이터 1회 교정이다.
- 결과: 대시보드에 OmO 5.1.30(~/.bun)이 관리 대상으로 표시, 최신 확인 `up-to-date`.

## 한계 (중요)

- **배포된 omo-ai 5.1.24/5.1.30, OMP 17.1.8, Codex 0.162.1(npm), Claude 2.1.296에는 herdr native 브리지(`updater-native-bridge.js`, `--native-preflight`, `HERDR_UPDATER_FD`)가 없다.** 이전에 통과한 Codex/OMP/Pi/OmO 격리 lifecycle은 모두 로컬 소스 트리(`~/Desktop/herdr-native-*`)로 빌드한 통합본이었다. 따라서 "작업 끝 대기 → 종료 → 같은 대화 재개"는 **배포본 CLI로는 동작하지 않는다.**
- 세션 자동 재개는 업데이터가 **처음부터 core를 통해 띄운 세션**에만 적용된다. 이미 터미널에서 연 세션(현재 14개)은 사후 등록 경로가 없다.
- 현재 가능한 것: 설치 업데이트 → UI에 "구버전 실행 중, 작업 끝나면 각자 `omo -r`" 안내.
- 격리 OmO 전환 시도 기록: `.omo/evidence/session-preserving-cli-updates/omo-channel-r1/upgrade-result.json`, README.md (exit 1, 원인 = 브리지 부재).

## 다음 선택지

1. 각 CLI 업스트림에 native 브리지가 포함되기 전까지는 "설치 업데이트 + 재시작 안내"가 제품 범위다.
2. 로컬 통합 빌드를 글로벌 설치로 쓰는 경우에만 자동 재개가 가능하다(운영 환경 변경 승인 필요).

## 직접 확인

- `bun test test/app/controller.test.ts test/app/server.test.ts test/service/catalog-sources.test.ts`
- 웹 UI → 대시보드 → OmO 5.1.30 "최신 확인"; CLI 설치 → 세션 → 외부 세션이 있어도 "업데이트 영향 검토"에서 승인 가능하고 경고가 보인다.
