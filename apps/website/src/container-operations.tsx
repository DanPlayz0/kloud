import { useConfirmation } from './components/ui/confirmation-dialog'
import { useEffect, useState, type RefObject } from 'react'
import {
  Terminal,
  Square,
  Play,
  RotateCw,
  ScrollText,
  Settings2,
  X,
  AlertTriangle,
} from 'lucide-react'
import {
  api,
  organizationApiPath,
  resourceBase,
  type ResourceScope,
  type ContainerRow,
} from './api'
import { usePolling, ErrorMessage } from './components'
import { Button } from './components/ui/controls'
import { Alert, AlertTitle, AlertDescription } from './components/ui/alert'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from './components/ui/dialog'
import { ContainerTerminal } from './components/container-terminal'
import { ContainerConfiguration } from './components/container-configuration'

export function ContainerOperations({
  scope,
  container,
  open: controlledOpen,
  onOpenChange,
  trigger,
}: {
  scope: ResourceScope
  container: ContainerRow
  open?: boolean
  onOpenChange?: (open: boolean) => void
  trigger?: RefObject<HTMLButtonElement | null>
}) {
  const { confirm: confirmAction, confirmationDialog } = useConfirmation()
  const [internalOpen, setInternalOpen] = useState(false),
    [mode, setMode] = useState('logs'),
    [output, setOutput] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const open = controlledOpen ?? internalOpen
  const setOpen = onOpenChange ?? setInternalOpen
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
      ['terminal', 'configuration'].includes(mode) ||
      !permissions ||
      !permissions[mode === 'logs' ? 'logs' : 'configuration']
    )
      return
    setError('')
    setOutput('')
    if (mode === 'logs') {
      const stream = new EventSource(organizationApiPath(base + '/logs'))
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
      !(await confirmAction({
        title: `Stop ${container.data.name}?`,
        description: 'This interrupts its workload.',
        actionLabel: 'Stop container',
        variant: 'destructive',
      }))
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
      {confirmationDialog}
      {controlledOpen === undefined && (
        <Button
          aria-label={`Manage ${container.data.name}`}
          onClick={() => setOpen(true)}
        >
          <Settings2 data-icon="inline-start" />
          Manage
        </Button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          showCloseButton={false}
          className="max-h-[90vh] overflow-y-auto sm:max-w-3xl"
          onCloseAutoFocus={
            trigger
              ? (event) => {
                  event.preventDefault()
                  trigger.current?.focus()
                }
              : undefined
          }
        >
          <div className="flex items-start justify-between gap-4">
            <DialogTitle className="min-w-0 text-lg font-semibold break-all">
              {container.data.name}
            </DialogTitle>
            <Button
              aria-label="Close container details"
              onClick={() => setOpen(false)}
            >
              <X data-icon="inline-start" aria-hidden="true" />
            </Button>
          </div>
          <DialogDescription>
            {container.connector_name} · {container.data.state}
          </DialogDescription>
          <div className="my-4 flex flex-wrap gap-2">
            <Button
              disabled={!permissions?.logs}
              onClick={() => setMode('logs')}
            >
              <ScrollText data-icon="inline-start" />
              Logs
            </Button>
            <Button
              disabled={!permissions?.configuration}
              onClick={() => setMode('inspect')}
            >
              Details
            </Button>
            <Button
              disabled={!permissions?.configuration}
              onClick={() => setMode('configuration')}
            >
              <Settings2 data-icon="inline-start" />
              Configuration
            </Button>
            <Button
              disabled={!permissions?.terminal}
              onClick={() => setMode('terminal')}
            >
              <Terminal data-icon="inline-start" />
              Shell
            </Button>
            {(['start', 'stop', 'restart'] as const).map((action) => (
              <Button
                key={action}
                disabled={busy || !permissions?.lifecycle}
                onClick={() => void lifecycle(action)}
              >
                {action === 'start' ? (
                  <Play data-icon="inline-start" />
                ) : action === 'stop' ? (
                  <Square data-icon="inline-start" />
                ) : (
                  <RotateCw data-icon="inline-start" />
                )}{' '}
                {action}
              </Button>
            ))}
          </div>
          {permissions?.available === false && (
            <Alert variant="destructive">
              <AlertTriangle aria-hidden="true" />
              <AlertTitle>Container operations unavailable</AlertTitle>
              <AlertDescription>
                Host unavailable, runtime operations disabled, or operation
                permission required.
              </AlertDescription>
            </Alert>
          )}
          <ErrorMessage message={error} />
          {mode === 'configuration' && permissions?.configuration ? (
            <ContainerConfiguration path={`${base}/operation`} />
          ) : mode === 'terminal' && permissions?.terminal ? (
            <ContainerTerminal path={`${base}/operation`} onError={setError} />
          ) : (
            <pre
              aria-live="off"
              aria-label={
                mode === 'logs' ? 'Container logs' : 'Container details'
              }
              tabIndex={0}
              className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-h-96 min-h-32 overflow-auto rounded-md border border-border bg-muted p-4 text-xs whitespace-pre-wrap break-all"
            >
              {output || 'Select an operation you have access to.'}
            </pre>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
