import { mkdir } from 'node:fs/promises';
import { catalogDefinitions as allDefinitions, catalogForPlatform } from '../src/app/catalog-registry';
import { isSupportedCli } from '../src/app/catalog-types';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentMark } from '../web/agent-mark';
import metadata from '../package.json';

// Only this allowlisted static directory is uploaded, never the local app.
const catalogDefinitions=allDefinitions.filter(row=>isSupportedCli(row.id));
const output = new URL('./dist/', import.meta.url);
await mkdir(new URL('assets/', output), { recursive: true });
await mkdir(new URL('downloads/', output), { recursive: true });
const archiveName=`herdr-cli-updater-${metadata.version}.tgz`;
const archive=new URL(`downloads/${archiveName}`,output);
const pack=Bun.spawn(['npm','pack','--ignore-scripts','--pack-destination',new URL('downloads/',output).pathname],{cwd:new URL('../',import.meta.url).pathname,stdout:'pipe',stderr:'inherit'});
if(await pack.exited!==0)throw new Error('Public package build failed');
const checksum=new Bun.CryptoHasher('sha256').update(await Bun.file(archive).arrayBuffer()).digest('hex');
const installer=(await Bun.file(new URL('./install.sh',import.meta.url)).text())
  .replace('@@ARCHIVE_URL@@',`https://herdr-cli-updater.vercel.app/downloads/${archiveName}`).replace('@@SHA256@@',checksum);
await Bun.write(new URL('install.sh',output),installer);
await Bun.write(new URL(`downloads/${archiveName}.sha256`,output),`${checksum}  ${archiveName}\n`);
for (const [source, target] of [
  ['./landing.css', 'assets/landing.css'],
  ['./site.js', 'assets/site.js'],
  ['./platform.js', 'assets/platform.js'],
  ['./vercel.json', 'vercel.json'],
  ['../web/assets/symbol-sheep.png', 'assets/symbol-sheep.png'],
  ['../web/assets/favicon.ico', 'assets/favicon.ico'],
  ['../web/assets/favicon-180.png', 'assets/favicon-180.png'],
] as const) await Bun.write(new URL(target, output), Bun.file(new URL(source, import.meta.url)));
let markIndex=0;
const rasterMarks=new Map<string,Buffer>();
const mark = (id:string) => renderToStaticMarkup(createElement(AgentMark,{agent:id,size:24}),{identifierPrefix:`mark-${markIndex++}-`})
  .replace(/href="data:image\/png;base64,([^"]+)"/g,(_match,base64:string)=>{
    const bytes=Buffer.from(base64,'base64');
    const hash=new Bun.CryptoHasher('sha256').update(bytes).digest('hex').slice(0,12);
    const name=`agent-${id}-${hash}.png`;
    rasterMarks.set(name,bytes);
    return `href="/assets/${name}"`;
  });
const template = (await Bun.file(new URL('./index.html', import.meta.url)).text()).replace(
  /<div class="cli-names">[\s\S]*?<\/div>/,
  `<div class="cli-names">${catalogDefinitions.map(row=>`<span>${mark(row.id)}${row.name}</span>`).join('')}</div>`);
await Bun.write(new URL('index.html',output),template);
const escape = (text:string) => text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const cliList = (rows:typeof catalogDefinitions) => `<div class="catalog-list">${rows.map(row=>`<a class="catalog-link" href="${escape(row.sourceUrl)}" target="_blank" rel="noopener noreferrer"><strong>${mark(row.id)}${escape(row.name)}</strong><span>${row.recipe?'Official source':'Official setup guide'} ↗</span></a>`).join('')}</div>`;
const platformPanels = (["darwin","win32","linux"] as const).map(platform=>{
  const definitions=catalogForPlatform(platform,"x64").filter(row=>isSupportedCli(row.id));
  const direct=definitions.filter(row=>row.recipe), guides=definitions.filter(row=>!row.recipe);
  return `<div data-platform-panel="${platform}" hidden>${direct.length?`<section class="guide-section"><div class="section-title"><h2>Install from the app</h2><span class="count">${direct.length} CLIs</span></div>${cliList(direct)}</section>`:""}${guides.length?`<section class="guide-section"><div class="section-title"><h2>Official guidance</h2><span class="count">${guides.length} CLIs</span></div><p>${platform==="win32"?"The app has no native Windows installer. Use WSL2 for in-app installation; upstream CLIs may offer their own Windows installers.":"These entries have no in-app installer for this OS. Follow the official setup instructions."}</p>${cliList(guides)}</section>`:""}</div>`;
}).join("");
const allPlatforms = `<div data-platform-panel="all" hidden><section class="guide-section"><div class="section-title"><h2>All supported CLIs</h2><span class="count">${catalogDefinitions.length} CLIs</span></div><p>Management is limited to these ${catalogDefinitions.length} CLIs. Other herdr sessions remain visible in Terminal sessions only, without updates or restart controls. Installation methods and session capabilities vary by platform and CLI.</p>${cliList(catalogDefinitions)}</section></div>`;
const catalog = `<section class="page-intro"><p class="eyebrow">SUPPORTED CLIS</p><h1>A catalog for<br><em>your toolbox.</em></h1><p class="intro">${catalogDefinitions.length} coding CLIs. Desktop installation options follow your detected OS; mobile shows the full catalog. Authentication, updates, and running sessions have separate support scopes.</p></section><p class="fine" data-install-shell>Detecting your operating system…</p><div class="command-block" hidden><pre><code id="catalog-install-command" data-install-command></code></pre><button type="button" data-copy="catalog-install-command" hidden>Copy</button></div><p class="copy-feedback" role="status" aria-live="polite"></p><p class="fine" data-install-note>Explore supported tools and installation options.</p>${platformPanels}${allPlatforms}<section class="guide-section"><h2>What does “supported” mean?</h2><dl class="support-scope"><div><dt>Catalog and platform</dt><dd>The seven management IDs are ${catalogDefinitions.map(row=>row.id).join(', ')}. The local service checks its own OS, architecture and installation source. No in-app method means official guidance, not update authority. Native Windows is unsupported; WSL2 manages Linux installations only.</dd></div><div><dt>Upstream Pi</dt><dd>Pi uses <code>@earendil-works/pi-coding-agent</code>. Existing standalone Senpi installations and conversations are preserved, not renamed or replaced; they remain terminal-only. OmO-bundled Senpi remains an OmO engine.</dd></div><div><dt>Installation updates</dt><dd>Each app-owned, npm/Bun global, Homebrew or official installation must pass its implemented source and path checks. A catalog entry or successful latest lookup does not guarantee an update. Updates reviews the exact target; History retains the actual result. A failed check is never shown as current.</dd></div><div><dt>Running sessions</dt><dd>Installed, checked latest and running versions are separate evidence. Installation success does not prove session adoption. Restart requires a supported managed session or verified herdr pane; upstream Pi, OpenCode and GJC do not offer same-conversation restart. Other herdr sessions have no updater controls.</dd></div><div><dt>Removal and recovery</dt><dd>Removal requires its own source proof and exact-target confirmation; changing the update target does not change the terminal default. Reconcile checks disk and source without installing. Archive-unverified is not success, and reload never replays an installer.</dd></div></dl></section><section class="page-cta"><h2>Ready to explore your own installations?</h2><a class="button primary" href="/guide/#install">Get started →</a></section>`;
for (const [route,title,description,content] of [
  ['features','Features','Discover installations, observe sessions, and review supported CLI updates.',await Bun.file(new URL('./features.html', import.meta.url)).text()],
  ['clis','Supported CLIs',`Explore the ${catalogDefinitions.length}-CLI catalog and understand installation, observation, update, and removal support.`,catalog],
  ['guide','Installation guide','Install a herdr-cli-updater and open your local CLI workspace.',await Bun.file(new URL('./guide.html', import.meta.url)).text()],
] as const) {
  const url=`https://herdr-cli-updater.vercel.app/${route}/`;
  let page=template.replace(/<main id="main" class="wrap">[\s\S]*?<\/main>/,`<main id="main" class="wrap">${content}</main>`)
    .replace(/<title>.*?<\/title>/,`<title>${title} | herdr-cli-updater</title>`)
    .replace(/(<meta (?:name="description"|property="og:description") content=")[^"]+/,`$1${description}`)
    .replace(/(<meta property="og:title" content=")[^"]+/,`$1${title} | herdr-cli-updater`)
    .replace(/(<meta property="og:url" content=")[^"]+/,`$1${url}`)
    .replace(/(<link rel="canonical" href=")[^"]+/,`$1${url}`)
    .replace(`href="/${route}/">`, `href="/${route}/" aria-current="page">`);
  await mkdir(new URL(`${route}/`,output),{recursive:true});
  await Bun.write(new URL(`${route}/index.html`,output),page);
}
for(const [name,bytes] of rasterMarks)await Bun.write(new URL(`assets/${name}`,output),bytes);
console.log('Built public landing only: site/dist');
