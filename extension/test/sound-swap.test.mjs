import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../sound-swap.js', import.meta.url), 'utf8');
const CUSTOM = Buffer.from('custom-sound');

function page(hostname) {
  const listeners = [];
  const posted = [];
  const timers = [];
  class Response {
    constructor(url) { this.url = url; }
    async blob() { return 'original-blob'; }
    async arrayBuffer() { return 'original-buffer'; }
  }
  const origin = 'https://' + hostname;
  const window = {
    addEventListener(type, callback) { if (type === 'message') listeners.push(callback); },
    postMessage(data) { posted.push(data); },
  };
  const sandbox = {
    window, Response, Blob, URL, atob, Uint8Array, Promise,
    crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000000' },
    location: { hostname, origin },
    setTimeout(fn) { timers.push(fn); },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  const send = (data) => listeners.forEach((listener) => listener({ source: window, origin, data: { __pagerControl: true, ...data } }));
  const sound = { name: 'ping.mp3', type: 'audio/mpeg', size: CUSTOM.length, data: CUSTOM.toString('base64') };
  return { sandbox, Response, listeners, posted, timers, send, sound };
}

test('Outlook new-mail audio is replaced once the sound arrives; other responses are untouched', async () => {
  const tab = page('outlook.cloud.microsoft');
  assert.deepEqual({ ...tab.posted[0].request }, { type: 'pager-sound-get', source: 'outlook' });
  const mail = new tab.Response('https://res.public.onecdn.static.microsoft/owamail/20261023003.14/resources/sounds/notifications/newmail.mp3');
  const pending = mail.arrayBuffer();
  tab.send({ control: 'sound', sound: tab.sound });
  assert.deepEqual(Buffer.from(await pending), CUSTOM);
  // Each read gets its own copy, since decodeAudioData detaches what it is given.
  assert.notEqual(await mail.arrayBuffer(), await mail.arrayBuffer());
  assert.equal(await new tab.Response('https://outlook.cloud.microsoft/owa/service.svc').arrayBuffer(), 'original-buffer');
});

test('Teams message sound is replaced on blob(); ringtones and other audio are not', async () => {
  const tab = page('teams.cloud.microsoft');
  tab.send({ control: 'response', requestId: tab.posted[0].requestId, response: { ok: true, sound: tab.sound } });
  const base = 'https://teams.public.onecdn.static.microsoft/evergreen-assets/audio/';
  const blob = await new tab.Response(base + '00_teams_basic_notification_r4_default.mp3').blob();
  assert.equal(blob.type, 'audio/mpeg');
  assert.deepEqual(Buffer.from(await blob.arrayBuffer()), CUSTOM);
  assert.equal(await new tab.Response(base + 'call_ringtone_notification.mp3').blob(), 'original-blob');
  assert.equal(await new tab.Response(base + 'teams_default_ringtone.mp3').blob(), 'original-blob');
});

test('no sound, or no answer from the extension, falls through to the original', async () => {
  const off = page('teams.microsoft.com');
  off.send({ control: 'sound', sound: null });
  const url = 'https://teams.public.onecdn.static.microsoft/evergreen-assets/audio/00_teams_basic_notification_r4_default.mp3';
  assert.equal(await new off.Response(url).blob(), 'original-blob');

  const silent = page('teams.microsoft.com');
  const pending = new silent.Response(url).blob();
  assert.equal(silent.timers.length, 1);
  silent.timers[0]();
  assert.equal(await pending, 'original-blob');
});

test('a second injection does not patch twice, and other hosts are left alone', () => {
  const tab = page('outlook.office.com');
  const patched = tab.Response.prototype.arrayBuffer;
  vm.runInContext(source, tab.sandbox);
  assert.equal(tab.Response.prototype.arrayBuffer, patched);
  assert.equal(tab.listeners.length, 1);

  const other = page('example.com');
  assert.equal(other.listeners.length, 0);
  assert.equal(other.posted.length, 0);
});
