import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Select } from './select';

test('custom selection is a labelled combobox and never submits its form',()=>{
  const markup=renderToStaticMarkup(<Select label="SENTINEL" value="a" options={[{value:'a',label:'A'},{value:'b',label:'B'}]} onChange={()=>{}}/>);
  expect(markup).toContain('role="combobox"');
  expect(markup).toContain('type="button"');
  expect(markup).toContain('aria-expanded="false"');
  expect(markup).not.toContain('<select');
  expect(markup).not.toContain('role="listbox"');
});

test('empty and disabled option lists cannot be opened',()=>{
  const markup=renderToStaticMarkup(<Select label="SENTINEL" value="a" options={[{value:'a',label:'A',disabled:true}]} onChange={()=>{}}/>);
  expect(markup).toContain('disabled=""');
});
