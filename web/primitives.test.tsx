import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Theme, parseTheme } from './primitives';

test('stored appearance rejects unsupported preferences', () => {
  expect(parseTheme(null)).toBe('system');
  expect(parseTheme('invalid')).toBe('system');
  expect(parseTheme('dark')).toBe('dark');
  expect(parseTheme('light')).toBe('light');
});

test('appearance offers one native radio group with all modes', () => {
  const markup = renderToStaticMarkup(<Theme />);
  const inputs = [...markup.matchAll(/<input\b[^>]*>/g)].map(match=>match[0]);
  expect(inputs).toHaveLength(3);
  expect(inputs.every(input=>input.includes('type="radio"'))).toBe(true);
  expect(new Set(inputs.map(input=>input.match(/name="([^"]+)"/)?.[1])).size).toBe(1);
  expect(inputs.map(input=>input.match(/value="([^"]+)"/)?.[1])).toEqual(['light','dark','system']);
  expect(inputs.filter(input=>input.includes('checked=""'))).toHaveLength(1);
});
