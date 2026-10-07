// Narrow Tauri API: Rust validates every command and its arguments.
(() => {
  if (!window.__TAURI__) return;
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  const call = async (channel, input = null) => {
    try { return await invoke('petdesk_call', { channel, input }); }
    catch (error) { throw error instanceof Error ? error : new Error(String(error)); }
  };
  const watch = (name, callback) => {
    let active = true;
    let unlisten;
    listen(name, event => { if (active) callback(event.payload); }).then(fn => {
      if (active) unlisten = fn;
      else fn();
    });
    return () => { active = false; unlisten?.(); };
  };
  window.petdesk = {
    checkIn: () => call('check-in'),
    companionConfig: value => call('companion-config', value),
    openMaskdesk: () => call('open-maskdesk'),
    memoryInfo: () => call('memory-info'),
    trimMemory: () => call('memory-trim'),
    openPetMenu: () => call('pet-menu'),
    interaction: mode => call('interaction', mode),
    onMotion: callback => watch('motion', callback),
    reportReady: () => call('frontend-ready'),
    clearReminderHistory: () => call('clear-reminder-history'),
    onPetLayout: callback => watch('pet-layout', callback),
    onDragEnded: callback => watch('drag-ended', callback),
    eyeBreakAction: action => call('eye-break-action', { action }),
    previewEyeBreak: () => call('preview-eye-break'),
    openPetWebsite: () => call('open-pet-website'),
    init: () => call('init'),
    settings: value => call('settings', value),
    addReminder: value => call('add-reminder', value),
    reminderAction: value => call('reminder-action', value),
    showPanel: tab => call('show-panel', tab),
    showPet: () => call('show-pet'),
    hidePet: () => call('hide-pet'),
    play: action => call('play', action),
    importPet: kind => call('import-pet', { kind }),
    quit: () => call('quit'),
    previewPetLink: url => call('preview-pet-link', { url }),
    applyPet: token => call('apply-pet', { token }),
    cancelImport: () => call('cancel-import'),
    hitTest: interactive => { void call('hit-test', interactive).catch(() => {}); },
    dragStart: () => { void call('drag-start').catch(() => {}); },
    dragEnd: () => { void call('drag-end').catch(() => {}); },
    onState: callback => watch('state', callback),
    onPlay: callback => watch('play', callback),
    onPointer: callback => watch('pointer', callback),
    onImport: callback => watch('open-import', callback),
    onTab: callback => watch('tab', callback)
  };
})();
