import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import metadata from '../package.json';
import { githubRepository, productVersion, websiteUrl } from './product';
import { Brand, ProjectLinks } from './primitives';
import { AgentMark } from './agent-mark';
import { catalogIds } from '../src/app/catalog-types';

test('product version follows the shipped package metadata',()=>{
  expect(productVersion).toBe(metadata.version);
  expect(renderToStaticMarkup(<Brand/>)).toContain(`v${metadata.version}`);
});
test('brand opens the separate public website without navigating the workspace',()=>{
  const html=renderToStaticMarkup(<Brand/>);
  expect(html).toContain(`href="${websiteUrl}"`);
  expect(html).toContain('target="_blank"');
  expect(html).toContain('rel="noopener noreferrer"');
  expect(html).not.toContain('/welcome');
});
test('repository links accept only GitHub repository URLs',()=>{
  expect(githubRepository({url:'git+https://github.com/owner/project.git'})).toBe('https://github.com/owner/project');
  expect(githubRepository('https://github.com/owner/project')).toBe('https://github.com/owner/project');
  for(const value of [null,{},'javascript:alert(1)','https://github.com','https://other.test/owner/project','https://github.com/owner/project/issues'])expect(githubRepository(value)).toBeNull();
});
test('project actions expose one repository link and an unfilled initial star',()=>{
  const html=renderToStaticMarkup(<ProjectLinks/>);
  expect((html.match(/<a /g)??[]).length).toBe(1);
  expect(html).toContain('href="https://github.com/beomq/herdr-cli-updater"');
  expect(html).toContain('data-clicked="false"');
  expect(html).toContain('class="project-star" viewBox="0 0 24 24" fill="none"');
});
test('all catalog identities render a local mark with no remote image dependency',()=>{
  for(const id of catalogIds){
    const html=renderToStaticMarkup(<AgentMark agent={id}/>);
    expect(html).toContain('<svg');
    expect(html).toContain(`aria-label="${id}"`);
    expect(html).not.toMatch(/(?:href|src)="https?:/);
  }
});
test('Letta renders its vector symbol rather than a letter fallback',()=>{
  const html=renderToStaticMarkup(<AgentMark agent="letta"/>);
  expect(html).toContain('<path');
  expect(html).not.toContain('<text');
});
