# 제거 제한 개선

## 승인과 범위

2026-10-13 사용자가 앞선 원인별 표시 → Kilo 검증 → 독립 설치 지원 순서를
진행하도록 요청했다. 실제 운영 CLI 제거는 실행하지 않는다. 사용자 이해와
직접 확인은 미확인이다.

## 구현

- 제거 탐지의 `null` 결과만 전달하던 경로에 거절 원인을 보존했다. 영수증,
  잠금 파일, 의존 패키지, 관리자 부재, 메타데이터, 접근 권한, 검사 한도를
  구분한다. 기존 `discoverRemoval`의 반환 계약과 업데이트 대상은 유지했다.
- `CatalogInstallation.removalSupport`는 목록용 사전 안내다. 제거 권한이
  아니며 계획과 최종 승인에서 파일·프로세스·자동화·설정 참조를 다시 확인한다.
  Pi처럼 Bun 전역 직접 의존성이 아닌 도구는 단독 제거를 막고 이유를 표시한다.
- `removal-fingerprint.ts`: 파일 전체를 한 번에 메모리로 읽는 대신 1MiB씩
  SHA-256에 입력한다. 파일 전후 identity와 메타데이터를 검사하며 100,000개
  항목, 8GiB 총 읽기, 30초 예산은 유지한다. 이전 512MB 한도에 걸리던 실제
  Kilo 설치가 읽기 전용 검증에서 `owned`로 통과했다. 동기 파일 검증이므로
  큰 설치를 검사하는 동안 이벤트 루프가 점유되는 한계는 남는다.
- 독립 설치 제거는 업데이트 타입과 분리했다. 현재 지원은 공식 기본 경로의
  Claude·Antigravity·Kimi·OpenCode. 홈 아래 물리 디렉터리, UID, 쓰기 권한,
  단일 링크 파일, native executable 헤더, 공식 링크 구조와 내용 hash를 검사한다.
  배포자 서명을 확인하는 기능은 아니며, 사용자가 선택한 로컬 실행 파일의
  정확한 경로·내용·보존 범위를 확정하는 기능이다.
- 독립 실행 파일은 같은 디렉터리의 `.cli-updater-removed-<파일명>`에
  배타적으로 보관하고 기존 실행 경로를 제거한다. 설정·로그인·대화·다른 버전·
  보조 실행 파일·셸 PATH를 변경하지 않는다. 공간을 비우는 완전 삭제가 아니다.
  기존 보관본을 덮어쓰지 않으며 중간 실패는 uncertain으로 남긴다.
- 설정 참조가 있으면 확인창에 정확한 설정 파일 경로를 표시하고 실행을 막는다.
  최종 실행 직전 서버에서 다시 검사하므로 화면 확인 이후 생긴 참조도 차단된다.

## 공식 근거와 지원하지 않은 구조

- Claude: https://code.claude.com/docs/en/setup#uninstall-a-native-installation
  `~/.local/bin/claude` → `~/.local/share/claude/versions/<version>`.
  공식 전체 제거와 달리 선택된 버전만 보관하며 다른 버전을 지우지 않는다.
- Antigravity: https://antigravity.google/cli/install.sh
  https://antigravity.google/docs/cli/install.md
  기본 `~/.local/bin/agy`만. 로그아웃·keyring·staging 정리는 실행하지 않는다.
- Kimi: https://code.kimi.com/kimi-code/install.sh
  https://github.com/MoonshotAI/kimi-code/blob/afd95f64a5444b649a4cc33504513bf88e4c54ba/docs/en/guides/getting-started.md
  기본 `~/.kimi-code/bin/kimi`만. `rg`, `fd`, `.bak`, 데이터 디렉터리 보존.
- OpenCode: https://opencode.ai/install
  https://github.com/anomalyco/opencode/blob/d8129ca1e036a967add1e7078679fd9b3697a180/packages/cli/src/commands/handlers/uninstall.ts
  기본 `~/.opencode/bin/opencode`만. 서비스·persistent terminal 종료와 cache
  제거까지 하는 vendor uninstall은 호출하지 않는다.
- Grok: https://x.ai/cli/install.sh
  현재 공식 스크립트는 버전 없는 `downloads/grok-macos-aarch64`와 `agent`
  alias를 만든다. 운영 설치의 버전 포함 파일은 자료와 다르므로 추측하여
  지원하지 않았다. 상세 안내에서 검증되지 않은 설치 구조로 표시한다.

공식 가변 URL은 조사 시점 자료다. 별도 설치 위치·shell wrapper·사용자 지정
symlink는 기본 경로와 같다고 간주하지 않는다. 자동 업데이트가 제거한 실행
경로를 다시 만들 수 있으므로 앱 자동화와 실행 프로세스는 기존 가드로 차단하고,
앱 밖의 별도 updater까지 원자적으로 중지한다고 보장하지 않는다.

## 검증과 직접 확인

- 실제 Kilo와 독립 설치 4종의 읽기 전용 대상 검증 성공. 운영 제거 명령 미실행.
- 격리 HOME 테스트에서 payload 보관·설정/다른 버전 보존·변경된 파일/링크·
  쓰기 가능한 파일·스크립트·중복 보관본 거절과 실행 중/설정 참조 차단 검증.
- 513MB sparse 파일의 끝부분 변경 검출과 8GiB 초과 거절 테스트 추가.
- 초기 집중 테스트 28개 통과 후 타입 오류 2곳을 수정했다. 최종 결과는 아래 기록.

최종 검증: `bun test web test/app` 457 pass / 0 fail, `bun run typecheck`와
`bun run build` exit 0. 통합 테스트의 임시 저장소 권한을 실제 계약(0700)에
맞췄다. 화면 보완 뒤 관련 5개 테스트·타입·빌드도 exit 0, 최종 CSS 빌드 exit 0.
TypeScript LSP 오류 없음. CSS LSP는 Biome 미설치로 실행하지 못했다.

실제 설치 스냅샷을 읽는 격리 서버에서 1440px/390px, 라이트/다크 화면을
확인했다. Pi/Grok 제한 모달, Kimi 보관 경로 확인창과 취소를 검증했다.
모바일 버튼 때문에 CLI 이름이 좁아지는 문제를 별도 버튼 행으로 수정했고
가로 넘침이 없음을 확인했다. remove-confirm 전송은 0회이며 실제 제거는
임시 HOME 테스트에서만 실행했다. 격리 화면 서버는 종료했다.

이번 변경은 소스와 빌드에 반영했으며 실행 중인 로컬 서비스(PID 88272)의
재시작은 하지 않았다. 새 서버 로직을 운영 화면에 적용하려면 서비스 재시작이
별도로 필요하다. 실제 CLI 삭제·업데이트·세션 재시작은 실행하지 않았다.

직접 확인: CLI 설치 탭에서 Pi/Grok의 제한 이유를 열고, Kilo 또는 지원된
독립 CLI의 삭제 버튼으로 확인창까지 연 뒤 취소한다. 이 단계는 파일을 바꾸면
안 된다. 오류가 나면 표시된 원인 → 선택 실행 경로 → 영수증/잠금 파일 →
실행 프로세스와 설정 참조 순서로 확인한다.

## 운영 삭제 검토 장애 후속 수정

사용자가 Kimi·Kilo 삭제 실패를 보고한 뒤 운영 서비스에서 두 항목 모두
`manual_removal_required`를 재현했다. PID 88272가 이전 코드를 계속 실행하던
것이 첫 원인이었다. 새 코드로 재시작한 뒤에는 `reference_scan_incomplete`가
발견됐다. Codex 플러그인 캐시의 깊은 예제 디렉터리와 13,878,702바이트 JS
번들이 참조 검사의 깊이 10·파일당 2MiB 한도를 넘었다.

`installation-references.ts`에서 파일을 1MiB씩 읽고 청크 경계의 경로 문자열도
검색하도록 변경했다. 깊이 32·파일당 64MiB·총 128MiB·20,000항목으로 제한하며
읽기 전후 파일 identity·크기·수정 시각 검사를 추가했다. 검사 실패를 무시하거나
플러그인 소스를 제외하지 않았다. 한도 초과 안내도 구체화했다.

실제 대상 트리는 8,250항목, 검색 대상 약 27.6MB로 새 한도 안이었다.
Kimi 실제 경로에 대한 참조 없음 확인. 기존 제거 회귀 21개 통과,
참조 검사 수정 후 관련 15개 테스트 및 타입 검사 통과, 화면 빌드 exit 0.
초기 정상 재시작 전후 관찰한 15개 프로세스의 PID·시작 시각이 유지됐다.

최종 운영 서비스 PID 71835, 기존 주소 `http://127.0.0.1:62204`, ready/failure null.
사용자의 실제 브라우저에서 Kimi와 Kilo 각각 삭제 버튼 → 대상·보관 경로가 있는
확인창 → 닫기까지 검증했다. 두 계획은 ready이며 설정 참조는 빈 목록이다.
최종 삭제 승인은 누르지 않았다. 앱은 켜 둔 상태로 사용자에게 반환했다.
