/**
 * Main-to-renderer eventa broadcasting.
 *
 * The plain `createContext(ipcMain)` context only echoes events back to the
 * ipc request's sender — a main-initiated emit with no sender goes nowhere.
 * Services that PUSH to renderers (approval cards, life-mode ticks) need one
 * window-bound context per live window; this helper owns that set and
 * re-broadcasts every emit to all of them. Invoke handlers must stay on the
 * plain context: window-bound contexts never register handlers, so a
 * renderer→main request is still answered exactly once.
 */
import type { createContext } from '@moeru/eventa/adapters/electron/main'

import { createContext as createWindowEventaContext } from '@moeru/eventa/adapters/electron/main'
import { app, BrowserWindow, ipcMain } from 'electron'

type MainEventaContext = ReturnType<typeof createContext>['context']
type EmitArgs = Parameters<MainEventaContext['emit']>

export interface EventaWindowBroadcast {
  broadcast: (...args: EmitArgs) => void
  dispose: () => void
}

export function createEventaWindowBroadcast(): EventaWindowBroadcast {
  const contexts = new Map<number, MainEventaContext>()

  function attach(window: BrowserWindow): void {
    // webContents.id is volatile: by the time 'closed' fires the webContents
    // is already destroyed, so read the id once here and only touch the
    // cached value in the cleanup callback.
    const webContentsId = window.webContents.id
    if (contexts.has(webContentsId))
      return
    const { context } = createWindowEventaContext(ipcMain, window)
    contexts.set(webContentsId, context)
    window.once('closed', () => {
      contexts.delete(webContentsId)
    })
  }

  for (const window of BrowserWindow.getAllWindows())
    attach(window)
  const onWindowCreated = (_: unknown, window: BrowserWindow) => attach(window)
  app.on('browser-window-created', onWindowCreated)

  return {
    broadcast(...args) {
      for (const context of contexts.values()) {
        try {
          context.emit(...args)
        }
        catch {
          // A destroyed window's context is removed on its 'closed' event;
          // skipping one broadcast must not break the rest.
        }
      }
    },
    dispose() {
      app.off('browser-window-created', onWindowCreated)
      contexts.clear()
    },
  }
}
