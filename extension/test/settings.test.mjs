import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../settings.js', import.meta.url), 'utf8');
const { isValidBridgeUrl, normalize, DEFAULTS } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`,
);

test('accepts only bridge URLs covered by host permissions', () => {
  for (const url of [
    'http://localhost:4500/capture',
    'http://127.0.0.1:4500/capture',
  ]) {
    assert.equal(isValidBridgeUrl(url), true, url);
  }

  for (const url of [
    'http://[::1]:4500/capture',
    'https://localhost:4500/capture',
    'http://bridge.example/capture',
  ]) {
    assert.equal(isValidBridgeUrl(url), false, url);
  }
});

test('keeps per-kind capture modes within the known set', () => {
  const modes = ['teamsChatsMode', 'teamsChannelsMode', 'teamsMeetingsMode'];

  for (const key of modes) {
    for (const value of ['off', 'mentions', 'all']) {
      assert.equal(normalize({ [key]: value })[key], value, `${key}=${value}`);
    }
    // Storage can hold whatever an older build wrote, so anything unrecognised
    // has to fall back rather than reach the capture script.
    for (const bad of ['ALL', 'everything', '', null, 3, undefined]) {
      assert.equal(normalize({ [key]: bad })[key], DEFAULTS[key], `${key}=${String(bad)}`);
    }
  }
});

test('defaults page for chats, mentions in channels, nothing for meetings', () => {
  const s = normalize({});
  assert.equal(s.teamsChatsMode, 'all');
  assert.equal(s.teamsChannelsMode, 'mentions');
  assert.equal(s.teamsMeetingsMode, 'off');
  assert.equal(s.teamsMuteSelf, true);
});
