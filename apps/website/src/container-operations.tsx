import { useEffect, useState } from 'react'
import {
  Terminal,
  Square,
  Play,
  RotateCw,
  ScrollText,
  Settings2,
} from 'lucide-react'
import { api, resourceBase, type ResourceScope, type ContainerRow } from './api'
import { usePolling, ErrorMessage } from './components'
import { Button } from './components/ui/controls'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from './components/ui/dialog'
import { ContainerTerminal } from './components/container-terminal'

export function ContainerOperations({
  scope,
  container,
}: {
  scope: ResourceScope
  container: ContainerRow
}) {
  const [open, setOpen] = useState(false),
    [mode, setMode] = useState('logs'),
    [output, setOutput] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const base =
    resourceBase(scope) +
    '/containers/' +
    (scope.kind === 'project' ? container.connector_id + '/' : '') +
    container.container_id
  const { data: permissions } = usePolling<Record<string, boolean>>(
    open ? `${base}/permissions` : null,
  )
  const operation = (body: unknown) =>
    api<any>(`${base}/operation`, 'POST', body)
  useEffect(() => {
    if (
      !open ||
      mode === 'terminal' ||
      !permissions ||
      !permissions[mode === 'logs' ? 'logs' : 'configuration']
    )
      return
    setError('')
    setOutput('')
    if (mode === 'logs') {
      const stream = new EventSource('/api' + base + '/logs')
      stream.onmessage = (event) => {
        try {
          setOutput(JSON.parse(event.data).output ?? '')
        } catch {
          setError('Invalid log output')
        }
      }
      const unavailable = () => {
        stream.close()
        setError('Log access ended or host unavailable')
      }
      stream.addEventListener('unavailable', unavailable)
      stream.onerror = unavailable
      return () => stream.close()
    }
    let stopped = false
    void operation({ action: 'inspect' })
      .then((result) => {
        if (!stopped) setOutput(JSON.stringify(result, null, 2))
      })
      .catch((e) => {
        if (!stopped) setError(e.message)
      })
    return () => {
      stopped = true
    }
  }, [open, mode, base, permissions?.logs, permissions?.configuration])
  async function lifecycle(action: string) {
    if (
      action === 'stop' &&
      !window.confirm(
        `Stop ${container.data.name}? This interrupts its workload.`,
      )
    )
      return
    setBusy(true)
    setError('')
    try {
      await operation({ action })
      setOutput(
        `${action} completed. Runtime inventory refreshes every five seconds.`,
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Operation failed')
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Button
        aria-label={`Manage ${container.data.name}`}
        onClick={() => setOpen(true)}
      >
        <Settings2 size={14} />
        Manage
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          <DialogTitle>{container.data.name}</DialogTitle>
          <DialogDescription>
            {container.connector_name} · {container.data.state}
          </DialogDescription>
          <div className="my-4 flex flex-wrap gap-2">
            <Button
              disabled={!permissions?.logs}
              onClick={() => setMode('logs')}
            >
              <ScrollText size={14} />
              Logs
            </Button>
            <Button
              disabled={!permissions?.configuration}
              onClick={() => setMode('inspect')}
            >
              Details
            </Button>
            <Button
              disabled={!permissions?.terminal}
              onClick={() => setMode('terminal')}
            >
              <Terminal size={14} />
              Shell
            </Button>
            {(['start', 'stop', 'restart'] as const).map((action) => (
              <Button
                key={action}
                disabled={busy || !permissions?.lifecycle}
                onClick={() => void lifecycle(action)}
              >
                {action === 'start' ? (
                  <Play size={14} />
                ) : action === 'stop' ? (
                  <Square size={14} />
                ) : (
                  <RotateCw size={14} />
                )}{' '}
                {action}
              </Button>
            ))}
          </div>
          {!permissions?.available && (
            <p className="text-muted-foreground">
              Host unavailable, runtime operations disabled, or operation
              permission required.
            </p>
          )}
          <ErrorMessage message={error} />
          {mode === 'terminal' && permissions?.terminal ? (
            <ContainerTerminal path={`${base}/operation`} onError={setError} />
          ) : (
            <pre
              aria-live="off"
              className="max-h-96 min-h-32 overflow-auto rounded-md border border-border bg-muted p-4 text-xs whitespace-pre-wrap break-all"
            >
              {output || 'Select an operation you have access to.'}
            </pre>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
