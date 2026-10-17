import { execFileSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { closeSync, fstatSync, openSync, readSync, readFileSync, realpathSync, statSync } from "node:fs";
import { z } from "zod";
import type { Installation } from "../protocol";
import type { ExternalSession } from "./types";
import type { CatalogEntry, CatalogId } from "./catalog-types";
import { AppError } from "./types";
import type { HerdrPaneAgent } from "./herdr-panes";
import type { OmoThread } from "./omo-threads";
import { omoActivity } from "./omo-threads";
import { catalogDefinitions, catalogPackage } from './catalog-registry';
import { isSupportedCli } from './catalog-types';

type Process = { readonly pid: number; readonly parent: number; readonly uid: number; readonly command: string;
  readonly tty?: string | null; readonly startedAt?: string | null; readonly stat?: string };
export function parseProcesses(output: string): readonly Process[] {
  return output.trim().split("\n").filter(Boolean).map((line): Process => {
    const detailed = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(?:(\S+)\s+)?([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(line);
    if (detailed?.[1] && detailed[2] && detailed[3] && detailed[4] && detailed[6] && detailed[7]) {
      const started = new Date(detailed[6]);
      if (!Number.isFinite(started.getTime())) throw new AppError("unavailable", "process_observation_unavailable");
      return { pid: Number(detailed[1]), parent: Number(detailed[2]), uid: Number(detailed[3]),
        tty: detailed[4] === "??" || detailed[4] === "?" ? null : detailed[4],
        ...(detailed[5] ? { stat: detailed[5] } : {}),
        startedAt: started.toISOString(), command: detailed[7] };
    }
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match?.[1] || !match[2] || !match[3] || !match[4]) throw new AppError("unavailable", "process_observation_unavailable");
    return { pid: Number(match[1]), parent: Number(match[2]), uid: Number(match[3]), command: match[4] };
  }).filter(row => !row.stat?.startsWith("Z"));
}
export function readProcesses(): readonly Process[] {
  return parseProcesses(execFileSync("/bin/ps", ["-axo", "pid=,ppid=,uid=,tty=,stat=,lstart=,command="], {
    encoding: "utf8", timeout: 5000, maxBuffer: 8 * 1024 * 1024,
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
  }));
}
/** Extract only the launch brand from the exact same process; never retain environment output. */
export function parseLaunchVersion(output: string, expected: Process): string | null {
  const observed = parseProcesses(output)[0];
  if (!observed || observed.pid !== expected.pid || observed.uid !== expected.uid
    || !expected.startedAt || observed.startedAt !== expected.startedAt
    || !observed.command.startsWith(expected.command + ' ')) return null;
  const environment = observed.command.slice(expected.command.length);
  const match = /(?:^|\s)SENPI_BRAND=(\{[^\n]*?\})(?=\s[A-Za-z_][A-Za-z_0-9]*=|\s*$)/.exec(environment);
  if (!match?.[1]) return null;
  try {
    const brand = z.object({ name:z.literal('OmO'), command:z.literal('omo'),
      displayVersion:z.string().regex(/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/) }).safeParse(JSON.parse(match[1]));
    return brand.success ? brand.data.displayVersion : null;
  } catch (error) { if(error instanceof SyntaxError)return null;throw error; }
}
function readLaunchVersion(row: Process): string | null {
  if(process.platform!=='darwin'||!row.startedAt)return null;
  try {
    return parseLaunchVersion(execFileSync('/bin/ps',['eww','-p',String(row.pid),'-o','pid=,ppid=,uid=,tty=,stat=,lstart=,command='],{
      encoding:'utf8',timeout:2000,maxBuffer:1024*1024,env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'},stdio:['ignore','pipe','pipe'],
    }),row);
  } catch(error) {
    // A disappearing/inaccessible process provides no evidence. Never propagate stdout containing env.
    if(error instanceof Error)return null;
    throw error;
  }
}
type OpenPaths = { readonly cwd: string | null; readonly conversations: readonly string[]; readonly sockets: readonly string[] };
/** lsof field output preserves spaces in names; only cwd or numbered REG descriptors count. */
export function parseOpenPaths(output: string): ReadonlyMap<number, OpenPaths> {
  const paths = new Map<number, { cwd: string | null; conversations: string[]; sockets: string[] }>();
  let pid: number | null = null;
  let descriptor = "", fileType = "";
  for (const line of output.split("\n")) {
    if (/^p\d+$/.test(line)) {
      pid = Number(line.slice(1)); descriptor = ""; fileType = "";
      if (!paths.has(pid)) paths.set(pid, { cwd: null, conversations: [], sockets: [] });
    } else if (line.startsWith("f")) { descriptor = line.slice(1); fileType = ""; }
    else if (line.startsWith("t")) fileType = line.slice(1);
    else if (line.startsWith("n") && pid !== null) {
      const value = paths.get(pid), path = line.slice(1).replace(/(?:\\x[0-9a-fA-F]{2})+/g,
        bytes => Buffer.from(bytes.replaceAll("\\x", ""), "hex").toString("utf8"));
      if (!value || !path.startsWith("/")) continue;
      if (descriptor === "cwd") value.cwd = path;
      else if (/^\d+[rwu]?$/.test(descriptor) && fileType === "REG" && path.endsWith(".jsonl")) value.conversations.push(path);
      else if (/^\d+[rwu]?$/.test(descriptor) && fileType === "unix" && path.endsWith(".sock")) value.sockets.push(path);
    }
  }
  return paths;
}
function readOpenPaths(pids: readonly number[], cwdOnly: boolean): string {
  if (pids.length === 0) return "";
  try {
    return execFileSync("/usr/sbin/lsof", ["-a", "-p", pids.join(","),
      ...(cwdOnly ? ["-d", "cwd", "-Fn"] : ["-F", "pftn"])], {
      encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024,
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    });
  } catch (error) {
    // lsof exits 1 for disappeared or inaccessible processes, often with partial output.
    if (error instanceof Error && "stdout" in error && typeof error.stdout === "string") return error.stdout;
    if (error instanceof Error && "code" in error && ["ENOENT", "EACCES", "ETIMEDOUT"].includes(String(error.code))) return "";
    throw error;
  }
}
const sessionHeader = z.union([
  z.object({ type: z.literal("session"), id: z.string().min(1).max(256), title: z.string().max(512).optional() }),
  z.object({ type: z.literal("session_meta"), payload: z.object({ id: z.string().min(1).max(256), title: z.string().max(512).optional() }) }),
]);
/** Read only the first metadata line, never conversation messages or tool results.
 * A byte-at-a-time bounded read avoids fetching the next (potentially prompt) line. */
export function readConversationHeader(path: string): NonNullable<ExternalSession["conversation"]> | null {
  if (!path.startsWith("/") || !path.endsWith(".jsonl")) return null;
  let fd: number | undefined;
  try {
    const canonical = realpathSync(path);
    fd = openSync(canonical, "r");
    if (!fstatSync(fd).isFile()) return null;
    const bytes = Buffer.alloc(4096);
    let length = 0, complete = false;
    while (length < bytes.length) {
      if (readSync(fd, bytes, length, 1, null) === 0) { complete = true; break; }
      if (bytes[length] === 10) { complete = true; break; }
      length++;
    }
    if (!complete) return null;
    const parsed = sessionHeader.safeParse(JSON.parse(bytes.subarray(0, length).toString("utf8")));
    if (!parsed.success) return null;
    const metadata = parsed.data.type === "session" ? parsed.data : parsed.data.payload;
    return { id: metadata.id, title: metadata.title ?? null, path: canonical };
  } catch (error) {
    if (error instanceof SyntaxError || (error instanceof Error && "code" in error
      && ["ENOENT", "ENOTDIR", "EACCES", "ELOOP", "ESTALE"].includes(String(error.code)))) return null;
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}
export type CurrentConversationContext = {
  readonly pid: number;
  readonly startedAt: string;
  readonly id: string;
  readonly path: string;
};
export function captureCurrentConversation(rows: readonly Process[] = readProcesses()): CurrentConversationContext | null {
  const id = process.env['PI_SESSION_ID'], path = process.env['PI_SESSION_FILE'];
  const header = id && path ? readConversationHeader(path) : null;
  if (!header || header.id !== id) return null;
  const byPid = new Map(rows.map(row => [row.pid, row]));
  const seen = new Set<number>();
  const observer = byPid.get(process.pid);
  let current = observer;
  while (current && current.uid === process.getuid?.() && !current.stat?.startsWith('Z') && !seen.has(current.pid)) {
    seen.add(current.pid);
    const executable = executablePosition(current.command);
    const canonical = executable ? canonicalExecutable(executable) : null;
    const detectedFamily = executable ? cliFamily(executable) ?? (canonical ? cliFamily(canonical) : null) : null;
    const family = executable && omoExtension(current.command, executable, canonical) ? 'omo' : detectedFamily;
    if (current.startedAt && (family === 'omo' || family === 'omp' || family === 'pi'))
      return { pid: current.pid, startedAt: current.startedAt, id: header.id, path: header.path };
    current = byPid.get(current.parent);
  }
  return null;
}
export type ObservationContext = {
  readonly omoThreads?: readonly OmoThread[];
  readonly cwdOutput?: string;
  readonly openFilesOutput?: string;
  readonly observerPid?: number;
  readonly currentSessionId?: string;
  readonly currentSessionFile?: string;
  readonly observedAt?: number;
  readonly currentConversation?: CurrentConversationContext | null | undefined;
  readonly herdrAgents?: readonly HerdrPaneAgent[] | null | undefined;
  readonly paneScreens?: ReadonlyMap<string, string> | undefined;
  readonly cpuPercent?: ReadonlyMap<number, number> | undefined;
  readonly cpuQuiet?: ReadonlyMap<number, boolean> | undefined;
};
/** True when the recent screen ends at an input prompt (`❯`) with no visible working spinner.
 * A prompt can be visible while sub-agents still work, so this is a hint for people, not a
 * reason to type into the pane on its own. */
export function screenLooksIdle(screen: string): boolean {
  const lines = screen.split("\n").map(line => line.replace(/\s+$/, "")).filter(line => line.trim().length > 0);
  const tail = lines.slice(-12);
  const prompt = tail.some(line => /^\s*❯(\s|$)/.test(line));
  const working = tail.some(line => /Working\.\.\.|^\s*(── )?[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Working\b/.test(line));
  return prompt && !working;
}
function sessionArgument(command: string, executable: string, cwd: string | null): readonly string[] {
  const tokens = (command.match(/"[^"\n]*"|'[^'\n]*'|[^\s]+/g) ?? []).map(token => token.replace(/^(["'])(.*)\1$/, "$2"));
  const paths: string[] = [];
  for (let index = tokens.indexOf(executable) + 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === "--") break;
    if (token === "--extension" || token === "--model" || token === "--provider" || token === "--session-dir") { index++; continue; }
    let path: string | undefined;
    if (token === "--session" || token === "--session-file") path = tokens[++index];
    else if (token?.startsWith("--session=") || token?.startsWith("--session-file=")) path = token.slice(token.indexOf("=") + 1);
    else if (token && !token.startsWith("-")) break; // positional prompt is not a launch option
    if (path?.endsWith(".jsonl") && (path.startsWith("/") || cwd)) paths.push(resolve(cwd ?? "/", path));
  }
  return paths;
}
/** Only argv[0], or the script operand of a known JS runtime, can identify a CLI.
 * ps does not preserve argv boundaries perfectly; ambiguous forms stay unobserved.
 * In particular, never search later arguments (prompts, shell -c or runtime -e).
 */
export function executablePosition(command: string): string | null {
  const tokens = command.match(/"[^"\n]*"|'[^'\n]*'|[^\s]+/g) ?? [];
  const unquote = (token: string) => token.replace(/^(["'])(.*)\1$/, "$2");
  const first = tokens[0] ? unquote(tokens[0]) : null;
  if (!first) return null;
  if (!/^(?:node|nodejs|bun)$/.test(basename(first))) return first;
  let index = 1;
  if (basename(first) === "bun" && tokens[index] === "run") index++;
  while (tokens[index] === "--no-warnings" || tokens[index] === "--enable-source-maps") index++;
  if (tokens[index] === "--") index++;
  const script = tokens[index];
  return script && !script.startsWith("-") ? unquote(script) : null;
}
function cliFamily(executable: string): ExternalSession["family"] | null {
  if (executable.startsWith('/')) {
    for (let directory=dirname(executable),depth=0;depth<8;depth++,directory=dirname(directory)) {
      try {
        const parsed=z.object({name:z.string(),bin:z.record(z.string(),z.string()).optional()})
          .safeParse(JSON.parse(readFileSync(join(directory,'package.json'),'utf8')));
        if(parsed.success&&parsed.data.bin?.['pi']
          &&resolve(directory,parsed.data.bin['pi'])===executable) {
          if(parsed.data.name==='@code-yeongyu/senpi')return 'senpi';
          if(parsed.data.name==='@earendil-works/pi-coding-agent')return 'pi';
          if(parsed.data.name==='@mariozechner/pi-coding-agent')return 'legacy-pi';
        }
      } catch(error) {
        if(!(error instanceof SyntaxError)&&!(error instanceof Error&&'code' in error&&['ENOENT','ENOTDIR','EACCES'].includes(String(error.code))))throw error;
      }
      if(directory===dirname(directory))break;
    }
  }
  // Match actual entrypoints, not any file beneath a package directory.
  if (/\/(?:omo-ai\/bin\/omo\.js)$/.test(executable)) return "omo";
  if (/\/@code-yeongyu\/senpi\/(?:dist\/(?:bundle\/|bun\/)?cli\.js|src\/cli\.ts|bin\/pi\.js)$/.test(executable)) return "senpi";
  if (/\/@earendil-works\/pi-coding-agent\/(?:dist\/(?:bundle\/|bun\/)?cli\.js|src\/cli\.ts)$/.test(executable)) return "pi";
  if (/\/@oh-my-pi\/pi-coding-agent\/(?:dist\/(?:bundle\/)?cli\.js|src\/cli\.ts|bin\/omp\.js)$/.test(executable)) return "omp";
  if (/\/@mariozechner\/pi-coding-agent\/(?:dist\/cli\.js|src\/cli\.ts)$/.test(executable)) return "legacy-pi";
  if (/\/@anthropic-ai\/claude-code\/cli\.js$/.test(executable)) return "claude";
  if (/\/@openai\/codex\/bin\/codex\.js$/.test(executable)) return "codex";
  if (/\/@gajae-code\/coding-agent\/(?:dist\/cli\.js|src\/cli\.ts)$/.test(executable)) return 'gjc';
  switch (basename(executable)) {
    case "omo": return "omo";
    case "omp": return "omp";
    case "pi": return "pi";
    case "senpi": return "senpi";
    case "claude": return "claude";
    case "codex": return "codex";
    case "codex.opencodex-real": return "codex";
    default: return catalogDefinitions.find(row=>row.executable===basename(executable))?.id??null;
  }
}
/** Herdr's OmO identity is the senpi entry plus its explicitly loaded plugin.
 * Only launch options before the prompt delimiter count; never search prompt text.
 */
function omoExtension(command: string, executable: string, canonical: string | null): string | null {
  if (!/\/@code-yeongyu\/senpi\/dist\/(?:bundle\/)?cli\.js$/.test(canonical ?? executable)) return null;
  const tokens = (command.match(/"[^"\n]*"|'[^'\n]*'|[^\s]+/g) ?? [])
    .map(token => token.replace(/^(["'])(.*)\1$/, "$2"));
  const entry = tokens.indexOf(executable);
  const extensions: string[] = [];
  for (let index = entry + 1; index < tokens.length && tokens[index] !== "--"; index++) {
    if (tokens[index] !== "--extension") continue;
    const path = tokens[++index];
    if (path?.startsWith("/") && /\/omo-ai\/plugin\/?$/.test(path)) extensions.push(path.replace(/\/$/, ""));
  }
  return extensions.length === 1 ? extensions[0] ?? null : null;
}
/** A CLI launched by another CLI (for example a model provider child) shares that CLI's pane and
 * foreground group but is not the pane's agent; typing into the pane would reach its parent. */
function parentCli(row: Process, byPid: ReadonlyMap<number, Process>, cliPids: ReadonlySet<number>): number | null {
  const seen = new Set<number>([row.pid]);
  for (let current = byPid.get(row.parent); current && !seen.has(current.pid) && current.uid === row.uid; current = byPid.get(current.parent)) {
    seen.add(current.pid);
    if (cliPids.has(current.pid)) return current.pid;
  }
  return null;
}
function herdrPaneFor(row: Process, agents: readonly HerdrPaneAgent[] | null, byPid: ReadonlyMap<number, Process>): HerdrPaneAgent | null {
  if (!agents?.length) return null;
  const seen = new Set<number>();
  for (let current: Process | undefined = row; current && !seen.has(current.pid) && current.uid === row.uid; current = byPid.get(current.parent)) {
    seen.add(current.pid);
    const pid = current.pid;
    const match = agents.find(agent => agent.foregroundPids.includes(pid));
    if (match) return match;
  }
  return null;
}
function usesInstallation(command: string, installation: Pick<Installation, "executableRealpath">): boolean {
  const entry = installation.executableRealpath;
  if (command.includes(entry)) return true;
  const suffix = "/install/global/node_modules/omo-ai/bin/omo.js";
  if (!entry.endsWith(suffix)) return false;
  const prefix = entry.slice(0, -suffix.length);
  return command.includes(`${prefix}/install/global/node_modules/@code-yeongyu/senpi/`)
    || new RegExp(`(?:^|\\s)${`${prefix}/bin/omo`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`).test(command);
}
const diskManifest = z.object({ name: z.string(), version: z.string().min(1).max(128) });
function diskPackage(executable: string, family: ExternalSession['family'], extension: string | null): Exclude<ExternalSession['diskPackage'], undefined> {
  const expected = catalogDefinitions.find(row=>row.id===family);
  if (!family || !executable.startsWith('/')) return null;
  try {
    let directory = extension ? dirname(extension) : dirname(realpathSync(executable));
    for (let depth=0;depth<8;depth++) {
      try {
        const result=diskManifest.safeParse(JSON.parse(readFileSync(join(directory,'package.json'),'utf8')));
        if(result.success&&expected&&result.data.name===catalogPackage(expected.id)) {
          const installedAt=Math.max(statSync(directory).mtimeMs,statSync(join(directory,'package.json')).mtimeMs);
          return { ...result.data, installedAt: Math.floor(installedAt) };
        }
      } catch(error) {
        if(!(error instanceof SyntaxError)&&!(error instanceof Error&&'code' in error&&['ENOENT','ENOTDIR','EACCES'].includes(String(error.code))))throw error;
      }
      const parent=dirname(directory);if(parent===directory)break;directory=parent;
    }
  } catch(error) {
    if(!(error instanceof Error&&'code' in error&&['ENOENT','ENOTDIR','EACCES'].includes(String(error.code))))throw error;
  }
  return null;
}
/** Only when the process started after the package was last written can the on-disk
 * version be attributed to it; a start before that write means an older build is loaded. */
function runningVersionEvidence(startedAt: string | null, disk: Exclude<ExternalSession['diskPackage'], undefined>):
  Pick<ExternalSession, 'runningVersion' | 'runningVersionEvidence'> {
  if (!disk || !startedAt) return { runningVersion: null, runningVersionEvidence: 'unknown' };
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return { runningVersion: null, runningVersionEvidence: 'unknown' };
  if (started >= disk.installedAt) return { runningVersion: disk.version, runningVersionEvidence: 'started-after-install' };
  return { runningVersion: null, runningVersionEvidence: 'started-before-install' };
}
function canonicalExecutable(path: string): string | null {
  if (!path.startsWith("/")) return null;
  try {
    const canonical = realpathSync(path);
    return statSync(canonical).isFile() ? canonical : null;
  } catch (error) {
    if (error instanceof Error && "code" in error
      && ["ENOENT", "ENOTDIR", "EACCES", "ELOOP"].includes(String(error.code))) return null;
    throw error;
  }
}
/** Current disk-path correlation only: replacement cannot prove a live process's
 * loaded executable or version. Never an engine installation or control grant. */
export function externalCatalogId(executable: string, family: ExternalSession['family'], catalog: readonly CatalogEntry[]): CatalogId | null {
  const canonical = canonicalExecutable(executable);
  if (!canonical) return null;
  const matches = catalog.filter(entry => entry.id === family && entry.installed
    && canonicalExecutable(entry.installed.path) === canonical);
  return matches.length === 1 ? matches[0]?.id ?? null : null;
}
export function externalSessions(installations: readonly Installation[], managedPids: readonly number[],
  rows: readonly Process[] = readProcesses(), catalog: readonly CatalogEntry[] = [],
  context: ObservationContext = {}): readonly ExternalSession[] {
  const owned = new Set(managedPids);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) if (owned.has(row.parent) && !owned.has(row.pid)) { owned.add(row.pid); changed = true; }
  }
  const candidates = rows.flatMap(row => {
    if (row.uid !== process.getuid?.() || owned.has(row.pid) || row.stat?.startsWith("Z")) return [];
    const executable = executablePosition(row.command);
    if (!executable) return [];
    const canonical = canonicalExecutable(executable);
    const detectedFamily = (canonical ? cliFamily(canonical) : null) ?? cliFamily(executable)
      ?? (!['sh','bash','zsh','fish','dash'].includes(basename(executable))?context.herdrAgents?.find(agent=>agent.foregroundPids.includes(row.pid))?.agent:null);
    if (!detectedFamily) return [];
    const extension = omoExtension(row.command, executable, canonical);
    const effectiveFamily = extension ? "omo" : detectedFamily;
    const extensionEntry = extension && canonical
      ? canonicalExecutable(`${extension.slice(0, -"/plugin".length)}/bin/omo.js`) : null;
    const matches = installations.filter(value => {
      if (value.family !== effectiveFamily || canonical === null) return false;
      const entry = canonicalExecutable(value.executableRealpath);
      return entry !== null && (entry === canonical || (extensionEntry !== null && entry === extensionEntry));
    });
    const installation = matches.length === 1 ? matches[0] : undefined;
    const family = effectiveFamily;
    return [{ row, executable, family, installation, extension }];
  });
  const byPid = new Map(rows.map(row => [row.pid, row]));
  function origin(row:Process):NonNullable<ExternalSession['origin']> {
    const seen=new Set<number>();
    let current:Process|undefined=row;
    while(current&&current.uid===row.uid&&!seen.has(current.pid)){
      seen.add(current.pid);
      const entry=executablePosition(current.command);
      if(/^["']?\/Applications\/ChatGPT\.app\/Contents\//.test(current.command))return 'chatgpt';
      if(/^["']?\/Applications\/Visual Studio Code\.app\/Contents\//.test(current.command)
        ||entry?.includes('/.vscode/extensions/openai.chatgpt-'))return 'vscode';
      if(/^["']?\/Applications\/herdr\.app\/Contents\//i.test(current.command)
        ||(entry&&['herdr','herdr-web-ui'].includes(basename(entry))))return 'herdr';
      current=byPid.get(current.parent);
    }
    return row.tty?'terminal':'background';
  }
  const detected = new Map(candidates.map(candidate => [candidate.row.pid, candidate]));
  const visible = candidates.filter(candidate => {
    const seen = new Set([candidate.row.pid]);
    let parent = byPid.get(candidate.row.parent);
    while (parent && !seen.has(parent.pid) && parent.uid === candidate.row.uid) {
      seen.add(parent.pid);
      const ancestor = detected.get(parent.pid);
      const sameTerminal = !ancestor?.row.tty || !candidate.row.tty || ancestor.row.tty === candidate.row.tty;
      const wrapperEngine = ancestor && ancestor.executable !== candidate.executable
        && !(candidate.extension && ancestor.installation
          && ancestor.installation.executableRealpath !== `${candidate.extension.slice(0, -"/plugin".length)}/bin/omo.js`)
        && ((ancestor.family === candidate.family && basename(ancestor.executable) === ancestor.family)
          || (ancestor.family === "omo" && /\/@code-yeongyu\/senpi\//.test(candidate.executable)
            && (candidate.extension === null || ancestor.executable === `${candidate.extension.slice(0, -"/plugin".length)}/bin/omo.js`))
          || (ancestor.family === "codex" && /\/@openai\/codex\/bin\/codex\.js$/.test(ancestor.executable)
            && basename(candidate.executable) === "codex"));
      if (wrapperEngine && sameTerminal) return false;
      parent = byPid.get(parent.parent);
    }
    return true;
  });
  const pids = visible.map(candidate => candidate.row.pid);
  const cliPids = new Set(pids);
  const cwdPaths = parseOpenPaths(context.cwdOutput ?? readOpenPaths(pids, true));
  const descriptors = parseOpenPaths(context.openFilesOutput ?? readOpenPaths(candidates.map(candidate => candidate.row.pid), false));
  const observedAt = context.observedAt ?? Date.now();
  const currentId = context.currentSessionId ?? process.env['PI_SESSION_ID'];
  const currentFile = context.currentSessionFile ?? process.env['PI_SESSION_FILE'];
  // The observer itself is not an ancestor. Verify the complete process-table chain,
  // then bind only the nearest visible CLI, never a sibling or a title/cwd match.
  let current = byPid.get(context.observerPid ?? process.pid);
  const seen = new Set<number>();
  let currentPid: number | null = null;
  while (current && current.uid === process.getuid?.() && !current.stat?.startsWith("Z") && !seen.has(current.pid)) {
    seen.add(current.pid);
    current = byPid.get(current.parent);
    if (current && current.uid === process.getuid?.() && !current.stat?.startsWith('Z')
      && current.startedAt && pids.includes(current.pid)) { currentPid = current.pid; break; }
  }
  const retained = context.currentConversation;
  const retainedRow = retained ? byPid.get(retained.pid) : undefined;
  const retainedValid = retained && retainedRow?.startedAt === retained.startedAt
    && retainedRow.uid === process.getuid?.() && !retainedRow.stat?.startsWith('Z');
  if (retainedValid) currentPid = retained.pid;
  const currentConversation = retainedValid ? readConversationHeader(retained.path)
    : currentId && currentFile ? readConversationHeader(currentFile) : null;
  const verifiedId = retainedValid ? retained.id : currentId;
  return visible.map(({ row, executable, family, installation, extension }) => {
    const cwd = cwdPaths.get(row.pid)?.cwd ?? null;
    const paths = [...sessionArgument(row.command, executable, cwd), ...(descriptors.get(row.pid)?.conversations ?? [])];
    const conversations = new Map(paths.flatMap(path => {
      const conversation = readConversationHeader(path);
      return conversation ? [[conversation.path, conversation] as const] : [];
    }));
    const parentCliPid = parentCli(row, byPid, cliPids);
    const herdrPane = parentCliPid === null ? herdrPaneFor(row, context.herdrAgents ?? null, byPid) : null;
    const disk = diskPackage(executable, family, extension);
    const verifiedCurrent = currentPid === row.pid && currentConversation?.id === verifiedId
      && (family === "omo" || family === "omp" || family === "pi") ? currentConversation : null;
    if (verifiedCurrent) conversations.set(verifiedCurrent.path, verifiedCurrent);
    // A wrapper can own the pane while its engine child owns the TUI socket. Only walk
    // hidden same-family engine children; never claim another visible CLI or match by cwd.
    const sockets = new Set(descriptors.get(row.pid)?.sockets ?? []);
    if (family === "omo" && herdrPane) for (const candidate of candidates) {
      if (candidate.family !== "omo" || cliPids.has(candidate.row.pid)) continue;
      let parent = byPid.get(candidate.row.parent);
      const visited = new Set<number>();
      while (parent && parent.uid === row.uid && !visited.has(parent.pid)) {
        if (parent.pid === row.pid) {
          for (const socket of descriptors.get(candidate.row.pid)?.sockets ?? []) sockets.add(socket);
          break;
        }
        if (cliPids.has(parent.pid)) break;
        visited.add(parent.pid); parent = byPid.get(parent.parent);
      }
    }
    const threads = family === "omo" && herdrPane
      ? (context.omoThreads ?? []).filter(thread => sockets.has(thread.socket)) : [];
    const thread = threads.length === 1 ? threads[0] : undefined;
    const registered = thread?.registration;
    const owner = registered ? byPid.get(registered.pid) : undefined;
    const registeredStart = registered ? Date.parse(registered.processStartTime) : NaN;
    const engineVersion = registered && owner?.uid === row.uid && owner.startedAt
      && Date.parse(owner.startedAt) === registeredStart
      && descriptors.get(owner.pid)?.sockets.includes(thread.socket) ? registered.engineVersion : null;
    if (thread) {
      const header = readConversationHeader(thread.sessionPath);
      if (header?.id === thread.sessionId) {
        // The live endpoint supersedes a launch argument after an in-TUI session switch.
        conversations.clear();
        conversations.set(header.path, { ...header, title: thread.name ?? header.title });
      }
    }
    const conversation = conversations.size === 1 ? [...conversations.values()][0] ?? null : null;
    return {
    id: `external:${row.pid}:${row.startedAt ?? "unknown"}`, pid: row.pid, family, origin:origin(row), tty: row.tty ?? null, startedAt: row.startedAt ?? null,
    installationId: isSupportedCli(family)?installation?.installationId ?? null:null, executable, cwd,
    processState: "observed", observedAt, conversation,
    isCurrentConversation: verifiedCurrent !== null && conversation?.path === verifiedCurrent.path,
    ...(herdrPane ? { herdrPane: { paneId: herdrPane.paneId, status: herdrPane.status, stateChangeSeq: herdrPane.stateChangeSeq,
      screenIdle: (() => { const screen = context.paneScreens?.get(herdrPane.paneId); return screen === undefined ? null : screenLooksIdle(screen); })(),
      cpuPercent: context.cpuPercent?.get(row.pid) ?? null,
      cpuQuiet: context.cpuQuiet?.get(row.pid) ?? null } } : {}),
    ...(parentCliPid !== null ? { parentCliPid } : {}),
    catalogId: externalCatalogId(executable, family, catalog)??(!isSupportedCli(family)?catalogDefinitions.find(entry=>entry.id===family)?.id??null:null),
    // Existing core Runtime.runningVersion is copied from installedVersion, and
    // display registry observations carry no version. Neither proves this process's
    // version; authenticated worker reads also require credentials outside this observer.
    ...(() => {
      const version = family === 'omo' && herdrPane ? readLaunchVersion(row) : null;
      return version ? {runningVersion:version,runningVersionEvidence:'launch-environment' as const}
        : runningVersionEvidence(row.startedAt ?? null, disk);
    })(),
    ...(engineVersion ? { runningEngineVersion: engineVersion } : {}),
    ...(thread && conversation?.id === thread.sessionId ? { omoSocket: thread.socket,
      omoActivity: thread.state ? omoActivity(thread.state) : "unknown" as const } : {}),
    diskPackage: disk,
    control: herdrPane ? "herdr-pane" : "observation-only",
  }; });
}
/** Fresh extra refusal gate, in addition to the original inode/resource census. */
export function hasProcessConsumer(executableRealpath: string, rows: readonly Process[] = readProcesses()): boolean {
  return rows.some(row => row.pid !== process.pid && usesInstallation(row.command, { executableRealpath }));
}
export function installationPrefix(installation: Installation): string {
  const suffix = "/install/global/node_modules/omo-ai/bin/omo.js";
  if (installation.family !== "omo" || !installation.executableRealpath.endsWith(suffix))
    throw new AppError("unsupported", "bun_omo_installation_required");
  return installation.executableRealpath.slice(0, -suffix.length);
}
