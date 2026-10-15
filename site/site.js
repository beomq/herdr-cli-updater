import { detectPlatform, installPresentation } from './platform.js';

function showPlatform(platform) {
  const presentation = installPresentation(platform);
  for (const node of document.querySelectorAll('[data-platform-panel]')) {
    if (node.dataset.platformPanel === (platform ?? 'all')) node.hidden = false;
    else node.remove();
  }
  for (const node of document.querySelectorAll('[data-install-shell]')) node.textContent = presentation.shell;
  for (const node of document.querySelectorAll('[data-install-note]')) node.textContent = presentation.note;
  for (const code of document.querySelectorAll('[data-install-command]')) {
    code.textContent = presentation.command;
    code.closest('.command-block').hidden = !presentation.command;
  }
  for (const button of document.querySelectorAll('[data-copy]')) button.textContent = 'Copy';
  for (const status of document.querySelectorAll('.copy-feedback')) status.textContent = '';
}
showPlatform(detectPlatform(navigator.userAgentData?.platform ?? navigator.platform, navigator.userAgent, navigator.maxTouchPoints));

for (const button of document.querySelectorAll('[data-copy]')) {
  button.hidden = false;
  button.addEventListener('click', async () => {
    const code = document.getElementById(button.dataset.copy);
    const status = document.querySelector('.copy-feedback');
    try {
      await navigator.clipboard.writeText(code.textContent);
      button.textContent = 'Copied';
      status.textContent = 'Command copied. Review the paths before running it.';
    } catch {
      button.textContent = 'Select text';
      const range = document.createRange();
      range.selectNodeContents(code);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      status.textContent = 'Clipboard unavailable. The command is selected; copy it manually.';
    }
  });
}
