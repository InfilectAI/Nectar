const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('nectar', {
  getState: () => ipcRenderer.invoke('nectar:getState'),
  saveSettings: (patch) => ipcRenderer.invoke('nectar:saveSettings', patch),
  checkPermissions: (prompt) => ipcRenderer.invoke('nectar:checkPermissions', prompt),
  completeOnboarding: () => ipcRenderer.invoke('nectar:completeOnboarding'),

  // Local Models & Cortex Runtime
  refreshLocalModels: () => ipcRenderer.invoke('nectar:refreshLocalModels'),
  downloadLocalModel: (modelId) =>
    ipcRenderer.invoke('nectar:downloadLocalModel', modelId),
  downloadAllLocalModels: (modelIds) =>
    ipcRenderer.invoke('nectar:downloadAllLocalModels', modelIds),
  cancelLocalModelDownload: (modelId) =>
    ipcRenderer.invoke('nectar:cancelLocalModelDownload', modelId),
  restartCortex: () => ipcRenderer.invoke('nectar:restartCortex'),
  openModelsFolder: () => ipcRenderer.invoke('nectar:openModelsFolder'),
  testSttConnection: (config) => ipcRenderer.invoke('nectar:testSttConnection', config),
  validateCloudSettings: (draft) =>
    ipcRenderer.invoke('nectar:validateCloudSettings', draft),

  // Meetings & Notepad
  createMeeting: (input) => ipcRenderer.invoke('nectar:createMeeting', input),
  updateMeeting: (id, patch) => ipcRenderer.invoke('nectar:updateMeeting', id, patch),
  deleteMeeting: (id) => ipcRenderer.invoke('nectar:deleteMeeting', id),
  distillMeeting: (id) => ipcRenderer.invoke('nectar:distillMeeting', id),

  // Live Capture & Simulation
  startCapture: (target, meetingId) =>
    ipcRenderer.invoke('nectar:startCapture', target, meetingId),
  startSelfNote: (meetingId) => ipcRenderer.invoke('nectar:startSelfNote', meetingId),
  pauseCapture: () => ipcRenderer.invoke('nectar:pauseCapture'),
  resumeCapture: () => ipcRenderer.invoke('nectar:resumeCapture'),
  stopCapture: () => ipcRenderer.invoke('nectar:stopCapture'),
  simulateLiveMeeting: () => ipcRenderer.invoke('nectar:simulateLiveMeeting'),
  focusMainWindow: () => ipcRenderer.invoke('nectar:focusMainWindow'),
  startPillDrag: () => ipcRenderer.send('nectar:startPillDrag'),
  dragPill: () => ipcRenderer.send('nectar:dragPill'),

  // MCP
  installMcp: (target) => ipcRenderer.invoke('nectar:installMcp', target),

  // Subscriptions
  onEvent: (callback) => {
    const handler = (_event, payload) => callback(payload)
    ipcRenderer.on('nectar:event', handler)
    return () => ipcRenderer.removeListener('nectar:event', handler)
  },
})
