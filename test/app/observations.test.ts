import { afterAll, expect, test } from "bun:test";
import { captureCurrentConversation, externalSessions, hasProcessConsumer, parseOpenPaths, parseProcesses, readConversationHeader, readProcesses, screenLooksIdle } from "../../src/app/observations";
import type { Installation } from "../../src/protocol";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import type { CatalogEntry } from '../../src/app/catalog-types';
import { join } from 'node:path';

test('lsof escaped UTF-8 directory names remain readable', () => {
  const escaped = [...Buffer.from('개발')].map(byte => `\\x${byte.toString(16).padStart(2,'0')}`).join('');
  expect(parseOpenPaths(`p123\nfcwd\nn/Users/test/${escaped}/project\n`).get(123)?.cwd).toBe('/Users/test/개발/project');
});

const uid = process.getuid?.() ?? -1;
test('disk package changes do not become a running process version',()=>{
  const root=realpathSync(mkdtempSync('/tmp/observed-version-'));
  const packageRoot=join(root,'node_modules/omo-ai');mkdirSync(join(packageRoot,'bin'),{recursive:true});
  const executable=join(packageRoot,'bin/omo.js');writeFileSync(executable,'');
  try{
    writeFileSync(join(packageRoot,'package.json'),JSON.stringify({name:'omo-ai',version:'1.0.0'}));
    const processes=[{pid:991,parent:1,uid,command:`bun ${executable}`}];
    const first=externalSessions([],[],processes)[0];
    expect(first?.diskPackage).toMatchObject({name:'omo-ai',version:'1.0.0'});
    // No start time: nothing can be attributed.
    expect(first).toMatchObject({runningVersion:null,runningVersionEvidence:'unknown'});
    // Started after the install write: the disk version is the loaded one.
    const installedAt=first?.diskPackage?.installedAt??0;
    const after=externalSessions([],[],[{...processes[0]!,startedAt:new Date(installedAt+1000).toISOString()}])[0];
    expect(after).toMatchObject({runningVersion:'1.0.0',runningVersionEvidence:'started-after-install'});
    // Package rewritten after launch: the loaded build is older than disk and stays unknown.
    const future=new Date(installedAt+60_000);
    writeFileSync(join(packageRoot,'package.json'),JSON.stringify({name:'omo-ai',version:'2.0.0'}));
    utimesSync(join(packageRoot,'package.json'),future,future);utimesSync(packageRoot,future,future);
    const updated=externalSessions([],[],[{...processes[0]!,startedAt:new Date(installedAt+1000).toISOString()}])[0];
    expect(updated?.diskPackage?.version).toBe('2.0.0');
    expect(updated).toMatchObject({runningVersion:null,runningVersionEvidence:'started-before-install'});
  }finally{rmSync(root,{recursive:true,force:true});}
});
const row = (pid: number, command: string, parent = 1, user = uid) => ({ pid, parent, uid: user, command });
test('unsupported herdr agents remain observable without catalog or updater identity',()=>{
  const herdrAgents=[{paneId:'w:p',workspaceId:'w',terminalId:'t',agent:'custom-cli',status:'idle' as const,stateChangeSeq:1,cwd:'/work',title:null,foregroundPids:[720]}];
  const sessions=externalSessions([],[],[row(720,'/unknown/entry')],[],{herdrAgents,cwdOutput:'',openFilesOutput:''});
  expect(sessions).toHaveLength(1);
  expect(sessions[0]).toMatchObject({family:'custom-cli',catalogId:null,installationId:null,runningVersion:null,herdrPane:{paneId:'w:p'}});
});
test('GJC and OpenCode entrypoints are observed without inventing restart evidence',()=>{
  const sessions=externalSessions([],[],[row(721,'gjc'),row(722,'opencode')],[],{cwdOutput:'',openFilesOutput:''});
  expect(sessions.map(session=>session.family)).toEqual(['gjc','opencode']);
  expect(sessions.every(session=>session.installationId===null&&session.control==='observation-only'&&!session.conversation)).toBe(true);
});
test('legacy CLI identity survives a filtered catalog',()=>{
  const sessions=externalSessions([],[],[row(723,'qwen')],[],{cwdOutput:'',openFilesOutput:''});
  expect(sessions[0]).toMatchObject({family:'qwen',catalogId:'qwen',installationId:null});
});
test.each([
  ['/Applications/herdr.app/Contents/MacOS/herdr','herdr'],
  ['/Applications/ChatGPT.app/Contents/MacOS/ChatGPT','chatgpt'],
  ['/Applications/Visual Studio Code.app/Contents/MacOS/Electron','vscode'],
] as const)('reports application ancestry without granting control: %s',(command,origin)=>{
  const sessions=externalSessions([],[],[row(100,command),row(200,'/bin/zsh',100),row(300,'codex',200)]);
  expect(sessions[0]).toMatchObject({origin,control:'observation-only',runningVersion:null});
});
test('links a CLI to its herdr pane through foreground PID ancestry and reports the pane status',()=>{
  // Given: herdr reports pane w1:p1 with foreground PID 300 (the CLI) and w1:p2 with PID 400 (a shell wrapper).
  const pane=(paneId:string,status:'idle'|'working',foregroundPids:number[])=>({paneId,workspaceId:'w1',terminalId:`t-${paneId}`,agent:'pi',status,stateChangeSeq:5,cwd:'/work',title:null,foregroundPids});
  const herdrAgents=[pane('w1:p1','idle',[300]),pane('w1:p2','working',[400])];
  const rows=[row(100,'/Applications/herdr.app/Contents/MacOS/herdr'),row(200,'/bin/zsh',100),row(300,'codex',200),
    row(400,'/bin/sh',100),row(401,'claude',400),row(500,'omo',100)];
  // When
  const sessions=externalSessions([],[],rows,[],{herdrAgents});
  // Then: direct PID match, ancestor match, and no match each report honestly.
  expect(sessions.map(s=>[s.pid,s.control,s.herdrPane?.paneId??null,s.herdrPane?.status??null])).toEqual([
    [300,'herdr-pane','w1:p1','idle'],[401,'herdr-pane','w1:p2','working'],[500,'observation-only',null,null]]);
  expect(externalSessions([],[],rows,[],{herdrAgents:null}).every(s=>s.control==='observation-only')).toBe(true);
  // Then: a CLI launched by another CLI shares the pane's foreground group but never gets pane control.
  const nested=externalSessions([],[],[...rows,row(301,'claude --output-format stream-json',300)],[],{herdrAgents:[pane('w1:p1','idle',[300,301]),pane('w1:p2','working',[400])]});
  expect(nested.find(s=>s.pid===301)).toMatchObject({control:'observation-only',parentCliPid:300});
  expect(nested.find(s=>s.pid===301)?.herdrPane).toBeUndefined();
  expect(nested.find(s=>s.pid===300)?.herdrPane?.paneId).toBe('w1:p1');
  // Then: screen and CPU hints ride along with the pane link, null when unavailable.
  const hinted=externalSessions([],[],rows,[],{herdrAgents:[pane('w1:p1','working',[300])],paneScreens:new Map([['w1:p1','done\n──\n❯\n──\nstatus bar']]),cpuPercent:new Map([[300,0.4]]),cpuQuiet:new Map([[300,true]])});
  expect(hinted.find(s=>s.pid===300)?.herdrPane).toMatchObject({status:'working',screenIdle:true,cpuPercent:0.4,cpuQuiet:true});
  expect(nested.find(s=>s.pid===300)?.herdrPane).toMatchObject({screenIdle:null,cpuPercent:null,cpuQuiet:null});
});

test('screenLooksIdle needs a prompt in the tail and no working spinner',()=>{
  expect(screenLooksIdle('answer\n──\n❯\n──\n~/work • main')).toBe(true);
  expect(screenLooksIdle('answer\n❯ type here')).toBe(true);
  expect(screenLooksIdle('── ⠋ Working ────\n❯')).toBe(false);
  expect(screenLooksIdle('Working...\n❯')).toBe(false);
  expect(screenLooksIdle('streaming output without a prompt')).toBe(false);
  expect(screenLooksIdle('')).toBe(false);
});
test('application names in shell arguments do not establish process origin',()=>{
  const sessions=externalSessions([],[],[row(100,'/bin/zsh -c "herdr"'),{...row(200,'codex',100),tty:'ttys003'}]);
  expect(sessions[0]?.origin).toBe('terminal');
});
const fixtureRoot = realpathSync(mkdtempSync('/tmp/observed-links-'));
const entry = join(fixtureRoot, 'install/global/node_modules/omo-ai/bin/omo.js');
const senpi = join(fixtureRoot, 'install/global/node_modules/@code-yeongyu/senpi/dist/cli.js');
const bundledSenpi = join(fixtureRoot, 'install/global/node_modules/@code-yeongyu/senpi/dist/bundle/cli.js');
for (const executable of [entry, senpi, bundledSenpi]) {
  mkdirSync(join(executable, '..'), { recursive: true }); writeFileSync(executable, '');
}
afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));
const installation: Installation = { installationId: "fixture", family: "omo", channel: "stable",
  executableRealpath: entry, resourcesFingerprint: "fixture", resources: [],
  owner: { kind: "unknown", reason: "unverified_owner" }, installedVersion: { kind: "known", version: "99.0.0" }, lastCheck: null };

function catalogEntry(id: CatalogEntry['id'], path: string): CatalogEntry {
  return { id, name: id, description: { ko: id, en: id }, executable: id,
    sourceUrl: 'https://example.test', method: 'manual', availability: 'manual', reason: null,
    installed: { path, version: '99.0.0', managed: false } };
}

test('links a unique same-family canonical engine and catalog through symlink launches', () => {
  // Given: both launch and registry paths resolve to the same actual entrypoint.
  const launch = join(fixtureRoot, 'omo'); symlinkSync(entry, launch);
  const registry = join(fixtureRoot, 'registered-omo'); symlinkSync(entry, registry);
  // When
  const sessions = externalSessions([{ ...installation, executableRealpath: registry }], [],
    [row(501, launch)], [catalogEntry('omo', registry)]);
  // Then
  expect(sessions[0]).toMatchObject({ family: 'omo', installationId: 'fixture', catalogId: 'omo',
    executable: launch, runningVersion: null, control: 'observation-only' });
});

test('does not correlate unrelated families different copies or ambiguous engine candidates', () => {
  // Given
  const other = join(fixtureRoot, 'other/omo'); mkdirSync(join(other, '..')); writeFileSync(other, '');
  const scenarios: readonly (readonly Installation[])[] = [
    [{ ...installation, family: 'pi' }],
    [{ ...installation, executableRealpath: other }],
    [installation, { ...installation, installationId: 'duplicate' }],
  ];
  // When / Then
  for (const candidates of scenarios) {
    expect(externalSessions(candidates, [], [row(501, `bun ${entry}`)])[0])
      .toMatchObject({ family: 'omo', installationId: null, runningVersion: null, control: 'observation-only' });
  }
});

test('catalog-only exact links confer no engine identity or control', () => {
  // Given / When
  const sessions = externalSessions([], [], [row(501, `bun ${entry}`)], [catalogEntry('omo', entry)]);
  // Then
  expect(sessions[0]).toMatchObject({ installationId: null, catalogId: 'omo', runningVersion: null,
    control: 'observation-only' });
});

test('different copies and ambiguous catalog candidates remain unlinked', () => {
  // Given
  const other = join(fixtureRoot, 'catalog-copy/omo'); mkdirSync(join(other, '..')); writeFileSync(other, '');
  // When / Then
  for (const catalog of [[catalogEntry('omo', other)], [catalogEntry('omo', entry), catalogEntry('omo', entry)],
    [catalogEntry('codex', entry)]]) {
    expect(externalSessions([], [], [row(501, `bun ${entry}`)], catalog)[0]?.catalogId).toBeNull();
  }
});

test('deleted executable and bare command paths do not acquire correlation', () => {
  // Given
  const deleted = join(fixtureRoot, 'deleted/omo'); mkdirSync(join(deleted, '..')); writeFileSync(deleted, '');
  const stale = { ...installation, executableRealpath: deleted }; rmSync(deleted);
  // When / Then
  for (const executable of [deleted, 'omo']) {
    expect(externalSessions([stale], [], [row(501, executable)], [catalogEntry('omo', deleted)])[0])
      .toMatchObject({ installationId: null, catalogId: null, runningVersion: null });
  }
});

test.each([
  ["omo", "/bin/omo"], ["omp", "/bin/omp"], ["pi", "/bin/pi"], ["pi", "/bin/senpi"],
  ["claude", "/bin/claude"], ["codex", "/bin/codex"],
  ["omo", `bun ${entry}`],
  ["omp", "bun /modules/@oh-my-pi/pi-coding-agent/dist/cli.js"],
  ["pi", "node /modules/@code-yeongyu/senpi/dist/bundle/cli.js"],
  ["pi", "node /modules/@mariozechner/pi-coding-agent/dist/cli.js"],
  ["claude", "node /modules/@anthropic-ai/claude-code/cli.js"],
  ["codex", "node /modules/@openai/codex/bin/codex.js"],
] as const)("detects %s from executable position %s", (family, command) => {
  // Given / When
  const sessions = externalSessions([], [], [row(101, command)]);
  // Then
  expect(sessions).toHaveLength(1);
  expect(sessions[0]).toMatchObject({ family, pid: 101, runningVersion: null, control: "observation-only" });
});

test.each([
  `node unrelated.js "omo ${entry}"`, `bash -c "${entry}"`, `node -e '${entry}'`,
  `bun --eval '${entry}'`, `python script.py /bin/claude`, `echo /bin/codex`,
  "node /modules/@code-yeongyu/senpi/dist/utils/worker.js",
  "node /modules/@code-yeongyu/senpi/dist/index.js",
  "node app.js --prompt omp pi claude codex gemini",
])("ignores prompt and non-entrypoint arguments: %s", command => {
  // Given / When
  const sessions = externalSessions([installation], [], [row(101, command)]);
  // Then
  expect(sessions).toEqual([]);
});

test("groups wrappers through intermediary processes without merging separate terminals", () => {
  // Given: deliberately unordered tree, including a different family below it.
  const rows = [row(103, `bun ${bundledSenpi}`, 102),
    row(102, "sh helper", 101), row(101, `bun ${entry}`), row(104, "/bin/claude", 103),
    row(201, "/bin/omo"), row(202, `bun ${entry}`, 201)];
  // When
  const sessions = externalSessions([installation], [], rows);
  // Then
  expect(sessions.map(session => session.pid)).toEqual([101, 104, 201]);
  expect(sessions[0]).toMatchObject({ family: "omo", installationId: "fixture", runningVersion: null });
});

test("excludes other UIDs and every managed descendant in unordered trees", () => {
  // Given
  const rows = [row(103, "/bin/codex", 102), row(102, "sh helper", 101), row(101, "/bin/omo"),
    row(201, "/bin/claude", 1, uid + 1), row(301, "/bin/codex")];
  // When
  const sessions = externalSessions([], [101], rows);
  // Then
  expect(sessions.map(session => session.pid)).toEqual([301]);
});

test("retains same-family descendants on distinct terminals", () => {
  // Given
  const rows = [{ ...row(101, "/bin/omo"), tty: "ttys001" },
    { ...row(102, "/bin/omo", 101), tty: "ttys002" }];
  // When
  const sessions = externalSessions([], [], rows);
  // Then
  expect(sessions.map(session => session.pid)).toEqual([101, 102]);
});

test("retains independent same-entrypoint sessions without a tty", () => {
  const sessions = externalSessions([installation], [], [row(101, `bun ${entry}`), row(102, `bun ${entry}`, 101)]);
  expect(sessions.map(session => session.pid)).toEqual([101, 102]);
});

test("associates an OmO engine by its loaded extension without claiming its version", () => {
  const sessions = externalSessions([installation], [], [row(101,
    `bun ${senpi} --extension ${join(entry, '../../plugin')}`)]);
  expect(sessions[0]).toMatchObject({ family: "omo", installationId: "fixture", runningVersion: null });
});

test("does not link standalone senpi to a neighboring OmO installation", () => {
  const sessions = externalSessions([installation], [], [row(101,
    `bun ${senpi}`)]);
  expect(sessions[0]).toMatchObject({ family: "pi", installationId: null, runningVersion: null });
});

test("recognizes unknown OmO installations through launch options but not prompt text", () => {
  const engine = "node /modules/@code-yeongyu/senpi/dist/bundle/cli.js";
  const sessions = externalSessions([], [], [row(101, `${engine} --extension /unknown/omo-ai/plugin`),
    row(102, `${engine} -- --extension /unknown/omo-ai/plugin`)]);
  expect(sessions.map(session => [session.family, session.installationId])).toEqual([["omo", null], ["pi", null]]);
});

test("keeps stale wrapper and differently bound engine separate", () => {
  const sessions = externalSessions([installation], [], [row(101, `bun ${entry}`), row(102,
    `bun ${senpi} --extension /old/omo-ai/plugin`, 101)]);
  expect(sessions.map(session => [session.pid, session.installationId])).toEqual([[101, "fixture"], [102, null]]);
});

test("groups matching wrapper engine evidence but never substitutes installed version", () => {
  const rows = [row(101, `bun ${entry}`), row(102,
    `bun ${senpi} --extension ${join(entry, '../../plugin')}`, 101)];
  for (const version of ["1.0.0", "2.0.0"]) {
    const sessions = externalSessions([{ ...installation, installedVersion: { kind: "known", version } }], [], rows);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ pid: 101, installationId: "fixture", runningVersion: null });
  }
});

test("groups unknown matching wrapper and engine without claiming an installation", () => {
  const sessions = externalSessions([], [], [row(101, "bun /unknown/omo-ai/bin/omo.js"), row(102,
    "bun /engine/@code-yeongyu/senpi/dist/bundle/cli.js --extension /unknown/omo-ai/plugin", 101)]);
  expect(sessions).toHaveLength(1);
  expect(sessions[0]).toMatchObject({ pid: 101, family: "omo", installationId: null, runningVersion: null });
});

test("detects the grounded OpenCodex real binary identity", () => {
  expect(externalSessions([], [], [row(101, "/home/user/.local/bin/codex.opencodex-real")])[0])
    .toMatchObject({ family: "codex", runningVersion: null });
});

test("parses tty and start time while retaining old fixtures", () => {
  // Given
  const start = "Sun Oct 11 12:34:56 2026";
  const input = `101 1 ${uid} ttys003 ${start} /bin/omo\n102 1 ${uid} ?? ${start} /bin/pi\n103 1 ${uid} /bin/codex`;
  // When
  const sessions = externalSessions([], [], parseProcesses(input));
  // Then
  expect(sessions[0]).toMatchObject({ tty: "ttys003", startedAt: new Date(start).toISOString() });
  expect(sessions[1]).toMatchObject({ tty: null, startedAt: new Date(start).toISOString() });
  expect(sessions[2]).toMatchObject({ tty: null, startedAt: null });
});

test("keeps the refusal gate conservative even for prompts and foreign consumers", () => {
  // Given
  const rows = [row(101, `node app.js --prompt ${entry}`, 1, uid + 1)];
  // When
  const consumer = hasProcessConsumer(entry, rows);
  // Then
  expect(consumer).toBe(true);
});

test("reads real process metadata without exposing command arguments", () => {
  // Given / When: only OS process metadata is read, no sessions are started.
  const rows = readProcesses();
  // Then
  expect(rows.some(processRow => processRow.pid === process.pid && processRow.startedAt !== null)).toBe(true);
});

test.each(["/bin/gemini", "node /modules/@google/gemini-cli/dist/index.js"])("does not observe removed Gemini CLI: %s", command => {
  expect(externalSessions([], [], [row(101, command)])).toEqual([]);
});

test('parses exact cwd and regular JSONL descriptors without path substring matches',()=>{
  // Given / When
  const paths=parseOpenPaths('p101\nfcwd\nn/work/a b\nf4r\ntREG\nn/work/session.jsonl\nf5r\ntFIFO\nn/work/fake.jsonl\nf6r\ntREG\nn/work/session.jsonl.backup\np102\nfcwd\nn/other');
  // Then
  expect(paths.get(101)).toEqual({cwd:'/work/a b',conversations:['/work/session.jsonl'],sockets:[]});
  expect(paths.get(102)).toEqual({cwd:'/other',conversations:[],sockets:[]});
});
test('excludes zombies and distinguishes reused PIDs by process start time',()=>{
  // Given
  const start='Sun Oct 11 12:34:56 2026';
  const rows=parseProcesses(`101 1 ${uid} ?? Z ${start} /bin/pi\n102 1 ${uid} ttys003 S+ ${start} /bin/pi`);
  const context={cwdOutput:'',openFilesOutput:'',observedAt:123};
  // When / Then
  expect(rows.map(value=>value.pid)).toEqual([102]);
  const first=externalSessions([],[],rows,[],context)[0];
  const reused=externalSessions([],[],[{...rows[0],...row(102,'/bin/pi'),startedAt:'2026-10-12T00:00:00.000Z'}],[],context)[0];
  expect(first?.id).not.toBe(reused?.id);
  expect(first).toMatchObject({processState:'observed',observedAt:123,runningVersion:null});
  expect(externalSessions([],[],[row(102,'pi')],[],context)[0]?.id).toBe('external:102:unknown');
  expect(externalSessions([],[],[{...row(102,'pi'),stat:'Z+'}],[],context)).toEqual([]);
});
const conversationFile=join(fixtureRoot,'saved conversation.jsonl');
const otherConversationFile=join(fixtureRoot,'other.jsonl');
writeFileSync(conversationFile,JSON.stringify({type:'session',id:'exact-id',title:'Saved title'})+'\n'+JSON.stringify({type:'message',content:'not metadata'}));
writeFileSync(otherConversationFile,JSON.stringify({type:'session',id:'other-id',title:'Saved title'})+'\n');
const observationContext={cwdOutput:`p101\nfcwd\nn${fixtureRoot}`,openFilesOutput:'',observerPid:999, currentSessionId:'exact-id',currentSessionFile:conversationFile,observedAt:123};
const startedAt='2026-10-11T00:00:00.000Z';
test('links live OmO threads by owned sockets, never shared cwd, and ignores outside panes',()=>{
  // Given: two conversations in the same cwd and an endpoint owned only by pid 101.
  const socket='/tmp/omo-observation.sock';
  const thread={sessionId:'exact-id',sessionPath:conversationFile,socket,endpoint_kind:'tui' as const,alive:true as const,name:'Live title'};
  const pane={paneId:'w1:p1',workspaceId:'w1',terminalId:'t1',agent:'pi',status:'idle' as const,stateChangeSeq:1,cwd:fixtureRoot,title:null,foregroundPids:[101]};
  const context={...observationContext,omoThreads:[thread],herdrAgents:[pane],openFilesOutput:`p101\nf8u\ntunix\nn${socket}`};
  // When
  const sessions=externalSessions([],[],[row(101,`bun ${entry}`),row(102,`bun ${entry}`)],[],context);
  // Then
  expect(sessions[0]?.conversation).toEqual({id:'exact-id',title:'Live title',path:conversationFile});
  expect(sessions[1]?.conversation).toBeNull();
  expect(externalSessions([],[],[row(101,`bun ${entry}`)],[],{...context,herdrAgents:[]})[0]?.conversation).toBeNull();
  expect(externalSessions([],[],[row(101,`bun ${entry}`)],[],{...context,omoThreads:[{...thread,sessionId:'wrong'}]})[0]?.conversation).toBeNull();
  const processRow={...row(101,`bun ${entry}`),startedAt:'2026-10-01T00:00:00.000Z'};
  const registration={pid:101,processStartTime:processRow.startedAt,instance_id:'01a1300b-f131-7cf3-a037-7bf50e61a5f4',socket,engineVersion:'2026.10.11'};
  const registered={...context,omoThreads:[{...thread,registration}]};
  expect(externalSessions([],[],[processRow],[],registered)[0]?.runningEngineVersion).toBe('2026.10.11');
  expect(externalSessions([],[],[{...processRow,startedAt:'2026-10-02T00:00:00.000Z'}],[],registered)[0]?.runningEngineVersion).toBeUndefined();
});
test('uses an engine child socket for its wrapper without borrowing a visible sibling endpoint',()=>{
  // Given
  const socket='/tmp/omo-child.sock';
  const thread={sessionId:'exact-id',sessionPath:conversationFile,socket,endpoint_kind:'tui' as const,alive:true as const};
  const pane={paneId:'w1:p1',workspaceId:'w1',terminalId:'t1',agent:'pi',status:'idle' as const,stateChangeSeq:1,cwd:fixtureRoot,title:null,foregroundPids:[101,102]};
  const rows=[row(101,`bun ${entry}`),row(102,`bun ${bundledSenpi} --extension ${entry.slice(0,-'/bin/omo.js'.length)}/plugin`,101)];
  const context={...observationContext,omoThreads:[thread],herdrAgents:[pane],openFilesOutput:`p102\nf8u\ntunix\nn${socket}`};
  // When / Then
  expect(externalSessions([],[],rows,[],context)).toHaveLength(1);
  expect(externalSessions([],[],rows,[],context)[0]?.conversation?.id).toBe('exact-id');
  expect(externalSessions([],[],[rows[0]!,{...rows[1]!,parent:1}],[],context)[0]?.conversation).toBeNull();
});
test('binds exact session options and open regular files without choosing cwd or prompt paths',()=>{
  // Given / When / Then
  const expected={id:'exact-id',title:'Saved title',path:conversationFile};
  expect(externalSessions([],[],[row(101,`pi --session "${conversationFile}"`)],[],observationContext)[0])
    .toMatchObject({cwd:fixtureRoot,conversation:expected,isCurrentConversation:false});
  expect(externalSessions([],[],[row(101,'pi')],[],{...observationContext,openFilesOutput:`p101\nf7u\ntREG\nn${conversationFile}`})[0]?.conversation).toEqual(expected);
  for(const command of [`pi -- "${conversationFile}"`,`pi "--session ${conversationFile}"`,`pi --session "${conversationFile}.backup"`,'pi'])
    expect(externalSessions([],[],[row(101,command)],[],observationContext)[0]?.conversation).toBeNull();
  expect(externalSessions([],[],[row(101,`pi --session "${conversationFile}"`)],[],{...observationContext,openFilesOutput:`p101\nf7r\ntREG\nn${otherConversationFile}`})[0]?.conversation).toBeNull();
});
test('marks current only for a verified ancestor or retained PID and start binding',()=>{
  // Given
  const ancestor={...row(101,'pi'),startedAt};
  const rows=[ancestor,row(999,'updater',101),{...row(102,'pi'),startedAt}];
  const retained={pid:101,startedAt,id:'exact-id',path:conversationFile};
  // When / Then
  expect(externalSessions([],[],rows,[],observationContext).map(value=>value.isCurrentConversation)).toEqual([true,false]);
  expect(externalSessions([],[],rows,[],{...observationContext,currentSessionId:'wrong'})[0]?.isCurrentConversation).toBe(false);
  expect(externalSessions([],[],[ancestor,row(999,'updater')],[],observationContext)[0]?.isCurrentConversation).toBe(false);
  expect(externalSessions([],[],[ancestor,row(999,'updater')],[],{...observationContext,currentConversation:retained})[0]?.isCurrentConversation).toBe(true);
  for(const currentConversation of [{...retained,startedAt:'different'},{...retained,id:'wrong'}])
    expect(externalSessions([],[],[ancestor,row(999,'updater')],[],{...observationContext,currentConversation})[0]?.isCurrentConversation).toBe(false);
  expect(externalSessions([],[],[{...ancestor,startedAt:null},row(999,'updater',101)],[],observationContext)[0]?.isCurrentConversation).toBe(false);
});
test('captures launcher ancestry and rejects mismatched inherited session context',()=>{
  // Given
  const previousId=process.env['PI_SESSION_ID'],previousFile=process.env['PI_SESSION_FILE'];
  process.env['PI_SESSION_ID']='exact-id';process.env['PI_SESSION_FILE']=conversationFile;
  const rows=[{...row(101,'pi'),startedAt},row(process.pid,'updater launcher',101)];
  try{
    // When / Then
    expect(captureCurrentConversation(rows)).toEqual({pid:101,startedAt,id:'exact-id',path:conversationFile});
    const bundleRows=[{...row(101,`bun ${bundledSenpi} --extension ${join(entry,'../../plugin')}`),startedAt},row(process.pid,'updater launcher',101)];
    expect(captureCurrentConversation(bundleRows)).toEqual({pid:101,startedAt,id:'exact-id',path:conversationFile});
    expect(captureCurrentConversation([{...row(process.pid,`bun ${bundledSenpi} --extension ${join(entry,'../../plugin')}`),startedAt}]))
      .toEqual({pid:process.pid,startedAt,id:'exact-id',path:conversationFile});
    const alias=join(fixtureRoot,'launcher-cli.js');symlinkSync(bundledSenpi,alias);
    expect(captureCurrentConversation([{...row(101,`bun ${alias} --extension ${join(entry,'../../plugin')}`),startedAt},row(process.pid,'updater launcher',101)]))
      .toEqual({pid:101,startedAt,id:'exact-id',path:conversationFile});
    expect(captureCurrentConversation([rows[0] ?? row(101,'pi'),row(process.pid,'updater launcher')])).toBeNull();
    process.env['PI_SESSION_ID']='wrong';expect(captureCurrentConversation(rows)).toBeNull();
  }finally{
    if(previousId===undefined)delete process.env['PI_SESSION_ID'];else process.env['PI_SESSION_ID']=previousId;
    if(previousFile===undefined)delete process.env['PI_SESSION_FILE'];else process.env['PI_SESSION_FILE']=previousFile;
  }
});
test('reads only bounded header metadata and rejects arbitrary JSONL files',()=>{
  // Given
  const invalid=join(fixtureRoot,'invalid.jsonl');
  writeFileSync(invalid,JSON.stringify({type:'message',id:'false-match',title:'Saved title'})+'\n');
  // When / Then
  expect(readConversationHeader(invalid)).toBeNull();
  writeFileSync(invalid,JSON.stringify({type:'session',id:'exact-id',title:'x'.repeat(5000)})+'\n');
  expect(readConversationHeader(invalid)).toBeNull();
  writeFileSync(invalid,JSON.stringify({type:'session_meta',payload:{id:'codex-id'}})+'\n{invalid prompt body');
  expect(readConversationHeader(invalid)).toEqual({id:'codex-id',title:null,path:invalid});
});
