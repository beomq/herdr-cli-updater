export function detectPlatform(platform, userAgent, maxTouchPoints = 0) {
  const hint = `${platform} ${userAgent}`;
  if (/Android|iPhone|iPad|iPod/i.test(hint)) return null;
  if (/MacIntel/i.test(platform) && maxTouchPoints > 1) return null;
  if (/Windows|Win32|Win64/i.test(hint)) return 'win32';
  if (/Macintosh|MacIntel|macOS/i.test(hint)) return 'darwin';
  if (/Linux/i.test(hint)) return 'linux';
  return null;
}

export function installPresentation(platform) {
  switch (platform) {
    case 'darwin': return { shell: 'macOS detected · Run in Terminal', command: 'curl -fsSL https://herdr-cli-updater.vercel.app/install.sh | sh', note: 'Bun 1.4.2+ and Node.js 24+ required. Installation verified on Apple Silicon.' };
    case 'linux': return { shell: 'Linux detected · Run in your terminal', command: 'curl -fsSL https://herdr-cli-updater.vercel.app/install.sh | sh', note: 'Linux x64 / arm64 · Bun 1.4.2+ and Node.js 24+ required. Installers are selected for Linux; end-to-end Linux execution has not yet been verified.' };
    case 'win32': return { shell: 'Windows detected · Run inside WSL2', command: 'curl -fsSL https://herdr-cli-updater.vercel.app/install.sh | sh', note: 'Native Windows is not supported. Open an existing WSL2 Linux distribution and install Bun and Node there, then run this command inside WSL — not PowerShell. The app manages the Linux environment only.' };
    default: return { shell: 'Install on macOS, Linux or Windows (WSL2)', command: 'curl -fsSL https://herdr-cli-updater.vercel.app/install.sh | sh', note: 'Run this command in a macOS or Linux terminal, or inside WSL2 on Windows — not PowerShell. Bun 1.4.2+ and Node.js 24+ are required. Explore our 24-CLI catalog; installation and update support vary by tool and OS.' };
  }
}
