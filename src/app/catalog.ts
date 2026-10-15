import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, realpathSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { catalogForPlatform } from './catalog-registry';
import { createVersionProbe } from './catalog-version';
import { updateSupport } from './catalog-update-target';
import { removalSupport } from './catalog-removal-support';
import { discoverCatalogInstallations } from './catalog-inventory';
import { executeRecipe, recipeExecutable, verifyExecutable, runProcess, parseCliVersion } from './catalog-runner';
import { AppError } from './types';
import { privateDirectory } from './store';
import { readProcesses } from './observations';
import type { AppStore } from './store';
import type { CatalogEntry, CatalogId, CatalogInstallation, InstallJob } from './catalog-types';
import { officialChoices, officialPlanSchema, planOfficialInstall, executeOfficialInstall } from './catalog-official';
import type { OfficialMethod } from './catalog-official';
import { isSupportedCli } from './catalog-types';

type Options={readonly directory:string;readonly home:string;readonly path:string;readonly prefixes?:readonly string[];readonly store:AppStore;readonly changed:()=>void;
  readonly adoptInstallation?:(catalogId:CatalogId,installation:CatalogInstallation,makeDefault:boolean)=>Promise<void>};
export function createCatalog(options:Options,dependencies:{readonly execute?:typeof executeRecipe;readonly verify?:typeof verifyExecutable;readonly processes?:typeof readProcesses;readonly platform?:NodeJS.Platform;readonly arch?:string;readonly discover?:typeof discoverCatalogInstallations;
  readonly planOfficial?:typeof planOfficialInstall;readonly executeOfficial?:typeof executeOfficialInstall}={}) {
  const catalogDefinitions=catalogForPlatform(dependencies.platform??process.platform,dependencies.arch??process.arch).filter(row=>isSupportedCli(row.id));
  const root=privateDirectory(join(options.directory,'cli-installs'));
  let running:Promise<void>|null=null;
  let planning=false;
  let inventory:readonly CatalogInstallation[]=[];
  let inventoryReady=false,inventoryFailure=false,repeatScan=false;
  let discoveredAt=0;
  let scanning:Promise<void>|null=null;
  const versions=createVersionProbe(options);
  for(const job of options.store.installJobs())if(job.stage==='installing'||job.stage==='verifying')
    options.store.putInstallJob({...job,revision:job.revision+1,stage:'uncertain',failure:'service_restarted',updatedAt:Date.now()});
  function scan():Promise<void>{
    if(scanning){repeatScan=true;return scanning;}
    scanning=(async()=>{
      do {
        repeatScan=false;
        try{
          const next=await (dependencies.discover??discoverCatalogInstallations)({...options,prefixes:options.prefixes??[],receipts:options.store.installJobs()});
          if(!repeatScan){inventory=next.map(row=>({...row,removalSupport:removalSupport(row,options.home)}));inventoryReady=true;inventoryFailure=false;discoveredAt=Date.now();}
        }catch(error){if(!(error instanceof Error))throw error;inventoryFailure=true;}
      }while(repeatScan);
    })().finally(()=>{scanning=null;options.changed();});
    return scanning;
  }
  function entries():readonly CatalogEntry[]{
    const receipts=options.store.installJobs(),policies=options.store.policies();
    return catalogDefinitions.map(definition=>{
      const instances=inventory.filter(row=>row.catalogId===definition.id).map(row=>{
        const probe=row.version===null?versions.read(definition.id,row.path):{version:row.version,status:'known' as const,checkedAt:discoveredAt};
        return {...row,version:probe.version,versionStatus:probe.status,checkedAt:probe.checkedAt};
      });
      const selection=options.store.catalogSelection(definition.id);
      const activePolicy=policies.find(row=>row.installationId===`catalog:${definition.id}`&&row.mode!=='off');
      let boundPath:string|null=null;
      if(activePolicy?.catalogBinding){
        try{const value:unknown=JSON.parse(activePolicy.catalogBinding);if(Array.isArray(value)&&typeof value[2]==='string')boundPath=value[2];}
        catch(error){if(!(error instanceof SyntaxError))throw error;}
      }
      const selected=selection?instances.find(row=>row.id===selection)
        :activePolicy?instances.find(row=>row.path===boundPath||row.identityPath===boundPath)
        :(definition.id==='omo'?instances.find(row=>row.manager==='bun'&&row.root===join(options.home,'.bun/install/global')):undefined)
          ??instances.find(row=>row.manager==='owned')??instances.find(row=>row.isDefault)??instances[0];
      const receipt=selected?.receiptId?receipts.find(row=>row.id===selected.receiptId):undefined;
      const installMethods=officialChoices(definition.id,dependencies.platform??process.platform,dependencies.arch??process.arch);
      return {id:definition.id,name:definition.name,description:definition.description,executable:definition.executable,installMethods,
        inventoryStatus:inventoryFailure?'failed':inventoryReady?'ready':'checking',installations:instances,selectedInstallationId:selected?.id??selection??null,
        updateSupport:selected?.manager==='brew'?{kind:'check-source',reason:null}:definition.recipe?updateSupport(definition.id):{kind:'unsupported',reason:'install_platform_unsupported'},
        sourceUrl:definition.sourceUrl,method:installMethods.find(row=>row.recommended)?.label??definition.method,availability:installMethods.length?'installable':'manual',reason:definition.reason??(installMethods.length?null:'official_setup_required'),
        installed:selected?{path:selected.path,identityPath:selected.identityPath,...(selected.manager==='bun'?{source:'bun-global' as const}:{}),version:selected.version,versionStatus:selected.versionStatus,checkedAt:selected.checkedAt,managed:selected.manager==='owned',lastVerifiedVersion:receipt?.installedVersion??null}:null};
    });
  }
  async function readyInventory():Promise<void>{
    await scan();
    if(inventoryFailure)throw new AppError('unavailable','inventory_unavailable');
  }
  async function select(catalogId:CatalogId,installationId:string,guard:()=>void=()=>{}):Promise<void>{
    if(!isSupportedCli(catalogId))throw new AppError('unsupported','cli_not_supported');
    if(planning||running)throw new AppError('busy','install_in_progress');
    planning=true;
    try{
      await readyInventory();
      guard();
      if(!inventory.some(row=>row.catalogId===catalogId&&row.id===installationId))throw new AppError('not_found','installation_missing');
      options.store.selectCatalogInstallation(catalogId,installationId);options.changed();
    }finally{planning=false;}
  }
  function getJob(id:string):InstallJob{const job=options.store.installJobs().find(row=>row.id===id);if(!job)throw new AppError('not_found');return job;}
  function change(id:string,fields:Partial<InstallJob>):InstallJob{const before=getJob(id);const next={...before,...fields,revision:before.revision+1,updatedAt:Date.now()};options.store.putInstallJob(next);options.changed();return next;}
  async function plan(id:CatalogId,requestId:string,method?:OfficialMethod,makeDefault=false):Promise<void> {
    if(!isSupportedCli(id))throw new AppError('unsupported','cli_not_supported');
    if(running||planning)throw new AppError('busy','install_in_progress');
    planning=true;
    try{
    await readyInventory();
    const definition=catalogDefinitions.find(row=>row.id===id);if(!definition||!officialChoices(id,dependencies.platform??process.platform,dependencies.arch??process.arch).length)throw new AppError('unsupported','manual_install_required');
    if(options.store.removalJobs().some(job=>job.catalogId===id&&['removing','uncertain'].includes(job.stage)))throw new AppError('uncertain','inspect_interrupted_removal');
    if(options.store.installJobs().some(job=>job.catalogId===id&&job.stage==='uncertain'))throw new AppError('uncertain','inspect_interrupted_install');
    const official=await (dependencies.planOfficial??planOfficialInstall)({...options,catalogId:id,...(method?{method}:{}),platform:dependencies.platform??process.platform,arch:dependencies.arch??process.arch});
    if(inventory.some(row=>row.catalogId===id&&row.path===official.executable))throw new AppError('conflict','official_destination_exists');
    const jobId=randomUUID();const now=Date.now();
    options.store.putInstallJob({id:jobId,requestId,catalogId:id,revision:0,stage:'ready',sourceUrl:official.sourceUrl,method:official.method,official,makeDefault,
      previousInstallationId:entries().find(row=>row.id===id)?.selectedInstallationId??null,
      target:official.target,recipeHash:official.recipeHash,
      createdAt:now,updatedAt:now,installedVersion:null,executablePath:null,failure:null,log:[]});options.changed();
    }finally{planning=false;}
  }
  async function confirm(id:string,revision:number):Promise<void> {
    if(running||planning)throw new AppError('busy','install_in_progress');
    planning=true;
    try{
    await readyInventory();
    const job=getJob(id);if(!isSupportedCli(job.catalogId))throw new AppError('unsupported','cli_not_supported');
    if(job.revision!==revision||job.stage!=='ready')throw new AppError('conflict','stale_install_plan');
    if(!catalogDefinitions.find(row=>row.id===job.catalogId)?.recipe)throw new AppError('source_changed','install_recipe_changed');
    if(options.store.removalJobs().some(row=>row.catalogId===job.catalogId&&['removing','uncertain'].includes(row.stage)))throw new AppError('uncertain','inspect_interrupted_removal');
    if(options.store.installJobs().some(row=>row.catalogId===job.catalogId&&row.stage==='uncertain'))throw new AppError('uncertain','inspect_interrupted_install');
    if(!job.official)throw new AppError('source_changed','install_recipe_changed');
    if((entries().find(row=>row.id===job.catalogId)?.selectedInstallationId??null)!==job.previousInstallationId)
      throw new AppError('conflict','installation_selection_changed');
    const official=await (dependencies.planOfficial??planOfficialInstall)({...options,catalogId:job.catalogId,method:job.official.method,platform:dependencies.platform??process.platform,arch:dependencies.arch??process.arch});
    if(JSON.stringify(officialPlanSchema.parse(official))!==JSON.stringify(officialPlanSchema.parse(job.official)))throw new AppError('source_changed','install_recipe_changed');
    // Freeze the current choice so discovery of a partial new install cannot adopt it.
    if(job.previousInstallationId)options.store.selectCatalogInstallation(job.catalogId,job.previousInstallationId);
    change(id,{stage:'installing',failure:null,log:[]});
    running=(async()=>{
      try{
        const installedVersion=await (dependencies.executeOfficial??executeOfficialInstall)(official,options,event=>{
          const current=getJob(id);
          if(current.log.at(-1)===event)return;
          change(id,{log:[...current.log,event].slice(-100)});
        });
        change(id,{stage:'verifying',log:[...getJob(id).log,'verification_started'].slice(-100)});
        const executablePath=official.executable;
        await scan();
        const installation=inventory.find(row=>row.catalogId===job.catalogId&&row.path===executablePath&&row.manager!=='owned');
        if(!installation)throw new AppError('uncertain','official_installation_not_discovered');
        if(options.adoptInstallation)await options.adoptInstallation(job.catalogId,{...installation,version:installedVersion},job.makeDefault??false);
        else options.store.selectCatalogInstallation(job.catalogId,installation.id);
        change(id,{stage:'completed',installedVersion,executablePath,log:[...getJob(id).log,'installation_verified'].slice(-100)});
      }catch(error){
        if(!(error instanceof Error))throw error;
        change(id,{stage:'uncertain',failure:error instanceof AppError?error.detail:'install_failed'});
      }
    })().finally(()=>{running=null;void scan();options.changed();});
    }finally{planning=false;}
  }
  async function recover(id:string,revision:number,action:'inspect'|'archive'):Promise<void> {
    if(running||planning)throw new AppError('busy','install_in_progress');
    const job=getJob(id);
    if(!isSupportedCli(job.catalogId))throw new AppError('unsupported','cli_not_supported');
    if(job.revision!==revision||!['failed','uncertain'].includes(job.stage))throw new AppError('conflict','stale_install_plan');
    if(job.official){
      if(action==='archive')throw new AppError('unsupported','official_installation_use_manager');
      planning=true;
      try{
        await scan();
        if((entries().find(row=>row.id===job.catalogId)?.selectedInstallationId??null)!==job.previousInstallationId)
          throw new AppError('conflict','installation_selection_changed');
        const installation=inventory.find(row=>row.catalogId===job.catalogId&&row.path===job.official?.executable&&row.manager!=='owned');
        if(!installation)throw new AppError('unavailable','official_installation_not_discovered');
        const output=await runProcess(installation.path,['--version'],{HOME:options.home,PATH:options.path,CI:'1',NO_COLOR:'1',MUSE_NO_AUTO_UPDATE:'1',MUSE_LOGIN:'0',DISABLE_AUTOUPDATER:'1',OPENCODE_DISABLE_AUTOUPDATE:'1'},options.home,15_000);
        const installedVersion=parseCliVersion(output);
        if(!installedVersion)throw new AppError('unavailable','installed_version_unverified');
        if(options.adoptInstallation)await options.adoptInstallation(job.catalogId,{...installation,version:installedVersion},job.makeDefault??false);
        else options.store.selectCatalogInstallation(job.catalogId,installation.id);
        change(id,{stage:'completed',failure:null,installedVersion,executablePath:installation.path});
      }finally{planning=false;options.changed();}
      return;
    }
    const definition=catalogDefinitions.find(row=>row.id===job.catalogId);
    if(!definition?.recipe)throw new AppError('unsupported','manual_install_required');
    if(createHash('sha256').update(JSON.stringify(definition.recipe)).digest('hex')!==job.recipeHash)
      throw new AppError('source_changed','install_recipe_changed');
    if(job.target!==join(root,`${job.catalogId}-${job.id}`))throw new AppError('invalid_request','install_target_changed');
    const recipe=definition.recipe;
    const guard=()=>{
      const current=getJob(id);
      if(current.revision!==revision||current.target!==job.target||current.catalogId!==job.catalogId||current.recipeHash!==job.recipeHash)
        throw new AppError('conflict','stale_install_plan');
      if(options.store.installJobs().some(row=>['installing','verifying'].includes(row.stage)))throw new AppError('busy','install_in_progress');
      if(options.store.removalJobs().some(row=>row.stage==='removing'||(row.catalogId===job.catalogId&&row.stage==='uncertain')))
        throw new AppError('busy','removal_in_progress');
      let rows:ReturnType<typeof readProcesses>;
      try{rows=(dependencies.processes??readProcesses)();}
      catch(error){if(!(error instanceof Error))throw error;throw new AppError('unavailable','process_observation_unavailable');}
      if(rows.some(row=>row.command.includes(job.target)))throw new AppError('busy','recovery_target_in_use');
      const rootInfo=lstatSync(root);
      if(!rootInfo.isDirectory()||rootInfo.isSymbolicLink()||realpathSync(root)!==root)
        throw new AppError('invalid_request','recovery_root_unsafe');
      const info=lstatSync(job.target,{throwIfNoEntry:false});
      if(info&&(!info.isDirectory()||info.isSymbolicLink()||realpathSync(job.target)!==job.target))
        throw new AppError('invalid_request','recovery_target_unsafe');
      return info;
    };
    running=Promise.resolve().then(async()=>{
      const before=guard();
      if(!before){change(id,{stage:'failed',failure:'recovery_target_missing',installedVersion:null,executablePath:null});return;}
      switch(action){
        case 'archive':{
          const archivePath=join(root,`.recovered-${job.id}`);
          if(lstatSync(archivePath,{throwIfNoEntry:false}))throw new AppError('conflict','recovery_archive_exists');
          const after=guard();
          if(!after||after.dev!==before.dev||after.ino!==before.ino)throw new AppError('uncertain','recovery_target_changed');
          renameSync(job.target,archivePath);
          change(id,{stage:'failed',failure:'installation_archived',archivePath,installedVersion:null,executablePath:null});
          return;
        }
        case 'inspect':{
          try{
            const executablePath=recipeExecutable(recipe,job.target);
            if(!existsSync(executablePath))throw new AppError('unavailable','installed_executable_missing');
            const canonical=realpathSync(executablePath);
            if(!canonical.startsWith(job.target+'/')||!lstatSync(canonical).isFile())
              throw new AppError('invalid_request','installed_executable_outside_target');
            const installedVersion=await (dependencies.verify??verifyExecutable)(executablePath,{home:options.home,path:options.path,target:job.target});
            const after=guard();
            if(!after||after.dev!==before.dev||after.ino!==before.ino||realpathSync(executablePath)!==canonical)
              throw new AppError('uncertain','recovery_target_changed');
            change(id,{stage:'completed',failure:null,installedVersion,executablePath});
          }catch(error){
            if(!(error instanceof Error))throw error;
            change(id,{stage:'uncertain',failure:error instanceof AppError?error.detail:'recovery_verification_failed',installedVersion:null,executablePath:null});
          }
          return;
        }
      }
    }).finally(()=>{running=null;void scan();versions.refresh();options.changed();});
    await running;
  }
  void scan();
  return {entries,plan,confirm,recover,select,refresh:()=>{versions.refresh();void scan();},busy:()=>running!==null||planning,
    settled:async()=>{await running;await scanning;entries();await versions.settled();}};
}
