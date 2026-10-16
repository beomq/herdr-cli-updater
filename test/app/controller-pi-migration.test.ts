import { test } from 'bun:test';
import { migrationScenario } from './controller-pi-migration';

test.each(['npm','bun','owned'] as const)('pauses stored %s Senpi binding without reinterpreting policy or stale actions',async kind=>{
  await migrationScenario(kind);
});
test('keeps explicit check and restart preferences while pausing the old source',async()=>{
  await migrationScenario('npm','check');
  await migrationScenario('owned','update-and-restart');
});
test('preserves an explicitly disabled Senpi policy',async()=>{
  await migrationScenario('bun','off');
});
test('rejects old ready actions when discovery disappears',async()=>{
  await migrationScenario('npm','update',false);
});
