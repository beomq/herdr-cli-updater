import { expect, test } from 'bun:test';
// Browser JS is exercised directly so the shipped selector and test cannot diverge.
const { detectPlatform, installPresentation } = await import('../../site/platform.js');

test.each([
  ['Win32','Mozilla Windows NT 10.0','win32'],
  ['Windows','','win32'],
  ['MacIntel','Mozilla Macintosh','darwin'],
  ['Linux x86_64','Mozilla X11 Linux','linux'],
  ['Linux armv8l','Mozilla Android',null],
  ['iPhone','Mozilla iPhone',null],
  ['','unknown',null],
])('browser hint %s chooses the appropriate platform', (platform,agent,expected)=>{
  expect(detectPlatform(platform,agent)).toBe(expected);
});
test('mobile and unrecognized devices retain the public POSIX setup command',()=>{
  for(const platform of [detectPlatform('iPhone','Mozilla iPhone'),detectPlatform('Linux armv8l','Mozilla Android'),null]){
    expect(installPresentation(platform).command).toBe('curl -fsSL https://herdr-cli-updater.vercel.app/install.sh | sh');
  }
});
test('iPad desktop browsing does not silently select a macOS installer',()=>{
  expect(detectPlatform('MacIntel','Mozilla Macintosh',5)).toBeNull();
});
test.each(['darwin','linux','win32'])('supported instruction choice %s keeps the published installer URL',platform=>{
  expect(installPresentation(platform).command).toBe('curl -fsSL https://herdr-cli-updater.vercel.app/install.sh | sh');
});
