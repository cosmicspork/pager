import { getSettings, setSettings, effectiveSchedule, nextScheduleChange } from './settings.js';

function flash() {
  const element = document.getElementById('saved');
  element.classList.add('show');
  setTimeout(() => element.classList.remove('show'), 900);
}
function ago(timestamp) {
  if (!timestamp) return 'never';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return seconds + 's ago';
  if (seconds < 3600) return Math.round(seconds / 60) + 'm ago';
  return Math.round(seconds / 3600) + 'h ago';
}
function setValue(id, value) {
  const select = document.getElementById(id);
  select.querySelector('option[data-invalid]')?.remove();
  if (![...select.options].some((option) => option.value === value)) {
    const invalid = new Option('Invalid saved setting', value);
    invalid.dataset.invalid = 'true';
    select.add(invalid);
  }
  select.value = value;
}
function stateText(mode, current, invalid, next) {
  if (invalid) return 'Invalid settings · off until corrected';
  if (mode !== 'scheduled') return 'Manual override · ' + (current ? 'on' : 'off');
  return (current ? 'on' : 'off') + (next ? ' · next ' + next.toLocaleString() : ' · no upcoming change');
}
async function renderStatus(settings) {
  const session = await chrome.storage.session.get(['status', 'teamsHealth', 'outlookHealth']);
  const state = session.status || {};
  const collector = document.getElementById('stCollector');
  collector.textContent = state.collectorOk ? 'connected' : state.collectorError || 'not connected';
  collector.classList.toggle('warn', !state.collectorOk);
  const usage = await chrome.runtime.sendMessage({ type: 'pager-outbox-status' }).catch(() => ({}));
  document.getElementById('stPending').textContent = usage?.count ?? state.pending ?? '—';
  const teams = document.getElementById('stTeams');
  const teamStatus = session.teamsHealth;
  teams.textContent = !settings.captureTeams ? 'off' : !teamStatus ? 'no tab open' : !teamStatus.ok ? 'degraded' :
    Date.now() - teamStatus.at > 180000 ? 'stale · ' + ago(teamStatus.at) : 'ok · ' + teamStatus.conversations + ' conversations';
  teams.classList.toggle('warn', settings.captureTeams && !!teamStatus && (!teamStatus.ok || Date.now() - teamStatus.at > 180000));
  const outlook = document.getElementById('stOutlook');
  const mail = session.outlookHealth;
  outlook.textContent = !settings.captureOutlook ? 'off' : !mail ? 'no tab open' :
    Date.now() - mail.at > 180000 ? 'stale · ' + ago(mail.at) : mail.state + (mail.reason ? ' · ' + mail.reason : '');
  outlook.classList.toggle('warn', settings.captureOutlook && !!mail && (mail.state !== 'ok' || Date.now() - mail.at > 180000));
  document.getElementById('stLast').textContent = ago(state.lastEventAt);
}
async function render() {
  const settings = await getSettings();
  document.getElementById('captureTeams').checked = settings.captureTeams;
  document.getElementById('captureOutlook').checked = settings.captureOutlook;
  setValue('pagingMode', settings.pagingMode);
  setValue('keepActiveMode', settings.keepActiveMode);
  const effective = effectiveSchedule(settings);
  const pagingNext = nextScheduleChange({ ...settings, keepActiveMode: 'always_off' });
  const activityNext = nextScheduleChange({ ...settings, pagingMode: 'always_notify' });
  document.getElementById('pagingState').textContent = stateText(settings.pagingMode, effective.pagingAllowed, settings.pagingInvalid, pagingNext);
  document.getElementById('activityState').textContent = stateText(settings.keepActiveMode, effective.keepActive, settings.keepActiveInvalid, activityNext);
  await renderStatus(settings);
}
for (const key of ['captureTeams', 'captureOutlook']) {
  document.getElementById(key).addEventListener('change', async (event) => {
    await setSettings({ [key]: event.target.checked });
    flash(); await render();
  });
}
for (const key of ['pagingMode', 'keepActiveMode']) {
  document.getElementById(key).addEventListener('change', async (event) => {
    await setSettings({ [key]: event.target.value });
    flash(); await render();
  });
}
document.getElementById('options').addEventListener('click', () => chrome.runtime.openOptionsPage());
render();
