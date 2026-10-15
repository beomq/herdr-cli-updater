import metadata from '../package.json';

export function githubRepository(value: unknown): string | null {
  const raw = typeof value === 'string' ? value : value && typeof value === 'object' && 'url' in value ? value.url : null;
  if (typeof raw !== 'string') return null;
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(raw.replace(/^git\+/, ''));
  return match ? `https://github.com/${match[1]}/${match[2]}` : null;
}
export const productVersion = metadata.version;
export const websiteUrl = 'https://herdr-cli-updater.vercel.app/';
export const repositoryUrl = githubRepository('repository' in metadata ? metadata.repository : null);
