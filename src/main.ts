import './styles.css';
import { Game } from './Game';

async function bootstrap(): Promise<void> {
  const viewport = document.getElementById('viewport');
  const uiRoot = document.getElementById('ui');

  if (!viewport || !uiRoot) {
    throw new Error('Application root elements are missing.');
  }

  const game = new Game(viewport, uiRoot);
  window.__DIWALI_GAME__ = game;

  try {
    await game.init();
  } catch (error) {
    showFatal(error);
    throw error;
  }
}

function showFatal(error: unknown): void {
  document.getElementById('loading')?.remove();
  document.querySelector('.fatal')?.remove();

  const message = error instanceof Error ? error.message : String(error);
  const fatal = document.createElement('div');
  fatal.className = 'fatal';

  const inner = document.createElement('div');
  inner.className = 'fatal-inner';

  const mark = document.createElement('div');
  mark.className = 'eyebrow';
  mark.textContent = 'The flight could not begin';

  const title = document.createElement('h2');
  title.textContent = 'The lights would not catch.';

  const copy = document.createElement('p');
  copy.textContent =
    'This experience needs a browser with WebGL 2 enabled. Try the latest Chrome, Edge, Firefox or Safari.';

  const detail = document.createElement('p');
  detail.style.marginTop = '14px';
  const code = document.createElement('code');
  code.textContent = message;
  detail.appendChild(code);

  inner.append(mark, title, copy, detail);
  fatal.appendChild(inner);
  document.body.appendChild(fatal);
}

window.addEventListener('diwali:context-lost', () => {
  showFatal(new Error('The WebGL context was lost. Reload the page to relight the mohalla.'));
});

bootstrap().catch((error: unknown) => {
  console.error('[Diwali Night] Boot failed:', error);
});

declare global {
  interface Window {
    __DIWALI_GAME__?: Game;
  }
}
