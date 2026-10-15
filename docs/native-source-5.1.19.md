# OmO 5.1.19 / Senpi 2026.10.10 native 소스 준비

이 호환성은 로컬 vendor overlay 생성까지만 다룬다. 설치 자격, 실제 세션 drain/stop/restart QA는 별도다.

## 검토 범위

- Wrapper commit: `a8019016f47a9d814ebcc24bd921a561f065ee80`.
- Engine commit: `b8bef123f8beec4394408529b7eef60e746255a6`.
- `latest-hook-resolution.mjs`의 `currentHookResolutions`는 10개 충돌의 version, commit, upstream/baseline/hooked SHA-256와 충돌 블록을 고정한다. 하나라도 달라지면 실패한다. 기존 5.1.17 검토는 그대로 유지한다.
- Launcher는 upstream engine-command 분기와 native in-process FD 3 부트스트랩을 합친다. 일반 실행은 upstream Bun 최소 버전 처리, native 실행은 re-exec·bin repair 없이 기존 소유 프로세스를 유지한다.
- Host session은 native engine 검증 이후 upstream retry-fallback capability에 맞춘 wire로 연다. 실패 시 기존 stop 처리를 유지한다.
- Manager 취소는 upstream lane 반환과 native queued 취소 완료를 모두 수행한다. RPC import와 terminal 생성자는 upstream durable admission·permission capability·burst window와 native remote binding·managed input을 함께 유지한다.

## 실행과 확인

`scripts/native-prepare/omo.mjs --version 5.1.19 --output <새 절대 경로> --wrapper-hooks <원래 wrapper 훅> --engine-hooks <원래 engine 훅> --bun <고정 Bun> --npm <고정 npm> --node <고정 Node> --source-patches-only true`를 사용한다. 생성한 wrapper/engine applicationPatch를 실제 `apply_patch` 도구로 적용한 뒤 같은 인수에 `--resume true`를 추가한다. 외부 apply-patch 실행 파일은 필요하지 않다.

실패한 `BLOCKED` 결과를 성공으로 간주하지 않는다. 물질적 소스 수정 후 새 출력으로 시작한다. 원래 훅 checkout과 vendor manifest는 수정하지 않는다. 준비 스크립트 host는 Archive를 제공하는 Bun을 쓰되, original build는 고정 Bun 1.3.6/npm/Node 24.20 도구를 쓴다.

Exact engine의 `bun.lock`은 버전 3이라 Bun 1.3.6으로 읽을 수 없다. 따라서 5.1.19 engine은 upstream CI의 `npm ci --ignore-scripts`를 사용하고 wrapper는 기존 frozen Bun install을 사용한다. lockfile을 변환하거나 수정하지 않는다.

관련 확인: `bun test test/native-prepare`; 준비 뒤 `source-gates.mjs`의 native bridge·managed input 테스트, wrapper task·extension 타입 검사, unbundled build, source types와 지정 source formatting gates. 모든 원래 빌드 명령과 tool/source/artifact pin은 `preparation.json`과 `source-build.json`에 기록한다. `sourceDiffs`는 원래 두 훅 diff pin이며, `sourceGates`는 별도 QA 보고서 pin이다.

Wrapper locked install은 stock engine 선언을 포함한다. Source gate는 실제 packed engine `dist`를 그 로컬 dependency에 복사한 뒤 타입 검사한다. Manifest·lockfile·원래 hook checkout은 변경하지 않는다. 이 연결 없이 발생하는 native export 누락은 upstream 타입 실패로 분류하지 않는다. 이전 gate 보고서는 보존하고 새 revision 디렉터리에 재검증한다.

문제 확인 순서: `preparation.json.blocker` → 해당 `hooks/<wrapper|engine>/<파일>/merge.json` 및 세 소스 → original build 로그 → source-gates 로그. 새로운 upstream 변경은 검토 없이 허용하지 않는다. 사용자는 두 applicationPatch와 reviewedResolutions를 읽고, packed vendor manifest와 source binding pin을 대조할 수 있다.
