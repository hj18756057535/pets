window.addEventListener('DOMContentLoaded', async () => {
  const call = (channel, input = null) => window.__TAURI__.core.invoke('petdesk_call', { channel, input });
  const render = mode => { document.body.className = mode === 'place' ? 'place' : mode === 'wand' ? 'wand' : 'ball'; };
  await window.__TAURI__.event.listen('toy-mode', event => render(event.payload));
  const feedback = document.createElement('span'); feedback.id = 'catch-feedback'; document.body.append(feedback);
  await window.__TAURI__.event.listen('toy-feedback', ({payload}) => {
    document.body.classList.toggle('reduced', payload.reduced);
    document.body.classList.toggle('caught', payload.phase === 'waving');
    document.body.classList.toggle('pounce', payload.phase === 'jumping');
    feedback.textContent = payload.phase === 'waving' ? `抓到啦 ×${payload.catches}` : '';
  });
  render(await call('toy-init'));
  document.addEventListener('pointerdown', async event => {
    if (event.button !== 0 || !document.body.classList.contains('place')) return;
    try { await call('toy-place', { x: event.clientX, y: event.clientY }); }
    catch { await call('interaction-stop'); }
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') void call('interaction-stop'); });
  document.addEventListener('contextmenu', event => { event.preventDefault(); void call('interaction-stop'); });
  window.__ready = true;
  await call('frontend-ready');
});
