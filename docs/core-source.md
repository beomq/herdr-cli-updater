# Core / installer provenance gate

## 현재 상태

이 문서는 task5의 P 검증기 부분이다. 전체 task5 완료나 재시작 지원을 뜻하지 않는다.
`test/fixtures/provenance.json`은 현재 획득한 artifact를 `observed.state="OBSERVED"`로 기록한다.
검증용 `null`은 파일이 없다는 뜻만이 아니다. 실제 파일이 있어도 현재 validator의 C-relative path/receipt/producer 계약을 충족하지 못하면 정확한 blocker와 함께 null로 남긴다.
관측 설명 문자열은 지원 판정에 사용하지 않는다. SHA, Git ref/tag, 파일, JSON receipt와 실제 readonly binary 출력만 검사한다.

2026-10-02 source acquisition 보고서:
`/Users/<user>/Desktop/portfolio/.omo/ulw-execute/task5-core-bootstrap.json`.

- 설치 herdr는 `0.9.1`, protocol `22`, schema_version `1`이다. 직접 `herdr --version`, `herdr api schema --json`을 실행했다.
- 설치 schema stdout SHA256: `226d4ecbd128d2e6bc84e4c8ddcec21ba9c7e51a0aafffcf087111ead3f1fa9a`.
- 획득 보고서는 설치 binary SHA256 `5fc7a7e7adfaca56fa80aa89dcb025693357268dab8285b9ce2d08a2313c89de`와 공식 v0.9.1 macOS arm64 asset digest 일치, tag schema 일치를 기록한다.
- 설치 release의 peeled source commit은 `065ef9d6a531c49fb8bee7e818ef837065b21ee9`, tag `v0.9.1`이다.
- 처음 확보한 public ref `65e35a3858b4a9f6cb9bdf712ffb16c474363846`는 Cargo `0.9.3`이고 정확히 가리키는 release tag가 없다. schema SHA256은 `9e2af207e9aa8183d4aeca5fde9cc48e7909bb40cdbd7cf21608a6d3ea78075b`로 설치본과 다르다. protocol22만 같다고 source가 같지는 않다.
- r2 보고서 `/Users/<user>/Desktop/portfolio/.omo/ulw-execute/task5-core-bootstrap-r2.json`은 C를 공식 v0.9.1 ref로 선택하고 private Rust/Zig와 실제 metadata를 확보했다. metadata는 build가 아니다. 실제 source build qualification은 계속 미완료이며 C는 다른 작업자 소유다.

### 현재 격리 build 관측

`/Users/<user>/Desktop/portfolio/.omo/ulw-execute/task5-core-baseline.json`과 `task5-core-parent-verify.json`은 이후 실제 release build를 확인한다. "아직 build를 하지 않았다"는 이전 상태는 현재 inventory에 적용하지 않는다.

- official v0.9.1 ref `065ef9d6a531c49fb8bee7e818ef837065b21ee9`, tree `25c7ed13ca34ac9530d27050d679c0e820022e0c`.
- immutable archive `/Users/<user>/Desktop/herdr-updater-toolchain/baseline-source.tar`, SHA256 `050b31ce77072c7ddf98e8f43cd261f531ff4fec3d4a0da9adcf9e1f50c56aa7`; extraction은 `baseline-source`다.
- private Rust/Cargo 1.96.1 및 Zig 0.16.0, 실제 환경과 executable hash는 registry의 `core.observed.toolchain`에 있다. 운영 toolchain으로 바꾸지 않았다.
- 실제 argv는 private cargo의 `build --release --locked`, cwd는 `/Users/<user>/Desktop/herdr-updater-toolchain/baseline-source`, exit0. build log SHA256 `d87d2ceef5fbad0b0571d5772367889bc337e458212ea864ce3dd57c3429b55d`.
- 실제 binary `/Users/<user>/Desktop/herdr-updater-toolchain/baseline-target/release/herdr`, SHA256 `2af87370b8a5a3639c05d4725281140961ee272663261d415c67f4704b5558bb`. readonly version은 `herdr 0.9.1`, exit0. 다운로드한 official 설치 binary의 `5fc7...`와 같은 파일이라고 주장하지 않는다.
- 실제 binary schema stdout SHA256 `226d4ecbd128d2e6bc84e4c8ddcec21ba9c7e51a0aafffcf087111ead3f1fa9a`, protocol22/schema1, exit0이며 source/installed schema와 같다.
- fmt/clippy는 exit0지만 **cargo test는 exit101, unit target은 SIGPIPE13/BrokenPipe**다. 완료한 target들의 125 pass와 종료 전 관측한 28 FAILED 이름은 전체 성공/실패 총계가 아니다. parent 재실행도 같은 실패를 기록했고 원인은 미확정이다. baseline은 FAIL, readiness와 restart 지원은 미완료다.

이 reconciliation은 위 기존 파일의 bytes hash를 다시 읽어 대조했으며 build나 Rust 명령을 새로 실행하지 않았다.
`core.sourceArchiveSha256`, `core.toolchain`, 현재 C의 source schema path/hash는 기존 계약으로 표현할 수 있어 채운다.
`core.binary`는 실제 경로가 C 밖이라 null이다. build/release 보고서는 현재 C-relative receipt 형식이 아니므로 `buildReceipt`/`releaseReceipt`도 null이다.
실제 build argv 순서를 verifier가 요구하는 `build --locked --release`로 바꿔 쓴 가짜 관측이나 receipt를 만들지 않는다. C artifact 복사·relocation도 하지 않는다.

## 독립 검증이 잡은 false PASS 교정

이전 검증기는 caller가 만든 build/release/parser JSON의 일치만으로 PASS를 반환했다.
실제 재현에서 미설치 compiler와 맞춰 쓴 receipt, unknown owner/channel, source에 없는 option, comment-only agy source, untracked build.rs가 모두 PASS였다.
수정 전 실제 CLI 회귀 5개가 모두 exit0을 반환해 실패했다. 이전 PASS/DoneClaim은 observed readiness 근거가 아니며 이번 delta가 이를 대체한다.

## 검증 API

```sh
cd /Users/<user>/Desktop/herdr-cli-updater
bun scripts/qa/provenance.ts \
  --registry test/fixtures/provenance.json \
  --core-source /Users/<user>/Desktop/herdr-updater-core \
  --evidence-dir .omo/evidence/herdr-cli-updater/task-5/provenance-live
```

필수 flag는 위 세 개이며 unknown/duplicate/missing argument는 exit2다.
유효한 검증 입력은 `parseRegistry(unknown)`에서 typed registry로 변환된다.
`verifyReceiptConsistency(registry, coreSource, actions)`는 `CONSISTENT, supportEnabled:false`만 반환한다.
synthetic fixture는 이 경로만 긍정 검증한다. 실제 Rust build 또는 공식 release acquisition으로 주장하지 않는다.
`verifyProvenance(registry, coreSource, actions, producer?)`는 consistency와 독립 producer qualification 모두 충족해야 `PASS, supportEnabled:true, qualification:"observed"`를 반환한다.
producer가 없으면 consistency가 맞아도 BLOCKED다.
실행 CLI는 미확보/불일치를 exit1/BLOCKED로 기록한다. `blockedField`는 실패 경계를 나타내는 machine field다.
`result.json`, `actions.json`, `cleanup.json`을 저장한다. updater/install/restart는 호출하지 않는다.
Git 조회 및 hash 검증 뒤 승인된 core artifact에 `--version`, `api schema --json`만 실행한다.

Consistency 조건 (이것만으로 PASS가 아님):

1. full40 sourceRef = 실제 HEAD = peeled releaseTag, tracked diff 없음, `git archive --format=tar <ref>` byte SHA 일치. untracked와 ignored build.rs/Cargo/lock/toolchain/.cargo/src/crates/vendor 및 Rust/C/Zig/TOML/lock 입력도 검사한다. `target/` 생성물은 제외한다.
2. Cargo package version, build receipt의 `command="cargo build --locked --release"`, `exitCode=0`, sourceRef/toolchain/binarySha256 일치.
3. release receipt의 tag/sourceRef/version/설치 binarySha256/schemaSha256 일치.
4. core binary/schema/build/release artifact 파일 SHA 일치. pinned source의 `docs/next/api/herdr-api.schema.json`도 같은 schema SHA.
5. 실제 core binary version/schema stdout, 설치 version/protocol/schema_version/schema SHA 일치.
6. 8개 family 정확히 한 행씩, source/parser SHA 일치. owner/channel은 `{state:"unknown",reason}` 또는 `{state:"qualified",value,evidence:{path,sha256}}`다. unknown은 qualification을 통과하지 못하며 reason이 기록된다. qualified evidence의 bytes도 검사한다. 이는 caller 주장의 consistency이며 독립 관측으로 다시 확인해야 한다.
7. parser의 `method`는 `restricted-shell-case` 또는 `isolated-readonly-observation`이다. 첫 방법은 완전한 `case "$1" in ... esac` 문법, option별 빈 clause와 마지막 `*) exit 2 ;;`만 허용한다. comment/echo/heredoc/조건문 속 pattern은 parser로 인정하지 않는다. 실제 parsed options와 claimed options가 정확히 같아야 한다. 복잡한 shipped installer는 이 제한된 문법으로 억지 추출하지 않고 두 번째 방법의 독립 readonly 관측을 요구한다.
8. `isolated-readonly-observation`은 receipt의 observationId와 sourceSha256에 대응하는 trusted producer의 실제 관측이 필요하다. self-authored options만으로 통과하지 않는다. agy --dir는 있어야 하고 두 docs skip flag는 허용하지 않는다.

모든 registry artifact path는 C 아래 상대 경로다. Manifest/receipt는 관측의 신뢰 경계가 아니다.
registry에 producer라는 필드를 적거나 receipt를 재작성해도 observed PASS를 얻을 수 없다.
서명 시스템이나 verifier의 자동 build는 만들지 않는다.

### task8 acquisition runner의 trusted evidence 경계

`scripts/qa/provenance.ts`는 `IdentityQualification`, `ExecutionObservation`, `ProofBinding`, `ObservedQualification`, `ProofProducer`를 named export한다.
다른 worker의 shared 파일은 수정하지 않는다. 정확한 교차 작업 계약은 task5 evidence의 delta API 계약으로 전달한다.

task8의 신뢰할 수 있는 host가 실제 acquisition/build/isolated readonly parser 작업을 관측한 뒤 `ProofProducer.observe(binding)`으로 전달한다.
이는 JSON이나 standalone CLI flag로 제공하는 self-attestation이 아니다. `main(argv, producer)`를 task8 runner가 호출하거나 `verifyProvenance(..., producer)`를 직접 사용한다.
standalone query-only CLI는 producer를 자동 발견하지 않으므로 unqualified registry에 대해 nonzero다. 미래 readiness 경로는 해당 host API이며 실제 구현/실행은 task8 소유다.

필수 `ObservedQualification`:

- producerId/runId와 sourceRef/sourceArchiveSha256. producerId는 trusted host 객체와 같아야 한다.
- build는 independently witnessed `inputMode:"immutable-archive-only"`여야 한다. extractionRoot는 C와 다른 절대 경로이고 actual argv/cwd/env/exit/stdout/stderr와 archivePath/archiveSha256, output binarySha256를 묶는다. verifier는 실제 archive bytes와 compiler executable bytes도 재검사한다.
- actual cargo executable의 `build --locked --release` argv/exit0, actual rustc executable의 --version stdout = registry toolchain. env에는 실제 빌드 관련 변수만 비밀 값 없이 기록한다. metadata/version 문자열을 build 관측으로 대체하지 않는다.
- 공식 release API의 exact URL/status/headers/body와 macOS arm64 asset URL/status/headers/downloaded file path/bytes hash. JSON assets digest가 실제 downloaded artifact와 installed hash에 대응해야 한다.
- 8 installer 모두 독립 identity command의 argv/cwd/env/executable SHA/exit/stdout/stderr, qualified owner/channel/source SHA, parserObservationId, acceptedOptions와 option마다 isolated readonly parser probe 기록, actual mutationCount0.

trusted producer는 archive extraction이 정확히 해당 immutable bytes이며 build가 그 입력만 소비했고 installer probe가 실제 source parser를 사용했음을 자기 작업에서 관측해야 한다.
검증기는 그 producer의 권한이나 정직성을 JSON으로 인증하지 않는다. caller가 trusted host 코드를 직접 위조할 수 있다면 같은 프로세스 신뢰 경계 밖이다.
현재 P registry는 이미 관측된 실제 build를 기록하지만 이런 producer를 만들어 qualification을 주장하지 않는다. 실제 source/build/8installer qualified 긍정 검증은 아직 미완료다.

## 8 installer 관측

8개 `families/<family>/qualification.json`과 source receipt를 읽어 기존의 "all source:null=미획득" 상태를 교정했다.
현재 source/wrapper/installer 파일과 실제 저장 SHA256은 registry 각 행의 `observed.sourceArtifact`, release/ref/archive는 같은 `observed` 항목에 있다. 추가 LF가 있는 OMP/Senpi source는 archive member SHA와 저장 SHA를 구분한다.
이전 README/문서 GET과 도움말은 `historicalDocumentationAndHelp`에 보존한다. 획득된 bounded source는 전체 native source 또는 qualification과 다르다.
검증용 `source`/`parser`는 현재 C 안의 relative artifact만 받는데 실제 family 파일은 P evidence에 있다. 이 작업은 파일을 옮기거나 새 receipt를 만들지 않으므로 null과 `sourceNullReason`/`parserNullReason`를 유지한다.

| Family | 현재 획득·관측 | qualification blocker |
| --- | --- | --- |
| omo | omo-ai5.1.9 archive/실제 updater, ref bcc854a49eddbaf29ab1487922ff0c544ba2d026; bun wrapper가 Senpi2026.10.1-3 소유 | pure parser 관측은 whole CLI exit/env 증거가 아님. current5.1.10 parser 미획득; 독립 engine update 금지 |
| omp | 17.1.8 archive/source/native artifact, ref f446b8a8193e59b4cbd2cf487ab6fa1915e0b890 | 실제 manager/channel/resource 전체 미검증. current18.4.12 parser 미획득. task39 alternate source 승인 확대 금지 |
| pi | Senpi2026.10.1-3 archive/self-update source, npm provenance ref67ff74ad36c9e89f112fa1d997a72d158705f30e | OmO-owned shared engine이며 upstream Pi가 아님. tag는 다른 commit; 일부 installed rpc source가 archive와 다름. exact resume/drain 미검증 |
| claude | 2.1.287 official npm wrapper/installer/native artifact, public ref816ec211a648f17a411f63a45cfd44ddf8db00d9 | native private build ref3c446a1b98aceb99a6cdee0f84a8bea42f4a8937와 public ref가 다름; native parser source 없음. installed2.1.247의 owner/channel 미검증 |
| codex | 0.156.0 official source/native bytes와 isolated readonly parser, ref fe74a774532af67b5a4a3dec03ce9469e17f89af | owning manager/channel, per-option probes/producer 미완료. current0.160.0 parser 미획득 |
| agy | bootstrap install.sh와 1.2.15 official native artifact/version/help | native source/ref 및 installed old-release mapping 미획득, channel 불명. bootstrap/native install flag namespace 구분 필요 |
| cursor | 실제 cursor-agent2026.01.23-916f423 wrapper/installer/bounded updater source 획득, official archive SHA pin | historical owner/effective channel 미검증; current2026.10.01 archive 크기 상한 초과. agent alias는 여전히 Grok |
| grok | 1.0.46 official wrapper/native digest와 public ref2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8 source | npm gitHead2765805b944289c3512e059257732b64cf312853와 public ref가 다름. 실제 owner/channel/readonly parser 미검증; updater의 leader relaunch는 update-only 안전 증거가 아님 |

### task39 출처 경계

`/Users/<user>/Desktop/portfolio/.omo/ulw-execute/task39-alternate-source-registration.json`의 `qualified-source-v1`은 **task10 consumer만** parent/independent 검증을 받았다.
legacy는 retained/unknown writer/unqualified 상태다. global trust가 아니며 task5 consumer relocation은 별도 등록이 필요하다.
이 reconciliation은 legacy 파일을 변경하거나 다른 consumer를 alternate source로 바꾸지 않았다.

agy의 [공식 install 문서](https://antigravity.google/docs/cli/install)는 `--skip-aliases`, `--skip-path`를 설명한다.
실제 [shipped installer](https://antigravity.google/cli/install.sh)의 parser는 `-d|--dir`, `-h|--help`만 허용한다.
이번 GET script SHA256 `62966c07365423bd4dc209355060744058fb30d60f5323e2d360e39de64e5042`.
문서 raw HTML SHA256 `ed3f9868b37cccf38a2f968fc5eb7702c2e26d16ef5d959f3581d514c6e887c0`은 과거 webfetch text 변환 SHA와 직접 비교하지 않는다.
script는 latest manifest/checksum/staging 뒤 `cp "$extracted_binary" "$BINARY_PATH"`와 binary install을 수행하고 regular runs의 background self-update를 설명한다.
family receipt의 실제 bootstrap probe는 두 skip flag를 exit1로 거부했고, 별도 native `install --help`는 두 flag를 표시했다. 이 둘은 다른 parser namespace다.
immutable version 또는 busy-safe atomic swap 증거가 아니다. 문서 skip argv를 bootstrap에 전달하지 않는다. 이 reconciliation에서 installer/CLI 업데이트 실행은 0회다.

## 검증과 남은 게이트

```sh
bun test test/provenance.test.ts
bun run typecheck
```

테스트는 실제 Git checkout/source archive, synthetic isolated binary/schema, build/release/parser receipt를 생성하고 production parser/verifier를 실행한다.
malformed/source/schema/build/installer/agy flag mismatch와 실제 CLI bad binary SHA가 차단되는지 검사한다.
synthetic 긍정 사례는 `CONSISTENT/supportEnabled:false`만 증명한다. 독립 producer 없는 synthetic readiness는 명시적으로 BLOCKED다.
5 CLI mutation, ignored build.rs, 허용된 target 생성물, comment/quoted/dead code parser 위조도 검증한다. fixture 디렉터리는 finally에서 삭제한다.

문제 확인 순서: result.reason → actions의 실제 command/exit/stdout → registry observed artifact SHA → core baseline/parent 보고서와 SIGPIPE 실패 → 현재 validator path/receipt/producer 제약.
직접 검증은 위 CLI를 실행해 현재 registry가 nonzero/BLOCKED이고 update/restart count0인지 확인한다.
실제 baseline source/build/version/schema mapping은 관측됐지만 clean cargo test baseline, compatible receipt/producer, 8 installer parser/owner/channel/runtime qualification과 후속 core 기능 handshake는 아직 별도 gate다.
이 provenance PASS 자체도 completion/fence/exact resume 기능의 완료 증거는 아니다.
