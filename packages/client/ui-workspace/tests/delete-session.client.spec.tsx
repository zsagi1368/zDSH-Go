// @vitest-environment jsdom
/**
 * The delete action: the menu row, the hover button, and the confirmation
 * dialog they raise. Deleting a Session is irreversible, so the dialog
 * always asks first and names the Session — and confirming also stops the
 * work the Host reported, or the Host would refuse.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { GlobalStandardProps, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type {
  DeleteSessionInjected, MenuOpenState, SessionDeleteConfirmRequest, SessionDeleteConfirmProps,
} from '../src/client/contract/slots.ts'
import {
  DeleteSessionMenuItem, DeleteSessionRowButton, SessionDeleteConfirmDialog,
} from '../src/client/session-actions/DeleteSession.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t: PropsLocale<'workspace'>['t'] = makeTranslate(zh, commonZh)

const sid = (id: string) => id as SessionId
/** Selector hook over one fixed snapshot. */
function hook<T>(snapshot: T) {
  return function select<S>(selector: (state: T) => S): S { return selector(snapshot) }
}

const ROW = { sessionId: sid('one'), displayTitle: 'Session title' }
const standard = {} as GlobalStandardProps

/** Owner share, standard seat, locale seat, and the bound open-state hook of one menu row. */
function menuRow(menu: MenuOpenState) {
  return {
    ...ROW,
    useMenuOpenState: () => menu,
    useShortcuts: hook([] as readonly never[]),
    t,
    ...standard,
  }
}

const actionRow = { ...ROW, t, ...standard }

describe('delete action', () => {
  it('menu row closes the menu, then asks for the confirmation', () => {
    const setMenuOpen = vi.fn()
    const requestSessionDelete = vi.fn()
    const state: MenuOpenState = [true, setMenuOpen]
    render(
      <DeleteSessionMenuItem
        {...menuRow(state)}
        {...({ requestSessionDelete } as unknown as DeleteSessionInjected)}
      />,
    )
    const row = screen.getByRole('menuitem', { name: '删除会话' })
    // Delete is irreversible: the row carries the danger styling archive
    // deliberately does not.
    expect(row.className).toMatch(/danger/)
    fireEvent.click(row)
    expect(requestSessionDelete).toHaveBeenCalledWith(sid('one'), 'Session title')
    expect(setMenuOpen).toHaveBeenCalledWith(false)
  })

  it('row button asks for the confirmation too', () => {
    const requestSessionDelete = vi.fn()
    render(
      <DeleteSessionRowButton
        {...actionRow}
        {...({ requestSessionDelete } as unknown as DeleteSessionInjected)}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '删除会话' }))
    expect(requestSessionDelete).toHaveBeenCalledWith(sid('one'), 'Session title')
  })
})

describe('delete confirmation', () => {
  const request: SessionDeleteConfirmRequest = {
    sessionId: sid('one'),
    displayTitle: 'Session title',
    activity: [],
  }

  /** The dialog's props: the pending request, its settlement, and the delete hop. */
  function dialogProps(deleteSession: () => Promise<void>, settleSessionDelete: () => void) {
    return {
      useDeleteRequest: hook(request),
      settleSessionDelete,
      deleteSession,
      t,
    } as unknown as SessionDeleteConfirmProps
  }

  it('names the session and asks before deleting', () => {
    const deleteSession = vi.fn(() => Promise.resolve())
    render(<SessionDeleteConfirmDialog {...dialogProps(deleteSession, vi.fn())} />)
    // The dialog names what is about to be destroyed.
    expect(screen.getByText(/Session title/)).toBeTruthy()
    expect(deleteSession).not.toHaveBeenCalled()
  })

  it('confirming deletes the session and stops the work the host reported', async () => {
    const deleteSession = vi.fn(() => Promise.resolve())
    const settleSessionDelete = vi.fn()
    render(<SessionDeleteConfirmDialog {...dialogProps(deleteSession, settleSessionDelete)} />)
    fireEvent.click(screen.getByRole('button', { name: '删除会话' }))
    await waitFor(() => { expect(deleteSession).toHaveBeenCalled() })
    // The Host refuses a session with running work, so confirming also stops
    // that work.
    expect(deleteSession).toHaveBeenCalledWith(sid('one'), { stopActivity: true })
    await waitFor(() => { expect(settleSessionDelete).toHaveBeenCalled() })
  })

  it('cancelling leaves the session and its log alone', () => {
    const deleteSession = vi.fn(() => Promise.resolve())
    const settleSessionDelete = vi.fn()
    render(<SessionDeleteConfirmDialog {...dialogProps(deleteSession, settleSessionDelete)} />)
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(deleteSession).not.toHaveBeenCalled()
    expect(settleSessionDelete).toHaveBeenCalled()
  })

  it('keeps the dialog open with the refusal surfaced', async () => {
    const deleteSession = vi.fn(() => Promise.reject(new Error('the session is active')))
    const settleSessionDelete = vi.fn()
    render(<SessionDeleteConfirmDialog {...dialogProps(deleteSession, settleSessionDelete)} />)
    fireEvent.click(screen.getByRole('button', { name: '删除会话' }))
    await waitFor(() => { expect(screen.getByText(/the session is active/)).toBeTruthy() })
    // The dialog stays open so the refusal is readable, and the pending
    // request is not consumed.
    expect(settleSessionDelete).not.toHaveBeenCalled()
  })
})
