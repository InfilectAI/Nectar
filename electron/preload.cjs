const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('nectar', {
  getState: () => ipcRenderer.invoke('nectar:getState'),
  saveSettings: (patch) => ipcRenderer.invoke('nectar:saveSettings', patch),
  checkPermissions: (prompt) => ipcRenderer.invoke('nectar:checkPermissions', prompt),

  // Meetings & Notepad
  createMeeting: (input) => ipcRenderer.invoke('nectar:createMeeting', input),
  updateMeeting: (id, patch) => ipcRenderer.invoke('nectar:updateMeeting', id, patch),
  deleteMeeting: (id) => ipcRenderer.invoke('nectar:deleteMeeting', id),
  distillMeeting: (id) => ipcRenderer.invoke('nectar:distillMeeting', id),

  // Live Capture & Simulation
  startCapture: (target, meetingId) =>
    ipcRenderer.invoke('nectar:startCapture', target, meetingId),
  stopCapture: () => ipcRenderer.invoke('nectar:stopCapture'),
  simulateLiveMeeting: () => ipcRenderer.invoke('nectar:simulateLiveMeeting'),

  // Synapse Memory & Knowledge Graph
  recall: (query) => ipcRenderer.invoke('nectar:recall', query),
  getKnowledgeGraph: (includeSuperseded) =>
    ipcRenderer.invoke('nectar:getKnowledgeGraph', includeSuperseded),
  consolidateMemory: () => ipcRenderer.invoke('nectar:consolidateMemory'),
  detectProcedures: () => ipcRenderer.invoke('nectar:detectProcedures'),
  setSkillStatus: (skillId, status) =>
    ipcRenderer.invoke('nectar:setSkillStatus', skillId, status),
  installMcp: (target) => ipcRenderer.invoke('nectar:installMcp', target),

  // Subscriptions
  onEvent: (callback) => {
    const handler = (_event, payload) => callback(payload)
    ipcRenderer.on('nectar:event', handler)
    return () => ipcRenderer.removeListener('nectar:event', handler)
  },
})
