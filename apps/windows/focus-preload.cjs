const { contextBridge, ipcRenderer } = require('electron');

if (process.isMainFrame && location.origin === 'http://127.0.0.1:38741') {
  const controls =
    location.pathname === '/focus-pet'
      ? {
          hidePet: () => ipcRenderer.send('prism:hide-pet'),
          openFocus: () => ipcRenderer.send('prism:open-focus'),
          dragPet: (dx, dy) => ipcRenderer.send('prism:drag-pet', dx, dy),
        }
      : { setState: (state) => ipcRenderer.send('prism:focus-state', state) };
  contextBridge.exposeInMainWorld('prismFocus', controls);
}
