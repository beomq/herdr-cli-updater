import type { CatalogId } from './catalog-types';
import type { InstallRecipe } from './catalog-runner';

type Definition={readonly id:CatalogId;readonly name:string;readonly executable:string;readonly description:{readonly ko:string;readonly en:string};readonly sourceUrl:string;readonly method:string;readonly reason:string|null;readonly recipe:InstallRecipe|null};
const npm=(packageName:string,bin:string):InstallRecipe=>({kind:'npm',package:packageName,bin:`bin/${bin}`});
function entry(id:CatalogId,name:string,executable:string,sourceUrl:string,recipe:InstallRecipe|null,reason:string|null=null):Definition {
  return {id,name,executable,sourceUrl,recipe,reason,method:recipe?.kind==='npm'?`npm · ${recipe.package}`:recipe?.kind==='uv'?`uv · ${recipe.package}`:recipe?'Official installer':'Official installation guide',
    description:{ko:`${name} 터미널 에이전트`,en:`${name} terminal agent`}};
}
/** Identities match herdr-web-ui; source contracts: .omo/evidence/catalog/sources-{a,b}.md. */
export const catalogDefinitions:readonly Definition[]=[
  entry('agy','Antigravity CLI','agy','https://antigravity.google/docs/cli/install',{kind:'script',url:'https://antigravity.google/cli/install.sh',bin:'bin/agy',env:{},args:['--dir','$TARGET/bin']}),
  entry('amp','Amp','amp','https://ampcode.com/docs/cli',npm('@ampcode/cli','amp')),
  entry('claude','Claude Code','claude','https://code.claude.com/docs/en/setup',npm('@anthropic-ai/claude-code','claude')),
  entry('cline','Cline','cline','https://docs.cline.bot/cline-cli/installation',npm('cline','cline')),
  entry('codex','Codex','codex','https://github.com/openai/codex',npm('@openai/codex','codex')),
  entry('cursor','Cursor CLI','agent','https://cursor.com/docs/cli/installation',{kind:'script',url:'https://cursor.com/install',bin:'.installer-home/.local/bin/agent',env:{},args:[]}),
  entry('devin','Devin','devin','https://docs.devin.ai/cli',{kind:'devin-bundle',bin:'bundle/bin/devin'}),
  entry('droid','Factory Droid','droid','https://docs.factory.ai/droid-cli/cli-reference',npm('droid','droid')),
  entry('gjc','Gajae Code','gjc','https://github.com/Yeachan-Heo/gajae-code/blob/main/docs/install.md',{kind:'script',url:'https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/main/scripts/install.sh',bin:'bin/gjc',env:{GJC_INSTALL_DIR:'$TARGET/bin',GJC_NO_COMMUNITY_APP:'1'},args:[]}),
  entry('copilot','GitHub Copilot CLI','copilot','https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli',npm('@github/copilot','copilot')),
  entry('grok','Grok','grok','https://docs.x.ai/build/overview',{kind:'script',url:'https://x.ai/cli/install.sh',bin:'bin/grok',env:{GROK_BIN_DIR:'$TARGET/bin',GROK_CHANNEL:'stable',PATH:'$TARGET/bin:/usr/bin:/bin:/usr/sbin:/sbin'},args:[]}),
  entry('hermes','Hermes Agent','hermes','https://hermes-agent.nousresearch.com/docs/getting-started/installation/',{kind:'script',url:'https://hermes-agent.nousresearch.com/install.sh',bin:'hermes/.hermes/bin/hermes',env:{HERMES_INSTALL_DIR:'$TARGET/hermes',HERMES_HOME:'$TARGET/.installer-home/.hermes'},args:['--non-interactive','--skip-browser','--skip-computer-use']}),
  entry('kilo','Kilo CLI','kilo','https://kilo.ai/docs/code-with-ai/platforms/cli',npm('@kilocode/cli','kilo')),
  entry('kimi','Kimi Code','kimi','https://github.com/MoonshotAI/kimi-code',{kind:'script',url:'https://code.kimi.com/kimi-code/install.sh',bin:'bin/kimi',env:{KIMI_INSTALL_DIR:'$TARGET',KIMI_CODE_HOME:'$TARGET/.installer-home/.kimi-code',KIMI_NO_MODIFY_PATH:'1'},args:[]}),
  entry('kiro','Kiro CLI','kiro-cli','https://kiro.dev/docs/cli/',{kind:'kiro-dmg',bin:'Kiro CLI.app/Contents/MacOS/kiro-cli'}),
  entry('letta','Letta Code','letta','https://docs.letta.com/letta-code',npm('@letta-ai/letta-code','letta')),
  entry('maki','Maki','maki','https://maki.sh',{kind:'script',url:'https://maki.sh/install.sh',bin:'bin/maki',env:{MAKI_INSTALL_DIR:'$TARGET/bin'},args:[]}),
  entry('muse','Muse','muse','https://dev.meta.ai/docs/muse-code',{kind:'script',url:'https://dev.meta.ai/install.sh',bin:'bin/muse',env:{MUSE_INSTALL_DIR:'$TARGET/bin',MUSE_NO_MODIFY_PATH:'1',MUSE_LOGIN:'0',MUSE_CHANNEL:'muse-stable'},args:[]}),
  entry('omp','Oh My Pi','omp','https://github.com/can1357/oh-my-pi',{kind:'script',url:'https://omp.sh/install',bin:'bin/omp',env:{PI_INSTALL_DIR:'$TARGET/bin'},args:['--binary']}),
  entry('omo','OmO','omo','https://www.npmjs.com/package/omo-ai',npm('omo-ai','omo')),
  entry('opencode','OpenCode','opencode','https://opencode.ai/docs/',npm('opencode-ai','opencode')),
  entry('pi','Pi','pi','https://github.com/code-yeongyu/senpi',npm('@code-yeongyu/senpi','pi')),
  entry('qodercli','Qoder CLI','qodercli','https://docs.qoder.com/cli/installation',npm('@qoder-ai/qodercli','qodercli')),
  entry('qwen','Qwen Code','qwen','https://github.com/QwenLM/qwen-code',npm('@qwen-code/qwen-code','qwen')),
];
/** Package-manager alternatives do not replace the default standalone installer. */
export function catalogPackage(id:CatalogId):string|null {
  const recipe=catalogDefinitions.find(row=>row.id===id)?.recipe;
  return recipe?.kind==='npm'?recipe.package:id==='gjc'?'@gajae-code/coding-agent':id==='omp'?'@oh-my-pi/pi-coding-agent':null;
}

/** Installation follows the service host, never the browser's user agent. */
export function catalogForPlatform(platform:NodeJS.Platform,arch:string=process.arch):readonly Definition[]{
  return catalogDefinitions.map(definition=>{
    const reason=platform==='win32'?'windows_wsl_required'
      :platform!=='darwin'&&platform!=='linux'?'platform_installer_required'
      :arch!=='arm64'&&arch!=='x64'?'architecture_unsupported'
      :definition.recipe?.kind==='kiro-dmg'&&platform!=='darwin'?'platform_installer_required':null;
    return reason?{...definition,recipe:null,reason,method:'Official installation guide'}:definition;
  });
}
