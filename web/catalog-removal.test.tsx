import { expect,test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { RemovalActions } from './catalog-removal';
import type { AppSnapshot } from '../src/app/types';
test('unsupported dependency removal is explained and cannot submit an action',()=>{
  let calls=0;
  const snapshot:AppSnapshot={revision:1,service:'ready',failure:null,installations:[],managed:[],external:[],operations:[],policies:[],catalog:[{
    id:'pi',name:'Pi',description:{ko:'',en:''},executable:'pi',sourceUrl:'https://example.test/pi',method:'npm',availability:'installable',reason:null,
    selectedInstallationId:'dependent',installed:{path:'/home/node_modules/.bin/pi',version:'1.0.0',managed:false},
    installations:[{id:'dependent',catalogId:'pi',manager:'unknown',root:'/home/node_modules',path:'/home/node_modules/.bin/pi',identityPath:'/home/node_modules/senpi/cli.js',packageName:null,isDefault:true,receiptId:null,version:'1.0.0',removalSupport:{kind:'unsupported',reason:'removal_dependency_installation'}}],
  }]};
  const markup=renderToStaticMarkup(<RemovalActions snapshot={snapshot} catalogId="pi" disabled={false} act={async()=>{calls++;return true;}}/>);
  expect(markup).toContain('data-removal-reason="removal_dependency_installation"');
  expect(markup).toMatch(/<button[^>]*disabled=""/);
  expect(markup).toContain('aria-haspopup="dialog"');expect(calls).toBe(0);
});
