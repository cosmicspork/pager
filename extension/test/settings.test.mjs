import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../settings.js', import.meta.url), 'utf8');
const { isValidBridgeUrl, normalize, parseTime, isWithinWindows, effectiveSchedule, nextScheduleChange, getSettings, validSound } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`,
);

const local = (hour, minute = 0) => new Date(2026, 5, 10, hour, minute);
const scheduled = (pagingSilenceWindows, keepActiveWindows = []) => normalize({ pagingMode: 'scheduled', keepActiveMode: 'scheduled', pagingSilenceWindows, keepActiveWindows });

test('collector and bridge URLs remain restricted to credential-free loopback capture endpoints', () => {
  assert.equal(isValidBridgeUrl('http://localhost:4500/capture'), true);
  for (const value of ['http://bridge.example/capture', 'https://localhost:4500/capture', 'http://user:password@localhost:4500/capture',
    'http://localhost:4500/other', 'http://localhost:4500/capture?forward=https://example.com']) {
    assert.equal(isValidBridgeUrl(value), false, value);
  }
});

test('daily windows include start, exclude end, unite overlaps and support overnight', () => {
  const windows = [{ start: '08:00', end: '12:00' }, { start: '12:00', end: '17:00' }];
  assert.equal(parseTime('08:00'), 480);
  assert.equal(parseTime('8:00'), null);
  assert.equal(isWithinWindows(windows, local(8)), true);
  assert.equal(isWithinWindows(windows, local(12)), true);
  assert.equal(isWithinWindows(windows, local(17)), false);
  assert.equal(nextScheduleChange(scheduled(windows), local(10)).getHours(), 17);
  assert.equal(isWithinWindows([{ start: '22:00', end: '07:00' }], local(23)), true);
  assert.equal(isWithinWindows([{ start: '22:00', end: '07:00' }], local(6, 59)), true);
  assert.equal(isWithinWindows([{ start: '22:00', end: '07:00' }], local(7)), false);
});

test('paging silence, active presence, and capture toggles are independent; overrides persist', () => {
  const settings = scheduled([{ start: '08:00', end: '12:00' }, { start: '13:00', end: '17:00' }], [{ start: '08:00', end: '12:00' }]);
  settings.captureTeams = false;
  assert.deepEqual(effectiveSchedule(settings, local(9)), { pagingAllowed: false, keepActive: true, pagingInvalid: false, keepActiveInvalid: false });
  assert.deepEqual(effectiveSchedule(settings, local(12)), { pagingAllowed: true, keepActive: false, pagingInvalid: false, keepActiveInvalid: false });
  assert.equal(nextScheduleChange(settings, local(12)).getHours(), 13);
  assert.deepEqual(effectiveSchedule(normalize({ pagingMode: 'always_notify', keepActiveMode: 'always_off' }), local(9)).pagingAllowed, true);
  assert.equal(effectiveSchedule(normalize({ pagingMode: 'always_silent', keepActiveMode: 'always_on' }), local(9)).keepActive, true);
  assert.equal(nextScheduleChange(normalize({ pagingMode: 'always_notify', keepActiveMode: 'always_off' }), local(9)), null);
});

test('invalid persisted schedule fails closed independently with visible reason', () => {
  const badPaging = normalize({ pagingMode: 'unrecognized', keepActiveMode: 'always_on' });
  assert.equal(effectiveSchedule(badPaging, local(9)).pagingAllowed, false);
  assert.equal(effectiveSchedule(badPaging, local(9)).keepActive, true);
  assert.equal(badPaging.pagingInvalid, true);
  const badActivity = normalize({ keepActiveMode: 'always_on', keepActiveWindows: [{ start: '08:00', end: '08:00' }] });
  assert.equal(effectiveSchedule(badActivity, local(9)).keepActive, false);
  assert.equal(badActivity.keepActiveInvalid, true);
  assert.equal(effectiveSchedule(scheduled([], []), local(9)).pagingAllowed, true);
  assert.equal(effectiveSchedule(scheduled([], []), local(9)).keepActive, false);
});

test('legacy presence migrates only if mode is absent; invalid explicit mode stays fail-closed', async () => {
  const persisted = { keepActive: true };
  globalThis.chrome = { storage: { sync: {
    get: async () => ({ ...persisted }),
    set: async (patch) => Object.assign(persisted, patch),
    remove: async (key) => { delete persisted[key]; },
  }, local: { get: async () => ({}) } } };
  assert.equal((await getSettings()).keepActiveMode, 'always_on');
  assert.equal(Object.hasOwn(persisted, 'keepActive'), false);
  persisted.keepActive = true;
  persisted.keepActiveMode = 'broken';
  const current = await getSettings();
  assert.equal(current.keepActiveMode, 'broken');
  assert.equal(effectiveSchedule(current).keepActive, false);
  assert.equal(persisted.keepActive, true);
  delete globalThis.chrome;
});

test('next boundary follows real instants through DST gaps and repeated hours', () => {
  if (process.env.TZ !== 'America/Chicago') return;
  const spring = scheduled([{ start: '02:30', end: '03:30' }]);
  const springNext = nextScheduleChange(spring, new Date(2026, 2, 8, 1, 59));
  assert.equal(springNext.getHours(), 3);
  assert.equal(springNext.getMinutes(), 0);
  const fall = scheduled([{ start: '01:30', end: '02:30' }]);
  const repeated = nextScheduleChange(fall, new Date(2026, 10, 1, 1, 45));
  assert.equal(repeated.getHours(), 1);
  assert.equal(repeated.getMinutes(), 0);
  const second = nextScheduleChange(fall, repeated);
  assert.equal(second.getHours(), 1);
  assert.equal(second.getMinutes(), 30);
});

test('mode defaults to simple for new installs and full where a collector token exists', async () => {
  for (const [local, expected] of [[{}, 'simple'], [{ collectorToken: 'secret' }, 'full']]) {
    const persisted = { keepActiveMode: 'always_off' };
    globalThis.chrome = { storage: {
      sync: { get: async () => ({ ...persisted }), set: async (patch) => Object.assign(persisted, patch) },
      local: { get: async () => ({ ...local }) },
    } };
    assert.equal((await getSettings()).mode, expected);
    assert.equal(persisted.mode, expected);
  }
  const persisted = { mode: 'full', keepActiveMode: 'always_off' };
  globalThis.chrome = { storage: {
    sync: { get: async () => ({ ...persisted }), set: async () => assert.fail('explicit mode is not rewritten') },
    local: { get: async () => assert.fail('explicit mode does not consult the token') },
  } };
  assert.equal((await getSettings()).mode, 'full');
  delete globalThis.chrome;
});

test('simple mode masks capture and the debug probe but keeps the stored choices and sounds', () => {
  const simple = normalize({ mode: 'simple', captureTeams: true, captureOutlook: true, debugProbe: true, soundTeams: true });
  assert.equal(simple.captureTeams, false);
  assert.equal(simple.captureOutlook, false);
  assert.equal(simple.debugProbe, false);
  assert.equal(simple.storedCaptureTeams, true);
  assert.equal(simple.soundTeams, true);
  const full = normalize({ mode: 'full', captureTeams: true, captureOutlook: false });
  assert.equal(full.captureTeams, true);
  assert.equal(full.captureOutlook, false);
  assert.equal(normalize({ mode: 'bogus' }).mode, 'simple');
});

test('stored sounds must be small audio files', () => {
  const sound = { name: 'ping.mp3', type: 'audio/mpeg', size: 1000, data: 'AAAA' };
  assert.equal(validSound(sound), true);
  assert.equal(validSound({ ...sound, type: 'text/html' }), false);
  assert.equal(validSound({ ...sound, size: 2 * 1024 * 1024 }), false);
  assert.equal(validSound({ ...sound, data: null }), false);
  assert.equal(validSound(null), false);
});
