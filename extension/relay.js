// Isolated-world bridge between the MAIN-world capture script and the extension
// service worker. The MAIN-world script can't reach chrome.* APIs; this can.

window.addEventListener('message', function (ev) {
  if (ev.source !== window) return;
  const d = ev.data;
  if (!d || d.__pagerEvent !== true || !d.ev) return;
  try { chrome.runtime.sendMessage({ type: 'pager-event', ev: d.ev }); } catch (e) {}
});
