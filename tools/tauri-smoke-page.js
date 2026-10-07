// Injected only into an explicitly enabled debug smoke run, never a release.
window.addEventListener('load', async () => {
  const checks = [];
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const wait = async (predicate, label) => {
    for (let i = 0; i < 200; i++) {
      if (await predicate()) return;
      await pause(50);
    }
    throw new Error(`Timed out: ${label}`);
  };
  const call = (channel, input = null) => window.__TAURI__.core.invoke('petdesk_call', { channel, input });
  const check = (value, label) => { if (!value) throw new Error(label); checks.push(label); };
  try {
    await wait(() => window.__ready, 'page ready');
    check(!!window.petdesk, 'bridge ready');
    const api = window.petdesk;
    if (location.pathname.endsWith('pet.html')) {
      const state = await api.init();
      const windows = await call('smoke-windows');
      if (!windows.panel) {
        check(!windows.toy, 'configured startup loads only pet');
        await call('smoke-menu', 'change-pet');
      }
      await call('smoke-report', { ok: true, pet: state.pet?.name || null, checks });
      return;
    }
    if (document.querySelector('#import-dialog').open) {
      checks.push('lazy panel receives queued import');
      document.querySelector('#import-close').click();
    }
    check(!(await call('smoke-windows')).toy, 'toy is not loaded at startup');
    const { Sprite } = await import('./sprite.js');
    const atlas = document.createElement('canvas'); atlas.width = 1536; atlas.height = 1872;
    const atlasContext = atlas.getContext('2d');
    atlasContext.fillStyle = '#ff0000'; atlasContext.fillRect(0, 0, 192, 208);
    atlasContext.fillStyle = '#00ff00'; atlasContext.fillRect(192 + 40, 40, 40, 40);
    const display = document.createElement('canvas');
    const animation = new Sprite(display, atlas.toDataURL()); await animation.ready;
    animation.paused = true; animation.frame = 1; animation.draw();
    check(display.getContext('2d').getImageData(0, 0, 1, 1).data[3] === 0 && display.getContext('2d').getImageData(50, 50, 1, 1).data[1] === 255, 'isolated animation frame clears previous pixels');
    const scratch = animation.frameCanvas;
    animation.destroy(); atlas.width = atlas.height = 0;
    check(scratch.width === 0 && scratch.height === 0 && !animation.frames, 'destroy releases animation buffers');
    check(!(await api.init()).dock, 'legacy dock restored to floating');
    check(!api.dockPet && !api.expandPet && !document.querySelector('#dock-pet'), 'edge controls removed');
    check(document.querySelector('#today').textContent.length > 0, 'panel rendered');
    check((await api.init()).companion.streak === 0, 'legacy state defaults companionship');
    document.querySelector('#check-in').click();
    await wait(() => document.querySelector('#spark-streak').textContent.includes('1 天'), 'check-in reaches UI');
    check(document.querySelector('#check-in').disabled, 'checked-in button disabled');
    check(await api.checkIn() === false && (await api.init()).companion.total === 1, 'duplicate check-in is idempotent');
    await api.companionConfig({ moodMinutes: 1, moodEnabled: false, holidayEnabled: false });
    check((await api.init()).companion.moodMinutes === 1, 'companion preferences persisted');
    try { await api.companionConfig({moodMinutes:0}); throw new Error('invalid interval accepted'); }
    catch(error) { check(error.message !== 'invalid interval accepted', 'invalid mood interval rejected'); }
    document.querySelector('[data-tab="reminders"]').click();
    check(document.querySelectorAll('.calendar-day').length >= 28, 'calendar month rendered');
    const monthTitle = document.querySelector('#calendar-title').textContent;
    document.querySelector('#calendar-next').click();
    check(document.querySelector('#calendar-title').textContent !== monthTitle, 'calendar next month');
    const selectedDate = document.querySelector('.calendar-day').getAttribute('aria-label').slice(0,10);
    document.querySelector('.calendar-day').click(); document.querySelector('#calendar-add').click();
    check(document.querySelector('#meeting-date').value === selectedDate, 'calendar selection fills reminder form');
    document.querySelector('#calendar-today').click();
    await api.companionConfig({moodMinutes:20,moodEnabled:true,holidayEnabled:true});
    await api.settings({ scale: 0.45, quiet: true, reducedMotion: true });
    check((await api.init()).settings.scale === 0.45, 'settings persisted');
    await wait(() => document.querySelector('#setting-scale').value === '0.45', 'settings event');
    checks.push('state event reached DOM');
    try { await api.addReminder({ title: '', meetingAt: 'invalid', leadMinutes: 0 }); throw new Error('invalid input accepted'); }
    catch (error) { check(error instanceof Error && error.message !== 'invalid input accepted', 'readable validation error'); }
    const reminder = await api.addReminder({ title: 'Tauri smoke reminder', meetingAt: new Date(Date.now() + 1200).toISOString(), leadMinutes: 0 });
    await wait(async () => (await api.init()).reminders.some(r => r.id === reminder.id && r.status === 'active'), 'reminder due');
    checks.push('Rust reminder timer');
    await api.reminderAction({ id: reminder.id, action: 'snooze' });
    check((await api.init()).reminders.find(r => r.id === reminder.id).status === 'pending', 'snooze');
    await api.reminderAction({ id: reminder.id, action: 'done' });
    await api.clearReminderHistory();
    check(!(await api.init()).reminders.some(r => r.id === reminder.id), 'clear history');
    await api.previewEyeBreak();
    check(!!(await api.init()).eyeReminder, 'eye reminder');
    await api.eyeBreakAction('done');
    for (const name of ['first', 'second']) {
      const canvas = document.createElement('canvas'); canvas.width = 1536; canvas.height = 1872;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = name === 'first' ? '#168b85' : '#dc673c';
      for (let row = 0; row < 9; row++) for (let col = 0; col < 8; col++) {
        ctx.beginPath(); ctx.arc(col * 192 + 96, row * 208 + 104, 60, 0, Math.PI * 2); ctx.fill();
      }
      const preview = await call('smoke-import', { name, image: canvas.toDataURL('image/webp').split(',')[1] });
      await api.applyPet(preview.token);
      check((await api.init()).pet.name === `Smoke ${name}`, `switch pet ${name}`);
      await wait(() => document.querySelector('#pet-name').textContent === `Smoke ${name}`, 'pet state event');
      await pause(500);
    }
    check(document.querySelectorAll('[data-interaction]').length === 3, 'three play modes available');
    if ((await call('smoke-windows')).resumeTest) {
      const meetingAt = new Date(Date.now() + 4000).toISOString();
      const once = await api.addReminder({ title: 'Resume once', meetingAt, leadMinutes: 0 });
      const repeat = await api.addReminder({ title: 'Resume repeat', meetingAt, leadMinutes: 0, repeatDays: [0, 1, 2, 3, 4, 5, 6] });
      await api.previewEyeBreak();
      const before = Date.now();
      await call('smoke-report', { phase: 'resume-ready', checks });
      // The host suspends only this isolated Rust process for 12 seconds.
      // WebView timers may keep running; delay assertions until after the host resumes it.
      await pause(16000);
      await wait(async () => (await api.init()).reminders.find(r => r.id === once.id)?.status === 'active', 'overdue reminder after process resume');
      const restored = await api.init();
      check(Date.now() - before >= 12000, 'resume scenario spans a scheduler gap');
      check(restored.reminders.find(r => r.id === repeat.id)?.status === 'active', 'recurring reminder activates after resume');
      const future = restored.reminders.filter(r => r.seriesId === repeat.seriesId && r.status === 'pending');
      check(future.length === 1 && Date.parse(future[0].dueAt) > Date.now(), 'resume creates exactly one future recurrence');
      check(!restored.eyeReminder, 'resume clears stale eye reminder');
      await wait(() => document.querySelector('#home-inbox').textContent.includes('Resume once'), 'resume event reaches panel');
      checks.push('overdue reminder reaches UI after resume');
      await api.reminderAction({ id: once.id, action: 'snooze' });
      check((await api.init()).reminders.find(r => r.id === once.id)?.status === 'pending', 'snooze responds after resume');
      await api.reminderAction({ id: once.id, action: 'done' });
      check((await api.init()).reminders.find(r => r.id === once.id)?.status === 'done', 'acknowledgement responds after resume');
      await api.reminderAction({ id: repeat.id, action: 'done' });
      // Existing active reminders can be revealed without creating OS notifications.
      await api.settings({ quiet: false });
      await api.previewEyeBreak();
      await pause(250);
      await call('smoke-bubble-click', 'snooze');
      await wait(async () => !(await api.init()).eyeReminder, 'bubble snooze button after resume');
      checks.push('bubble snooze click responds after resume');
      await api.previewEyeBreak();
      await pause(250);
      await call('smoke-bubble-click', 'ack');
      await wait(async () => !(await api.init()).eyeReminder, 'bubble acknowledge button after resume');
      checks.push('bubble acknowledge click responds after resume');
      await api.settings({ quiet: true });
    }
    const movement = await call('smoke-move');
    check(movement.stable && movement.moved, 'movement preserves surface size and canvas offset');
    const home = (await api.init()).petLayout.anchor;
    await call('smoke-menu', 'follow');
    await pause(500);
    check((await api.init()).interaction === 'follow', 'follow mouse active');
    check(!(await call('smoke-windows')).toy, 'follow does not allocate toy window');
    await call('smoke-menu', 'stop-play');
    check(!(await api.init()).interaction, 'follow stopped');
    await call('smoke-menu', 'wand');
    await pause(300);
    check((await api.init()).interaction === 'wand', 'wand active');
    await api.hidePet();
    check(!(await api.init()).interaction, 'hide cancels play');
    await api.showPet();
    await call('smoke-menu', 'ball');
    check((await api.init()).interaction === 'place', 'ball placement overlay');
    await pause(800);
    await call('smoke-toy-click', { x: home.x + 20, y: home.y + 20 });
    await wait(async () => ['fetch', 'return'].includes((await api.init()).interaction), 'ball clicked');
    await wait(async () => !(await api.init()).interaction, 'fetch and return completed');
    const returned = (await api.init()).petLayout.anchor;
    check(Math.hypot(returned.x - home.x, returned.y - home.y) < 1, 'ball returned to original position');
    await api.hidePet();
    check(!(await api.init()).petVisible, 'hide pet');
    await api.showPet();
    check((await api.init()).petVisible, 'show pet');
    await call('smoke-menu-popup', true);
    await pause(1400);
    const popup = await call('smoke-menu-popup', false);
    check(popup.opened && popup.closed && !popup.open, 'pet right click opens and dismisses native menu');
    await call('smoke-menu', 'settings');
    await wait(() => !document.querySelector('#settings').hidden, 'tab event');
    checks.push('context menu settings navigation');
    const memory = await api.memoryInfo();
    check(memory.total > 0 && memory.available >= 0 && memory.used + memory.available === memory.total && memory.percent <= 100 && memory.processCount > 0, 'system and owned-process memory metrics');
    document.querySelector('#memory-trim').click();
    await wait(() => document.querySelector('#memory-result').textContent.includes('已整理'), 'owned memory trim completed');
    checks.push('manual owned-process memory trim');
    await call('smoke-menu', 'change-pet');
    await wait(() => document.querySelector('#import-dialog').open, 'menu opens pet import');
    checks.push('context menu opens pet import');
    await call('smoke-report', { ok: true, checks });
  } catch (error) {
    await call('smoke-report', { ok: false, error: String(error), checks });
  }
});
