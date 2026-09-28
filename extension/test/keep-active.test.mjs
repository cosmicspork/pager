import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../keep-active.js', import.meta.url), 'utf8');

test('presence starts inert, follows live config, and duplicate injection adds no timer', () => {
  let time = 1_800_000_000_000;
  const pulses = [];
  const listeners = [];
  const timers = [];
  const window = { addEventListener(type, callback) { if (type === 'message') listeners.push(callback); } };
  const sandbox = {
    window, document: { dispatchEvent(event) { pulses.push(event.type); } },
    location: { origin: 'https://teams.microsoft.com' },
    Date: class extends Date { static now() { return time; } },
    MouseEvent: class { constructor(type) { this.type = type; } },
    KeyboardEvent: class { constructor(type) { this.type = type; } },
    Math, Number, setInterval(fn) { timers.push(fn); },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  vm.runInContext(source, sandbox);
  assert.equal(listeners.length, 1);
  assert.equal(timers.length, 1);
  const config = (keepActive) => listeners[0]({ source: window, origin: 'https://teams.microsoft.com',
    data: { __pagerControl: true, control: 'config', config: { keepActive, keepActiveIntervalSec: 30 } } });
  time += 40000;
  timers[0]();
  assert.equal(pulses.length, 0);
  config(true);
  time += 30000;
  timers[0]();
  assert.deepEqual(pulses, ['mousemove', 'keydown', 'keyup']);
  config(false);
  time += 90000;
  timers[0]();
  assert.equal(pulses.length, 3);
  config(true);
  timers[0]();
  assert.equal(pulses.length, 3);
  time += 30000;
  timers[0]();
  assert.equal(pulses.length, 6);
});
