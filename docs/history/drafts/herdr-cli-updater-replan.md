# herdr updater 계획 재평가 실행 기록

Started: 2026-10-02. 기존 최종 계획을 같은 경로에서 보완하는 계획 전용 작업이다.

## 상태와 권한
- intent: clear
- review_required: true
- status: approved-for-plan-reassessment
- 사용자가 이번 메시지에서 계획 작성·리뷰 전체를 승인하고 추가 질문 없이 진행하도록 지시했다.
- 제품 구현, 실제 CLI 업데이트, 운영 pane 교체, 커밋·푸시·PR 전송은 이 계획 세션에서 수행하지 않는다.
- Tier: HEAVY. 사용자가 엄격한 검증을 요구하며 세션 교체·동시성·외부 CLI 계약을 재평가한다.
- loop ledger: `.omo/ulw-loop/01a0fd29-2794-7e95-ab73-b7aecaa3750e/ledger.jsonl`. 이 기록이 notepad이며 별도 임시 notepad는 만들지 않는다.

## 적용 스킬
- ulw-plan: 제품 구현 없이 하나의 상세 계획과 정식 리뷰를 완성한다.
- mass-ulw: 수집·반증·설계의 각 단계에 별도 dependency workflow를 사용한다.
- ulw-loop: 목표·근거·체크포인트를 SDK로 관리한다.
- bun-1-4: JS 커널과 SDK, 읽기 전용 CLI 실행에 적용한다.
- learning-development: 사실·추론·계획 승인·실행 검증을 분리한다.
- memory-discipline: 프로젝트 결정·교정은 기존 프로젝트 메모에 저장한다.
- coding-agent-sessions: 앞선 진행 확인에서 얻은 세션 증거를 활용한다. 새 세션 탐색은 근거 공백이 있을 때만 수행한다.
- frontend/browser/visual-qa/programming/git-master: 이번 세션은 해당 제품 표면이나 소스를 수정·실행하지 않으므로 실행 워크플로를 로드하지 않는다. downstream QA 지시에 해당 스킬을 명시한다.

## Plan
1. 기존 계획과 현황의 근거를 확정하고 승인·범위·quick 세분화 요구를 기록한다.
2. 읽기 전용 수집 workflow: core 계약, plugin worker 수명, CLI 공식 계약 두 묶음, 사용자 UI·회귀/QA. architect와 ultrabrain 자문을 같은 수집 wave에 실행한다.
3. 부모가 각 결과의 핵심 파일·공식 URL을 직접 대조한다. 반증 workflow에서 core, 설치·어댑터, 사용자 경험·증거를 독립 검증한다.
4. 최종 사용자·프로그래머·core 유지보수자별 이상적 상태와 현재 격차를 1:1 정의한다. 결정 불가능한 core 계약을 가짜 RPC로 치환하지 않는다.
5. 설계 workflow는 검증된 근거에서 작업 단위·QA 반증·통합 의존성 권고를 반환한다. 부모가 하나의 계획을 편집한다.
6. plan-consultant gap analysis를 반영하고 작은 disjoint quick 작업, specialist 세션 안전 작업, 단계별 workflow, exact QA invocation을 구체화한다.
7. 구조·요구/IS/GAP/task/QA·의존성·파일 소유권을 validator로 검증하고 scope 감사 근거를 저장한다.
8. immutable digest에 바인딩한 native plan-reviewer 리뷰를 수행한다. 지적을 직접 확인하고 계획 보완 후 새 리뷰를 수행한다.
9. 연구·자문·리뷰 children terminal 및 QA 자원 없음 확인, loop 근거·최종 quality gate·체크포인트를 기록하고 판단·한계·실행 순서를 한국어로 보고한다.

## 위임 구성
- 협력 team 대신 단계별 DAG + 독립 읽기 전용 task. 읽기 범위가 겹쳐도 쓰기는 없고 중간 대화가 필요하지 않다.
- explore: 실제 herdr/web-ui source·tests·프로토콜을 조사한다.
- librarian: 8개 CLI 공식 설치·정확한 재개·완료/정상 종료 계약을 조사한다.
- architect: 경계·분해·core 선행 조건을 읽기 전용 자문한다.
- ultrabrain: crash/input/shared-install 안전성 불변식과 반례를 읽기 전용 자문한다.
- 부모: 모든 파일 편집·독립 증거 대조·사용자 경험 판단·검증·review lifecycle.
- 향후 구현: `unspecified-low` 없음. 기계적 단일 파일/독립 adapter는 작은 `quick` + 관련 회귀 테스트를 함께 소유한다. 분할로 correctness 계약이 깨지는 core/transaction/restart는 전문 category를 유지하고 이유를 기록한다.

## 성공 기준과 QA
- C001: collect/verify workflow와 부모 파일·공식 계약 대조. 모든 안전 주장은 citation 또는 명시적 미확인/core gate. 근거 `.omo/evidence/herdr-cli-updater-replan/research.md`.
- C002: 최종 계획에 JS validator 실행. grammar/header/모든 IS·GAP·task·QA·dependency·파일 소유권 오류 0; native reviewer OKAY와 같은 SHA256. 근거 `plan-validation.json` 및 reassessment evidence.
- C003: `git -C /Users/beomseok/Desktop/herdr-web-ui status --short`, HEAD/diff 대조. 제품 변경 0, 원래 untracked 유지, 새 제품 폴더 없음, QA 자원 없음. 근거 `scope-audit.md`.
- runtime product QA는 이번 계획 완료의 증거가 아니다. 계획은 downstream exact-resume·입력 경쟁·crash·공유 설치·삭제 세션·실패 복구·TUI/xterm/browser 회귀의 실제 실행 기준을 정의한다.

## Now
수집 workflow를 시작하고 부모가 실제 소스·프로토콜 근거를 확인한다.

## Todo
수집 → 반증 → 사용자 상태·격차 → 상세 quick 분할 계획 → 구조/범위 검증 → native review → cleanup/checkpoint → 보고.

## Findings
- 기존 계획 12개 구현·4개 최종 검증은 전부 미착수. 제품 폴더 `/Users/beomseok/Desktop/herdr-cli-updater` 없음.
- 기존 web-ui HEAD `01290a4`; untracked `.worktrees/`, `omo-pane-icons-pr.md` 유지해야 한다.
- 기존 리뷰 SHA256 `48bd8c2de039cef6caf84edd96de40d3bb43d32ab2340c5a23873356b548b6af`; 계획 보완은 새 리뷰 digest가 필요하다.
- `herdr-web-ui/AGENTS.md` 없음. 기존 지침 위치는 조사 lane에서 확인한다.
- SDK workflow는 category뿐 아니라 subagent_type도 지원하므로 계획 스킬의 read-only agent 제한을 지키면서 DAG를 사용할 수 있다.

## Learnings
- 승인된 계획과 실제 구현 성공은 별개다. 100% 동일 상태는 구현 후 실제 QA로만 증명한다.
- 작업 세분화는 독립 correctness 경계와 파일 소유권에 맞추고 테스트를 다른 worker로 분리하지 않는다.

## 진행 기록 2026-10-02
- 수집 workflow `dag_26d4a9b5-0adb-42d5-a448-a46413eac442`: core/lifecycle/cli-pi/cli-other/ux-qa/boundary/invariants 병렬 + collect-audit 후행. 모든 child read-only, 부모만 .omo 편집.
- 부모 직접 근거 `../evidence/herdr-cli-updater-replan/parent-probes.md` 기록. LSP symbol 두 호출 실패는 숨기지 않았고 읽기로 조사했다.
- 현재 core schema에는 자동 재시작 안전 토큰·process incarnation/generation binding RPC가 없다. 제안과 실제를 분리해야 한다.
- Now: 수집 결과 도착 대기 중 부모 직접 source/schema 대조 완료. 다음은 수집 결과의 사실 검증과 반증 workflow다.

## 반증 기록
- 설치된 OMP help는 기존 equals 형태 resume를 명시한다. 원격 조사 오류를 원래 librarian에 교정 요청했다.
- 로컬 agy는 terminal Go CLI 1.2.12; Google desktop Antigravity와 혼동하지 않는다. provenance 기반 공식 조사로 교정한다.
- core source 공개 접근을 부모가 직접 확인했으므로 source unavailable를 무조건 blocker로 남기지 않는다. upstream ref↔installed protocol/version 정합성은 explicit gate다.
- SDK 조회 이름은 `snapshot`, node 상태 필드는 `state`, snapshot output은 2000자 cap. 잘못된 status 호출은 무변경 오류이고 실제 방법으로 교정했다.
- Now: 두 librarian correction과 설계 자문·collect-audit 완료를 기다리며 독립 부모 source 검증을 진행한다.

## 계획 보완 완료 기록
- 사용자4역할,12 IS/12 GAP/24 QA와34 task mapping을 기존 plan에 반영했다. quick22개, 전문12개.8 family는 각각 quick adapter/test owner, core completion/fence/receipts와restart/job transaction은 coherent specialist.
- consultant st_01a0fd44가 지적한 live update-only 의미/core 실제 patch ownership/all input inventory/outside updater/agy digest/OmO pinned engine/UID trust/recovery UX/source gate를 반영했다.
- native peerUID API는 미확인이라 강제 contract에서 제거하고 OS permission+private token을 baseline으로 했다. sameUID trusted, crossUID real rejection 없으면 unverified를 PASS로 바꾸지 않는다.
- public core source ref+installed release 정합성, compile commands/isolated binary/schema handshake와 각QA의 actual literal path expansion/bootstrap owner를 추가했다. 공식 source와 shipped source 불일치가 있어 fallback update command를 invent하지 않는다.
- 다른 제품 agy라는 추정은 현재 official native CLI 문서와 script를 직접 읽어 반증했다. 이전 반증 기록은 append-only audit이고 최종 사실은 parent-probes의 재교정 절을 따른다.
- 세 workflow completed(8+3+2 nodes); corrected librarians와consultant terminal. runtime resources0, 제품 변경0.
- Now: 계획 구조/매핑/의존성/소유권 validator와native final digest review.

## Self review
- HEAVY 유지: 세션 safety/외부 installer/엄격한 리뷰 요구. product diff는 없고 planning scope만 편집했다.
- task34 real parity gate는 unsupported safety display를 actual8 지원완료와 구분한다. 직접 실행하지 않은 runtime QA는 미래명세라고 명확히 적었다.
