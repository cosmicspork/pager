// The popup carries only the three toggles worth flipping mid-session; the
// rest lives in options.html.

import { getSettings, setSettings } from './settings.js';

const TOGGLES = ['captureTeams', 'captureOutlook', 'keepActive'];

function flash() {
  const el = document.getElementById('saved');
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 900);
}

function ago(ts) {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  return Math.round(s / 3600) + 'h ago';
}

async function renderStatus(s) {
  const sess = await chrome.storage.session.get(['status', 'teamsHealth']);
  const st = sess.status || {};
  const bridge = document.getElementById('stBridge');
  if (st.bridgeOk === undefined) {
    bridge.textContent = 'no events yet';
    bridge.classList.remove('warn');
  } else if (st.bridgeOk) {
    bridge.textContent = 'ok';
    bridge.classList.remove('warn');
  } else {
    bridge.textContent = st.bridgeError || 'unreachable';
    bridge.classList.add('warn');
  }
  // Capture reporting in is the difference between "nobody messaged you" and
  // "Teams moved its store and this has been dead for a week".
  const teams = document.getElementById('stTeams');
  const t = sess.teamsHealth;
  if (!s.captureTeams) {
    // A warning about a capture the user turned off on purpose only teaches
    // them to ignore the warning.
    teams.textContent = 'off';
    teams.classList.remove('warn');
  } else if (!t) {
    teams.textContent = 'no tab open';
    teams.classList.remove('warn');
  } else if (!t.ok) {
    teams.textContent = 'failing';
    teams.classList.add('warn');
  } else if (Date.now() - t.at > 5 * 60 * 1000) {
    teams.textContent = 'stale · ' + ago(t.at);
    teams.classList.add('warn');
  } else {
    teams.textContent = `ok · ${t.conversations} convs · ${t.readMs}ms`;
    teams.classList.remove('warn');
  }

  document.getElementById('stLast').textContent =
    st.lastEventAt ? ago(st.lastEventAt) + (st.lastEventSource ? ' · ' + st.lastEventSource : '') : 'never';
  document.getElementById('stCount').textContent = st.forwarded || 0;
}

async function render() {
  const s = await getSettings();
  for (const key of TOGGLES) document.getElementById(key).checked = s[key];
  document.getElementById('keepActiveHint').textContent =
    'pulse every ' + s.keepActiveIntervalSec + 's' + (s.keepActiveMask ? ' · masking visibility' : '');
  await renderStatus(s);
}

for (const key of TOGGLES) {
  document.getElementById(key).addEventListener('change', async (e) => {
    await setSettings({ [key]: e.target.checked });
    flash();
    await render();
  });
}

document.getElementById('options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

render();
