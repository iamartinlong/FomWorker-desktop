import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveDesktopLocale } from '../src/locale.ts'
import { needsWelcome, WELCOME_IPC } from '../src/welcome-api.ts'

const electron = vi.hoisted(() => ({
  create: vi.fn<(options: unknown) => ReturnType<typeof createWindow>>(),
  root: '/desktop-app',
  handlers: new Map<string, (event: unknown, value?: unknown) => Promise<unknown>>(),
}))
vi.mock('electron', () => ({
  app: { getAppPath: () => electron.root },
  BrowserWindow: vi.fn(function (options: unknown) { return electron.create(options) }),
  ipcMain: {
    handle: (name: string, handler: (event: unknown, value?: unknown) => Promise<unknown>) => {
      if (electron.handlers.has(name)) throw new Error(`duplicate IPC handler: ${name}`)
      electron.handlers.set(name, handler)
    },
    removeHandler: (name: string) => electron.handlers.delete(name),
  },
}))

const { openWelcomeWindow, welcomeWindowOptions } = await import('../src/welcome-window.ts')

function createWindow() {
  return {
    webContents: {
      mainFrame: {},
      setWindowOpenHandler: vi.fn<(handler: () => { action: string }) => void>(),
      on: vi.fn<(name: string, handler: (event: { preventDefault(): void }) => void) => void>(),
    },
    loadFile: vi.fn<(path: string) => Promise<undefined>>().mockResolvedValue(undefined),
    isDestroyed: vi.fn().mockReturnValue(false),
    destroy: vi.fn(),
    show: vi.fn(),
    once: vi.fn<(name: string, callback: () => void) => void>(),
  }
}

beforeEach(() => { electron.create.mockReset(); electron.handlers.clear() })

const operations = {
  enterWorkspace: () => Promise.resolve(),
}

describe('desktop welcome window', () => {
  it.each(['darwin', 'win32', 'linux'] as const)('keeps the %s preview fixed-size and sandboxed', (platform) => {
    const options = welcomeWindowOptions(platform, resolveDesktopLocale('zh-CN'))
    expect(options).toMatchObject({
      width: 600, height: 700, useContentSize: true, center: true, show: false,
      resizable: false, maximizable: false, fullscreenable: false,
      webPreferences: {
        nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
        additionalArguments: ['--dsh-welcome-locale=zh-CN'],
      },
    })
    expect(options.webPreferences?.preload).toMatch(/preload-welcome\.cjs$/u)
    if (platform === 'darwin') {
      expect(options.vibrancy).toBe('menu')
      expect(options.visualEffectState).toBe('active')
      expect(options.trafficLightPosition).toEqual({ x: 21, y: 21 })
    } else if (platform === 'win32') {
      expect(options.backgroundMaterial).toBe('acrylic')
      expect(options.titleBarOverlay).toMatchObject({ height: 42 })
    } else {
      expect(options.vibrancy).toBeUndefined()
      expect(options.titleBarOverlay).toBeUndefined()
    }
  })

  it('loads the renderer bundle and shows only after it is ready', async () => {
    const window = createWindow()
    electron.create.mockReturnValue(window)
    await openWelcomeWindow(resolveDesktopLocale('en'), operations)
    expect(window.loadFile).toHaveBeenCalledWith(expect.stringMatching(/renderer[\\/]welcome\.html$/u))
    expect(window.show).toHaveBeenCalledOnce()
  })

  it('destroys the window and releases handlers when the document fails to load', async () => {
    const window = createWindow()
    window.loadFile.mockRejectedValue(new Error('load failed'))
    electron.create.mockReturnValue(window)
    await expect(openWelcomeWindow(resolveDesktopLocale('en'), operations)).rejects.toThrow('load failed')
    expect(window.destroy).toHaveBeenCalledOnce()
    expect(electron.handlers.size).toBe(0)
    expect(window.show).not.toHaveBeenCalled()
  })

  it('does not show a window closed while its document was loading', async () => {
    const window = createWindow()
    window.isDestroyed.mockReturnValue(true)
    electron.create.mockReturnValue(window)
    await openWelcomeWindow(resolveDesktopLocale('en'), operations)
    expect(window.show).not.toHaveBeenCalled()
    expect(window.destroy).not.toHaveBeenCalled()
  })

  it('accepts the hand-off only from its own top frame and removes handlers on close', async () => {
    const window = createWindow()
    electron.create.mockReturnValue(window)
    const enterWorkspace = vi.fn(operations.enterWorkspace)
    await openWelcomeWindow(resolveDesktopLocale('en'), { enterWorkspace })
    const own = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    const enter = electron.handlers.get(WELCOME_IPC.enterWorkspace)!
    await expect(enter({ sender: {}, senderFrame: {} })).rejects.toThrow('unowned frame')
    await expect(enter({ ...own, senderFrame: {} })).rejects.toThrow('unowned frame')
    expect(enterWorkspace).not.toHaveBeenCalled()
    await enter(own)
    expect(enterWorkspace).toHaveBeenCalledOnce()
    window.once.mock.calls[0]![1]()
    expect(electron.handlers.size).toBe(0)
  })

  it('does not show a superseded window when its delayed document finishes loading', async () => {
    const previous = createWindow()
    const current = createWindow()
    const loaded = Promise.withResolvers<undefined>()
    previous.loadFile.mockReturnValue(loaded.promise)
    electron.create.mockReturnValueOnce(previous).mockReturnValueOnce(current)
    const opening = openWelcomeWindow(resolveDesktopLocale('en'), operations)
    await openWelcomeWindow(resolveDesktopLocale('en'), operations)
    loaded.resolve(undefined)
    await opening
    expect(previous.show).not.toHaveBeenCalled()
    expect(current.show).toHaveBeenCalledOnce()
    previous.once.mock.calls[0]![1]()
    current.once.mock.calls[0]![1]()
  })

  it('replaces handlers before the previous native window emits closed', async () => {
    const previous = createWindow()
    const current = createWindow()
    electron.create.mockReturnValueOnce(previous).mockReturnValueOnce(current)
    const previousEnter = vi.fn(operations.enterWorkspace)
    const currentEnter = vi.fn(operations.enterWorkspace)
    await openWelcomeWindow(resolveDesktopLocale('en'), { enterWorkspace: previousEnter })
    const previousHandler = electron.handlers.get(WELCOME_IPC.enterWorkspace)!
    const previousSender = { sender: previous.webContents, senderFrame: previous.webContents.mainFrame }
    await openWelcomeWindow(resolveDesktopLocale('en'), { enterWorkspace: currentEnter })
    const currentHandler = electron.handlers.get(WELCOME_IPC.enterWorkspace)!
    await expect(previousHandler(previousSender)).rejects.toThrow('unowned frame')
    await expect(currentHandler(previousSender)).rejects.toThrow('unowned frame')
    previous.once.mock.calls[0]![1]()
    expect(electron.handlers.get(WELCOME_IPC.enterWorkspace)).toBe(currentHandler)
    await currentHandler({ sender: current.webContents, senderFrame: current.webContents.mainFrame })
    expect(currentEnter).toHaveBeenCalledOnce()
    expect(previousEnter).not.toHaveBeenCalled()
    current.once.mock.calls[0]![1]()
    expect(electron.handlers.size).toBe(0)
  })

  it('shows the entry only before this installation has entered the workspace', () => {
    const firstRun = { loggedIn: false, hasApiKey: false, platformLoggedIn: false, welcomeCompleted: false }
    // First launch with no credential of any kind is the only state that shows the entry.
    expect(needsWelcome(firstRun)).toBe(true)
    // A product sign-in is enough: the platform token is what both windows share.
    expect(needsWelcome({ ...firstRun, platformLoggedIn: true })).toBe(false)
    // R-2: the official account and a separately stored API key still suppress it.
    expect(needsWelcome({ ...firstRun, loggedIn: true })).toBe(false)
    expect(needsWelcome({ ...firstRun, hasApiKey: true })).toBe(false)
    // D-2: the entry is a first-run fact, so signing out never brings it back.
    expect(needsWelcome({ ...firstRun, welcomeCompleted: true })).toBe(false)
    expect(needsWelcome({ loggedIn: false, hasApiKey: false, platformLoggedIn: false, welcomeCompleted: true })).toBe(false)
  })
})
