import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { api } from '../api'

export function ContainerTerminal({
  path,
  onError,
}: {
  path: string
  onError: (error: string) => void
}) {
  const element = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!element.current) return
    let stopped = false,
      session: string | undefined,
      timer: ReturnType<typeof setTimeout> | undefined,
      queue = Promise.resolve()
    const term = new Terminal({
        cursorBlink: true,
        convertEol: false,
        fontSize: 13,
        scrollback: 2000,
      }),
      fit = new FitAddon()
    term.loadAddon(fit)
    term.open(element.current)
    fit.fit()
    term.focus()
    const call = (body: unknown) => api<any>(path, 'POST', body)
    const fail = (error: unknown) => {
      if (!stopped)
        onError(error instanceof Error ? error.message : 'Terminal unavailable')
    }
    const resize = () => {
      if (stopped) return
      fit.fit()
      if (session)
        void call({
          action: 'terminal-resize',
          session,
          rows: term.rows,
          cols: term.cols,
        }).catch(fail)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(element.current)
    const input = term.onData((data) => {
      queue = queue
        .then(async () => {
          if (session && !stopped)
            await call({ action: 'terminal-write', session, input: data })
        })
        .catch(fail)
    })
    async function read() {
      if (!session || stopped) return
      try {
        const result = await call({ action: 'terminal-read', session })
        if (stopped) return
        term.write(result.output ?? '')
        if (result.exited) {
          term.write('\r\nSession ended.')
          return
        }
        timer = setTimeout(() => void read(), 150)
      } catch (error) {
        fail(error)
      }
    }
    void call({ action: 'terminal-open' })
      .then(async (result) => {
        session = result.session
        if (stopped) {
          await call({ action: 'terminal-close', session })
          return
        }
        resize()
        void read()
      })
      .catch(fail)
    return () => {
      stopped = true
      clearTimeout(timer)
      input.dispose()
      observer.disconnect()
      term.dispose()
      if (session)
        void call({ action: 'terminal-close', session }).catch(() => {})
    }
  }, [path])
  return (
    <div
      ref={element}
      className="h-96 w-full min-w-0 overflow-hidden rounded-md border border-border bg-background p-2"
      aria-label="Container terminal"
    />
  )
}
