# 카드 중심 업데이트와 실행 위치 선택

사용자가 승인한 범위: 상단 조작 축소, 카드별 조회·진행 표시, 카드 자동 업데이트 토글, 공통 업데이트 후 세션 정책, 중복 설치 정리 진입점, herdr 새 실행의 선택 설치 연결, 일반 터미널은 명시적 선택일 때만 PATH 변경, 현재 설치 상태와 과거 미확정 이력 분리.

원본 운영에는 이전 Pi/Claude 수정이 미커밋으로 남아 있다. 이를 별도 작업트리 feat/simplify-update-workspace에 먼저 보존했다. 이번 요청은 구현·검증이며 실제 사용자 .zshrc 변경, CLI 업데이트, herdr 교체, 배포·커밋은 하지 않는다.

## 구현 중인 계약

공통 자동화 설정은 SQLite singleton과 automation-settings 명령으로 저장한다. 현재/향후 자동화 토글은 이 설정을 사용하며 설정 저장은 기존 정책의 주기·켜짐 여부를 바꾸지 않는다. 이미 실행 중인 작업은 바꾸지 않고 busy 동안 거절한다. 기존 개별 정책이 서로 다르면 명시적인 공통 설정 저장 전에는 그대로 보존한다.

현재 검증: store/controller103개 테스트 통과. 기존 자동 재시작 테스트의 설정 진입은 개별 토글의 paneSessions에서 공통 automation-settings로 변경했다. 자동 업데이트가 외부 설치 변화를 감지하고 idle 세션을 다시 시작한다는 기존 기대 결과는 유지했다.

별도 트랙: UI web/** 및 DESIGN.md, 선택형 일반 터미널 catalog-default.ts, herdr 실행 API 읽기 전용 조사. 부모는 공유 서버 계약과 통합 검증 담당.

## herdr 연결 결정

기존 herdr agent.start는 CLI별 실행 이름을 고정하며 설정에 실행 경로 매핑이 없다. 전용 단축키는 다른 실행 경로이므로 기본 실행 연동으로 대신 표시하지 않는다. 사용자가 후속으로 "herdr 에서 업데이터에서 선택한 설치를 사용하는게 맞아보임"이라고 결정하여 실제 core 연결 구현을 진행한다. 운영 herdr 교체나 기존 세션 재시작 권한은 별도다.

UI/PATH 통합 검증은164개 테스트, 전체 타입 검사, build exit0. 실제 desktop/mobile light/dark 카드를 확인했고 모바일의 과도한 요약 타일은 compact 수치로 축소했다. herdr 연결이 완료되기 전 배포 완료로 표시하지 않는다.

core 구현 경로: /Users/<user>/Desktop/herdr-updater-core-source-cache/.worktrees/selected-agent-executable . server.agent_executable.get/set API가 대상 서버 소유 설정을 저장·적용하며 새 agent.start만 변경한다. core 집중9개+스키마/endpoint2개 테스트와 debug build 통과. updater 설치 선택은 이 API의 성공을 확인하고 정책/선택을 전환한다. 일반 터미널 변경 실패 시 이전 herdr 선택 복원을 시도하며 복원 실패는 uncertain으로 보고한다. 구형 서버는 성공으로 처리하지 않는다.

후속 구현에서 직렬화되지 않는 내부 Agent에 OmO/GJC를 추가했다. 동결된 endpoint는 이미 문자열 식별자를 사용하므로 코덱 변경 없이7종을 지원하며 Pi와 독립적으로 저장·시작한다. 관련 core 회귀152개 통과. 일반 셸 입력은 API 범위 밖이다. 운영 core/서비스는 아직 교체하지 않았다.

최종 updater 통합151개 테스트 통과. 마지막 재조회 회귀1개 및 전체 타입 검사/build exit0. herdr 상태는 조회 응답으로 다시 확인하며 구형 서버 실패는 적용으로 표시하지 않는다. 코어 검증은 격리된 설정과 터미널 입력 채널까지이며 실제 외부 CLI 준비 완료, Windows, 전체 suite는 미검증이다. UI desktop/mobile light/dark 및 공통 설정 실제 렌더 확인. 구현·검증8/8 완료; 원본 통합·커밋·푸시·운영 herdr/Console 교체는 아직 하지 않음.
