# 설치 상태 검증 수정

사용자 승인: Pi 경로 변경, 실행 프로세스 구분, 조회 시각 검토 유지, 버전 표시 분리, Claude 네이티브 조회·업데이트 구현. 운영 배포와 실제 CLI 업데이트는 이번 승인에 포함하지 않는다.

## 확인한 문제와 선택

- npm 패키지가 bin 경로를 바꾸면 정상 설치 후에도 이전 canonical 경로와 다르다는 이유로 거절됐다. 새 manifest의 bin과 실제 launcher가 같은 패키지 내부 파일을 가리킬 때만 새 canonical을 채택한다. prefix 교체, 외부 symlink, 다른 package와 실행 중 파일 변경은 계속 차단한다.
- 복구는 명령줄에 설치 prefix가 있다는 이유만으로 일반 CLI 소비자까지 installer로 판단했다. 저장된 executor PID와 실제 installer 명령 판정을 유지하고 prefix 문자열 판정만 제거한다.
- 이미 실행된 npm/bun의 미확정 기록은 같은 prefix와 재발견한 같은 package/manager/launcher 계약으로 현재 버전을 확인할 수 있다. 과거 성공으로 바꾸지 않으며 새 관찰을 고정한 뒤 미확인 보관을 허용한다.

## 검증 기록

새 회귀 재현: 3개 중 2개 실패, 외부 경로 거부는 통과. 수정 후 executor/recovery 관련 49개 테스트 통과. 실제 sandbox manager가 Pi bin을 이동하고 manifest와 symlink를 갱신한다. 현재 버전 재확인과 미확인 보관도 같은 실제 executor 테스트에서 확인했다. LSP 수정 production 두 파일 오류 없음.

UI 회귀 73개와 Claude 관련 48개 테스트 통과. UI는 실제 App/HTTP/SSE에서 조회 시각만 변경되면 승인을 유지하고 실제 대상 변경은 차단한다. 현재/이전/최신 버전을 분리한 한국어 상태 확인 창을 desktop1440/mobile390 라이트·다크 네 화면에서 직접 확인했다. 빈 화면·겹침 없이 확인 버튼까지 보인다. fixture 서버와 소유 브라우저는 종료했다.

Claude는 공식 네이티브 설치의 launcher, versions 디렉터리, 파일 소유자, 실제 바이너리 형식과 읽기 전용 doctor의 경로·채널 증거를 함께 확인한다. 공식 latest/stable 채널만 조회하며 업데이트는 검증된 바이너리의 update 명령과 실제 설치 결과를 대조한다. 출력 계약이 달라지면 추정하지 않고 검증 실패로 남긴다.

공식 근거: https://code.claude.com/docs/en/setup 및 https://code.claude.com/docs/en/settings, https://claude.ai/install.sh . 실제 운영 Claude 업데이트는 실행하지 않았다.

새 작업트리의 기본 타입 검사는 기존 미추적 fixture 누락으로 처음 66개 오류가 났다. 이전 작업트리의 최소 텍스트 fixture16개만 복원한 뒤 전체 타입 검사 통과. 테스트를 약화하거나 tsconfig 제외를 추가하지 않았다. 최종 통합 빌드 확인 중이며 사용자 직접 확인은 아직 하지 않았다.

실제 읽기 전용 확인: 새 discoverUpdate가 ~/.local/bin/claude를 official로 인식하고 https://downloads.claude.ai/claude-code-releases/latest 채널에서 2.1.301을 조회했다. 실제 update 명령은 실행하지 않았다. 통합 검사에서 신규 Claude 테스트의 환경변수 index-signature 접근 오류5개를 발견하여 bracket 접근으로 수정했다.

최종 결과: 타입 검사 통과 후 Claude14 테스트 재실행 통과. 묶음 monitor가 빌드 출력 이후 timeout되어 성공으로 간주하지 않고 diff 검사와 build를 분리 재확인: 둘 모두 exit0. 전체 과거 테스트 묶음은 재실행하지 않았으며 관련 집중 테스트와 실제 App 화면으로 검증했다. 구현·검증6/6 완료. 커밋·원본 통합·운영 배포는 실행하지 않음.

## 운영 반영 (후속 사용자 승인)

2026-10-16 사용자가 운영 배포를 요청했다. 검증된12개 파일을 원본에 반영하고 타입 검사·빌드 exit0 확인. 공식 stop/open으로 Console PID85208에서74774로 교체, 동일 상태 폴더와 포트62204 유지. ready 확인 후 기존 herdr 세션15개 PID·정책·업데이트 기록 모두 동일했다. 운영 catalog-check 명령으로 Claude 조회 결과 available / latestVersion2.1.301 / failure null 확인. 설치 자체 업데이트나 세션 재시작은 없었다. 이번 반영은 미커밋 상태이며 GitHub 푸시는 하지 않았다.
