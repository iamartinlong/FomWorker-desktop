// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { Welcome } from '../src/client/WelcomePage.tsx'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveDesktopLocale } from '../src/locale.ts'

const html = readFileSync(join(import.meta.dirname, '../renderer/welcome.html'), 'utf8')
afterEach(cleanup)

function mount(language = 'zh-CN') {
  cleanup()
  const api = {
    ...resolveDesktopLocale(language),
    enterWorkspace: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  }
  const mounted = render(<Welcome api={api} />)
  const button = (id: string) => document.querySelector<HTMLButtonElement>(id)!
  const copy = () => [
    document.title, document.querySelector('img')!.alt, document.querySelector('#welcome-heading')!.textContent,
    document.querySelector('#welcome-description')!.textContent,
    ...[...document.querySelectorAll('button')].filter(item => item.closest('[hidden]') === null)
      .map(item => `${item.textContent || item.getAttribute('aria-label')}${item.disabled ? ' [disabled]' : ''}`),
    '',
  ].join('\n')
  return { document, api, button, copy, unmount: mounted.unmount }
}

describe('desktop first-run entry', () => {
  it.each(['zh-CN', 'en'])('renders the %s brand page', async (language) => {
    const view = mount(language)
    expect(view.document.documentElement.lang).toBe(language)
    expect(view.document.querySelector('img')!.getAttribute('src')).toBe('assets/welcome-brand.svg')
    await expect(view.copy()).toMatchFileSnapshot(`./expected/welcome/${language}.expected.txt`)
  })

  it('hands off to the workspace from both actions without touching credentials', async () => {
    const view = mount()
    // The product gate owns sign-in and the local-mode choice, so both actions are the
    // same hand-off; the entry itself must expose no credential surface at all.
    expect(Object.keys(view.api).sort()).toEqual(['enterWorkspace', 'id', 'messages'])
    fireEvent.click(view.button('#sign-in'))
    expect(view.api.enterWorkspace).toHaveBeenCalledOnce()
    cleanup()
    const local = mount()
    fireEvent.click(local.button('#use-local'))
    expect(local.api.enterWorkspace).toHaveBeenCalledOnce()
  })

  it('renders no credential form, retry, or account surface', () => {
    const view = mount()
    for (const id of ['#key-form', '#key-input', '#auth-page', '#auth-retry', '#auth-api-key', '#auth-copy', '#save-key', '#skip-key']) {
      expect(view.document.querySelector(id)).toBeNull()
    }
  })

  it('keeps visible copy in the shell dictionaries and denies network access', () => {
    expect([...html.matchAll(/>([^<]*\p{L}[^<]*)</gu)]).toEqual([])
    expect(html).toContain("default-src 'none'")
    expect(html).toContain("form-action 'none'")
  })
})
