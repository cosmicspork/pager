import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../settings.js', import.meta.url), 'utf8');
const { isValidBridgeUrl } = await import(
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
