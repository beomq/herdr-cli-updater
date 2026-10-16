# 지원 CLI 일곱 개로 제한

## 2026-10-15 업데이트 우선 화면 문서 정합성

현재 소스 계약은 아래와 같다. 뒤의 검증·배포 기록은 이전 작업의 역사이며 이번 변경의 실행 증거나 운영 권한이 아니다.

- `supportedCatalogIds`는 `claude`, `codex`, `gjc`, `omp`, `omo`, `opencode`, `pi`를 유지한다. Pi의 현재 패키지는 `@earendil-works/pi-coding-agent`이다.
- standalone Senpi는 원본 Pi가 아니다. 기존 설치·대화·기록을 보존하고 예전 Senpi 대상의 준비 작업·정책을 upstream에 적용하지 않는다. OmO 소유 Senpi는 OmO 엔진으로 남는다.
- `web/app.tsx`의 첫 화면은 Updates이며 Terminal sessions, History가 주 탐색이다. CLI 추가는 Updates에서, 설치 관리·자동화는 CLI 상세에서 연다.
- `catalog-update-target.ts`는 출처별 업데이트 대상을 검증한다. 지원 목록·실행 파일 발견·최신 조회만으로 모든 설치 방식의 업데이트/제거를 허용하지 않는다.
- `src/adapters/pi.ts`의 `exactResume`와 `bridge`는 unsupported다. `pane-restart.ts`는 Pi를 허용하지 않는다. 따라서 아래 과거의 "다섯 종류" 설명은 현재 원본 Pi 재시작 지원을 뜻하지 않는다. OpenCode/GJC도 동일 대화 재시작을 약속하지 않는다.
- `catalog-updates.ts`의 recover는 설치 실행 함수를 호출하지 않고 출처·프로세스·디스크 버전을 재확인한다. 실행 근거가 부족하면 uncertain, 별도 보관은 archived-unverified다. 디스크 버전 확인만으로 과거 성공을 만들지 않는다.

선택 이유: 설치 갱신과 세션의 새 버전 적용을 나누면 기존 대화를 유지하면서 정확한 설치 대상으로 업데이트할 수 있다. 대신 화면에 버전 하나만 보여주거나 지원 목록을 재시작 보증으로 읽으면 안 된다. 새 정책은 keep이지만 명시적 기존 정책과 과거 누락값의 restart-idle 의미는 유지한다.

문제 확인 순서: 최신 조회 상태/오류 → 설치 경로·패키지·출처 → 승인 revision과 작업 결과 → 세션 PID·시작/실행 버전 근거. 미확정이면 재설치 대신 History의 재확인을 검토한다. 실패를 최신, 보관을 성공으로 바꾸지 않는다.

직접 검증: `web/QA.md`의 격리 fixture 절차로 다른 활성 작업의 복구 차단, 액션별 정책, 중복 승인 1회, reload 0회 전송을 확인한다. 공개 사이트는 `bun test test/site`가 build:site를 포함해 생성 목록·에셋·설치 경계를 검사한다. 브라우저는 생성된 정적 파일만 제공하는 owned preview를 사용한다. 이번 실행 결과는 portfolio의 `execution/task-9.md`에 별도로 기록한다. 사용자 직접 확인·이해와 운영 준비는 미확인이다.

## 요청과 구현 범위
2026-10-15 사용자가 OmO, Pi, OMP, OpenCode, Claude Code, Codex, GJC만 지원하고
다른 CLI는 터미널 세션에서 아직 지원하지 않음으로 표시하도록 구현을 요청했다.
운영 배포·CLI 삭제·세션 종료는 이번 요청에 포함하지 않는다.

## 선택 이유와 실제 변경
- `src/app/catalog-types.ts`의 `supportedCatalogIds`와 `isSupportedCli`를 공통 정책으로 사용한다.
- 기존 `catalogIds`는 저장된 작업을 읽기 위해 유지한다. 지원 제외가 데이터 삭제를 뜻하지 않는다.
- 카탈로그 노출뿐 아니라 서버 요청, 과거 ready 작업 확인, 자동 정책 실행에서도 거부한다.
- `web/dashboard.ts`는 관리 목록을 제한하되 외부 세션 관측을 유지한다.
- `web/app.tsx`는 미지원 세션에 상태·경로·실행 상세만 보여주고 동작 버튼을 제공하지 않는다.
- OpenCode/GJC의 지원 목록 포함이 같은 대화 재시작 지원을 뜻하지 않는다. 기존 다섯 종류의 재시작 범위는 유지한다.
- 공개 사이트의 목록도 같은 레지스트리를 사용한다.

## 검증 경계와 직접 확인
`bun test test/app web`: 547개 통과, 실패 0개(35.67초).
`bun run typecheck`: 종료 코드 0. `web/dashboard.ts`, `src/app/controller.ts` LSP 진단 없음.
공식 `scripts/build.ts`를 임시 작업 디렉터리에서 실행해 웹 번들 2개 생성, 종료 코드 0.
공개 사이트 생성 코드는 메모리 번들 검사 통과. 공개 사이트 배포·실제 패키징은 실행하지 않았다.
실제 Chrome의 테스트 전용 Surface 하네스에서 1440px/390px 라이트·다크 화면 확인:
카탈로그 일곱 개, 미지원 Grok 세션 유지, 동작 버튼 0개, 모바일 가로 넘침 없음.
하네스는 운영 API를 연결하지 않으므로 실설치 업데이트 성공을 주장하지 않는다.
기존 Select의 서버 렌더 useLayoutEffect 경고가 출력되지만 테스트 실패는 없다.
사용자의 직접 검증은 미확인이다.
CLI 설치 화면에서 일곱 개만 보이는지 확인한다. Grok 등 다른 CLI를 herdr에서 실행하면
터미널 세션에는 남지만 관리·업데이트·재시작 버튼이 없어야 한다.
문제가 있으면 공통 지원 목록 → 서버 `cli_not_supported` 거부 → 세션 family/카탈로그 연결 순서로 확인한다.
운영 서버는 재시작하지 않으므로 소스 변경과 운영 적용은 구분한다.

## 후속 운영 반영
사용자가 운영 및 랜딩 배포를 명시적으로 요청하여 2026-10-15 반영했다.
`bun run build`, `bun run build:site` 성공. 사이트 설치 검사 4개 통과.
기존 Maki 래스터 로고 필수 검사는 지원 제외로 오래된 기대값이 되어,
일곱 CLI의 실제 SVG 식별자와 포함된 이미지의 CSP 적합성 검사로 변경했다.
공식 서비스 종료/시작으로 PID 24070 → 33665, 포트 62204 유지.
운영 API ready, 카탈로그 정확히 7개, herdr pane 관측 14개와 현재 대화 PID 86154 유지.
Vercel `site/dist` 운영 배포 종료 코드 0. 기본 도메인 홈·기능·CLI 페이지 HTTP 200,
이전 24개 안내 제거, 공개 다운로드 체크섬 일치 확인.
운영 관리 화면 및 공개 CLI 페이지 데스크톱/모바일 렌더를 직접 확인했다.
