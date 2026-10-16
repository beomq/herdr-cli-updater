import type { AppCommand, AppSnapshot, PaneSessionPolicy } from '../src/app/types';

export function reviewSnapshot(paneSessions?:PaneSessionPolicy):AppSnapshot {
  return {serverInstance:'server-a',revision:1,service:'ready',failure:null,observedAt:1,
    installations:[{installationId:'engine',family:'omo',channel:'stable',executableRealpath:'/engine/omo',resourcesFingerprint:'resource-a',resources:[],
      owner:{kind:'package',manager:'bun',packageName:'omo-ai',prefix:'/engine'},installedVersion:{kind:'known',version:'1.0.0'},lastCheck:null}],
    managed:[],external:[],policies:paneSessions?[{installationId:'engine',mode:'check',intervalMinutes:60,lastCheckedAt:null,nextCheckAt:null,waitingReason:null,paneSessions}]:[],
    operations:[{id:'ready-engine',requestId:'fixture',installationId:'engine',kind:'update',stage:'ready',revision:1,targetVersion:'2.0.0',beforeVersion:'1.0.0',installedVersion:null,sessionIds:[],restart:false,createdAt:1,updatedAt:1,failure:null,detail:null,jobId:null}],
    catalog:[{id:'codex',name:'Codex',description:{ko:'',en:''},executable:'codex',sourceUrl:'https://example.test/codex',method:'npm',availability:'installable',reason:null,
      inventoryStatus:'ready',selectedInstallationId:'copy-a',installed:{path:'/catalog/codex',version:'1.0.0',managed:false}}],
    catalogUpdates:[{id:'uncertain-codex',requestId:'fixture',catalogId:'codex',installationId:'copy-a',revision:8,stage:'uncertain',target:{kind:'npm',target:'/catalog',executable:'/catalog/codex',manager:'/fixture/npm',packageName:'@openai/codex',fingerprint:'source-a',preserve:[]},beforeVersion:'1.0.0',installedVersion:null,createdAt:1,updatedAt:1,failure:null},
      {id:'active-omo',requestId:'fixture-other',catalogId:'omo',revision:1,stage:'updating',target:{kind:'npm',target:'/other',executable:'/other/omo',manager:'/fixture/npm',packageName:'omo-ai',fingerprint:'source-b',preserve:[]},beforeVersion:'1.0.0',installedVersion:null,createdAt:1,updatedAt:1,failure:null}],
  };
}

/** Real App/client with a recording HTTP boundary; never starts a product service. */
export async function serveReviewApp(initial:AppSnapshot) {
  const bundle=await Bun.build({entrypoints:[import.meta.dir+'/main.tsx'],target:'browser',define:{'process.env.NODE_ENV':'"production"'}});
  if(!bundle.success)throw new Error('App bundle failed: '+bundle.logs.join('\n'));
  const assets=new Map(bundle.outputs.map(asset=>['/'+asset.path.split('/').at(-1),asset]));
  const script=bundle.outputs.find(asset=>asset.kind==='entry-point');
  if(!script)throw new Error('App entry point missing');
  let snapshot=initial;
  const commands:AppCommand[]=[];
  const streams=new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder=new TextEncoder();
  let connected:()=>void=()=>{};
  let connection=new Promise<void>(resolve=>{connected=resolve;});
  const publish=(next:AppSnapshot)=>{snapshot=next;for(const stream of streams)stream.enqueue(encoder.encode('event: snapshot\ndata: '+JSON.stringify(snapshot)+'\n\n'));};
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
    const path=new URL(request.url).pathname;
    if(path==='/api/state')return Response.json(snapshot);
    if(path==='/api/events')return new Response(new ReadableStream<Uint8Array>({start(controller){streams.add(controller);connected();},cancel(){streams.clear();}}),{headers:{'content-type':'text/event-stream'}});
    if(path==='/api/command'&&request.method==='POST'){
      const envelope:{command:AppCommand}=await request.json();commands.push(envelope.command);
      return Response.json({ok:true,snapshot});
    }
    if(path==='/fixture/publish'&&request.method==='POST'){publish(await request.json());return new Response(null,{status:204});}
    if(path==='/favicon.ico')return new Response(null,{status:204});
    if(path==='/assets/symbol-sheep.png')return new Response(Bun.file(import.meta.dir+'/assets/symbol-sheep.png'));
    const asset=assets.get(path);if(asset)return new Response(asset);
    if(path!=='/')return new Response(null,{status:404});
    return new Response('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">'+[...assets.keys()].filter(key=>key.endsWith('.css')).map(key=>'<link rel="stylesheet" href="'+key+'">').join('')+'</head><body><div id="root"></div><script>localStorage.setItem("cli-language","en");localStorage.setItem("cli-view","updates");</script><script type="module" src="/'+script.path.split('/').at(-1)+'"></script></body></html>',{headers:{'content-type':'text/html'}});
  }});
  return {url:'http://127.0.0.1:'+server.port,commands,publish,
    connected:()=>connection,
    reset(next:AppSnapshot){snapshot=next;commands.length=0;connection=new Promise<void>(resolve=>{connected=resolve;});},
    async close(){for(const stream of streams)stream.close();streams.clear();await server.stop(true);},
  };
}
