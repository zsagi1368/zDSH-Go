// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

describe('Vitest jsdom compatibility', () => {
  it('provides initial ResizeObserver delivery and supports disconnecting targets', () => {
    const target = document.createElement('div')
    target.getBoundingClientRect = () => { throw new Error('the jsdom resize fallback must not measure viewport geometry') }
    const deliveries: ResizeObserverEntry[][] = []
    const observer = new ResizeObserver(entries => deliveries.push(entries))
    observer.observe(target, { box: 'border-box' })
    observer.observe(target)
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]?.[0]).toMatchObject({ target, borderBoxSize: [{ inlineSize: 0, blockSize: 0 }] })
    observer.unobserve(target)
    observer.observe(target)
    expect(deliveries).toHaveLength(2)
    observer.disconnect()
    observer.observe(target)
    expect(deliveries).toHaveLength(3)
    observer.disconnect()
  })

  it('provides isolated browser storage instead of Node process storage', () => {
    if (process.allowedNodeEnvironmentFlags.has('--webstorage')) {
      expect(process.execArgv.filter(argument => argument === '--no-webstorage')).toHaveLength(1)
    }
    localStorage.setItem('dsh-vitest-storage-probe', 'available')

    expect(localStorage.getItem('dsh-vitest-storage-probe')).toBe('available')
    localStorage.removeItem('dsh-vitest-storage-probe')
  })

  it('turns a jsdom Blob into a blob URL, which bounds the jsdom upgrade', () => {
    // Vitest's jsdom compat URL reaches into jsdom's private Blob implementation
    // (`makeCompatBlob` reads the impl's `_buffer` off the instance's own
    // symbol). jsdom 30.1.x no longer exposes that symbol, so every
    // `URL.createObjectURL(new Blob(...))` inside the environment throws
    // `Cannot read properties of undefined (reading '_buffer')` — the failure
    // that pins the repo to 30.0.x; a later jsdom must satisfy this case first.
    const url = URL.createObjectURL(new Blob([new Uint8Array([1, 2])]))
    expect(url.startsWith('blob:')).toBe(true)
    URL.revokeObjectURL(url)
  })
})
