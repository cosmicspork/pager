import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

class FakeEventTarget {
  #listeners = new Map();

  addEventListener(type, listener, options) {
    const capture = typeof options === 'boolean' ? options : !!options?.capture;
    const listeners = this.#listeners.get(type) || [];
    if (!listeners.some((entry) => entry.listener === listener && entry.capture === capture)) {
      listeners.push({ listener, capture });
      this.#listeners.set(type, listeners);
    }
  }

  removeEventListener(type, listener, options) {
    const capture = typeof options === 'boolean' ? options : !!options?.capture;
    const listeners = this.#listeners.get(type) || [];
    this.#listeners.set(type, listeners.filter((entry) => entry.listener !== listener || entry.capture !== capture));
  }

  dispatchEvent(event) {
    event.target ||= this;
    for (const { listener } of [...(this.#listeners.get(event.type) || [])]) {
      listener.call(this, event);
      if (event.immediatePropagationStopped) break;
    }
  }
}

class FakeDocument extends FakeEventTarget {
  hasFocus() {
    return false;
  }
}

function event(type, init = {}) {
  return {
    type,
    ...init,
    immediatePropagationStopped: false,
    stopImmediatePropagation() {
      this.immediatePropagationStopped = true;
    },
  };
}

async function installMask() {
  Object.defineProperties(FakeDocument.prototype, {
    hidden: { configurable: true, get: () => true },
    visibilityState: { configurable: true, get: () => 'hidden' },
    onvisibilitychange: { configurable: true, get: () => null, set: () => {} },
  });

  const window = new FakeEventTarget();
  const document = new FakeDocument();
  const context = vm.createContext({
    Document: FakeDocument,
    EventTarget: FakeEventTarget,
    window,
    document,
  });
  const source = await readFile(new URL('../keep-active-mask.js', import.meta.url), 'utf8');
  vm.runInContext(source, context);
  return { window, document };
}

test('suppresses lifecycle notifications only while masking is enabled', async () => {
  const { window, document } = await installMask();
  let visibilityChanges = 0;
  let blurs = 0;

  document.addEventListener('visibilitychange', () => visibilityChanges++);
  window.addEventListener('blur', () => blurs++, true);

  document.dispatchEvent(event('visibilitychange'));
  window.dispatchEvent(event('blur'));
  assert.equal(visibilityChanges, 0);
  assert.equal(blurs, 0);

  window.dispatchEvent(event('message', {
    source: window,
    data: {
      __pagerControl: true,
      control: 'config',
      config: { keepActive: false, keepActiveMask: false },
    },
  }));

  document.dispatchEvent(event('visibilitychange'));
  window.dispatchEvent(event('blur'));
  assert.equal(visibilityChanges, 1);
  assert.equal(blurs, 1);
});

test('leaves focus and blur alone when they are only passing through window', async () => {
  const { window } = await installMask();
  const element = {};
  let elementFocuses = 0;
  let elementBlurs = 0;
  let windowBlurs = 0;

  window.addEventListener('focus', () => elementFocuses++, true);
  window.addEventListener('blur', (ev) => (ev.target === window ? windowBlurs++ : elementBlurs++), true);

  // An element's focus/blur reaches it through the capture phase on window.
  // Blocking those would take out focus handling for the whole page.
  window.dispatchEvent(event('focus', { target: element }));
  window.dispatchEvent(event('blur', { target: element }));
  assert.equal(elementFocuses, 1);
  assert.equal(elementBlurs, 1);

  // The window's own blur is the presence signal, and stays suppressed.
  window.dispatchEvent(event('blur'));
  assert.equal(windowBlurs, 0);
});
