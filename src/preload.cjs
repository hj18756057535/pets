const { contextBridge, ipcRenderer } = require('electron');
async function call(channel, value) { const result = await ipcRenderer.invoke(channel, value); if (!result.ok) throw new Error(result.error); return result.value; }
function listen(channel, callback) { const listener = (_event, value) => callback(value); ipcRenderer.on(channel, listener); return () => ipcRenderer.removeListener(channel, listener); }
contextBridge.exposeInMainWorld('petdesk', {
  eyeBreakAction: action => call('eye-break-action', { action }), previewEyeBreak: () => call('preview-eye-break'),
  openPetWebsite: () => call('open-pet-website'), init: () => call('init'), settings: value => call('settings', value),
  addReminder: value => call('add-reminder', value), reminderAction: value => call('reminder-action', value),
  showPanel: tab => call('show-panel', tab), showPet: () => call('show-pet'), hidePet: () => call('hide-pet'),
  dockPet: () => call('dock-pet'), expandPet: () => call('expand-pet'),
  play: action => call('play', action), importPet: kind => call('import-pet', { kind }), quit: () => call('quit'),
  previewPetLink: url => call('preview-pet-link', { url }), applyPet: token => call('apply-pet', { token }), cancelImport: () => call('cancel-import'),
  hitTest: value => ipcRenderer.send('hit-test', value), dragStart: () => ipcRenderer.send('drag-start'), dragEnd: () => ipcRenderer.send('drag-end'),
  onState: callback => listen('state', callback), onPlay: callback => listen('play', callback), onPointer: callback => listen('pointer', callback), onTab: callback => listen('tab', callback)
});
