import { expect, test } from "bun:test";
import { closeSync, ftruncateSync, mkdtempSync, mkdirSync, openSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { installationReferences } from "../../src/app/installation-references";

test("finds extension and plugin configuration references without reading conversations or credentials", () => {
  const home = mkdtempSync("/tmp/install-references-");
  const target = { kind: "npm" as const, target: "/old/lib", executable: "/old/bin/omo", manager: "/bin/npm",
    packageName: "omo-ai", fingerprint: "0".repeat(64), preserve: [] };
  try {
    const paths = [".omo/agent/extensions/default.js", ".codex/plugins/cache/omo/1/.mcp.json", ".omo/agent/sessions/log.json", ".omo/agent/extensions/auth.json"];
    for (const path of paths) { mkdirSync(join(home, path, ".."), { recursive: true }); writeFileSync(join(home, path), '"/old/lib/node_modules/omo-ai/plugin"'); }
    expect(installationReferences(home, target)).toEqual(paths.slice(0, 2).map(path => join(home, path)).sort());
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("scans deep plugin bundles and references crossing chunk boundaries without ignoring large files", () => {
  const home = mkdtempSync('/tmp/install-references-');
  const target = {kind:'npm' as const,target:'/old/lib',executable:'/old/bin/omo',manager:'/bin/npm',packageName:'omo-ai',fingerprint:'0'.repeat(64),preserve:[]};
  try {
    const file = join(home,'.codex/plugins/cache',...Array.from({length:12},(_,i)=>`level${i}`),'bundle.js');
    mkdirSync(join(file,'..'),{recursive:true});
    const content=Buffer.alloc(3*1024*1024,32);
    content.write(target.executable,1024*1024-4);
    writeFileSync(file,content);
    expect(installationReferences(home,target)).toEqual([file]);
    const fd=openSync(file,'r+');try{ftruncateSync(fd,64*1024*1024+1);}finally{closeSync(fd);}
    expect(()=>installationReferences(home,target)).toThrow('reference_scan_incomplete');
  }finally{rmSync(home,{recursive:true,force:true});}
});
