import './styles.css';
document.documentElement.dataset['input'] = 'pointer';
document.addEventListener('pointerdown', () => { document.documentElement.dataset['input'] = 'pointer'; }, true);
document.addEventListener('keydown', event => {
  if (!event.metaKey && !event.ctrlKey && !event.altKey) document.documentElement.dataset['input'] = 'keyboard';
}, true);
if (process.env.NODE_ENV === 'development') {
  await import('react-grab');
  const { instrument } = await import('react-scan/lite');
  instrument({ recordChangeDescriptions: true, includeFiberIdentity: true });
}
const [{ createRoot }, { App }] = await Promise.all([import('react-dom/client'), import('./app')]);
const root = document.getElementById('root');
if (!root) throw new DOMException('Application root is missing', 'InvalidStateError');
createRoot(root).render(<App />);
