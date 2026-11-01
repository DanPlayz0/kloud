import { Separator } from '@/components/ui/separator'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { useState } from 'react'
import { api } from './api'
import { usePolling, ErrorMessage } from './components'
import { Button } from './components/ui/controls'
import { Card } from './components/ui/card'
import { StatusBadge } from './components/ui/status-badge'
interface Queue {
  release: {
    serving: string | null
    paused: boolean
    reason: string | null
  } | null
  runs: {
    id: string
    revision: string
    commit: string | null
    receipt_order: string
    status: string
    stage: string | null
  }[]
}
export function DeploymentQueue({
  project,
  service,
  canDeploy,
}: {
  project: string
  service: string
  canDeploy: boolean
}) {
  const path = `/projects/${project}/services/${service}`
  const [refresh, setRefresh] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const { data, error: loadError } = usePolling<Queue>(`${path}/queue`, refresh)
  const pending =
    data?.runs.filter(
      (run) => run.status === 'queued' || run.status === 'running',
    ) ?? []
  return (
    <Card className="flex flex-col gap-3">
      <CardHeader>
        <CardTitle asChild>
          <h2 className="font-semibold">Deployment queue</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ErrorMessage message={error || loadError} />
        {data?.release?.paused && (
          <Alert variant="destructive">
            <AlertDescription>
              Dispatch paused: {data.release.reason}. Preserve the existing
              releases while the connector reconciles the serving state. Do not
              blindly repeat an uncertain operation.
            </AlertDescription>
          </Alert>
        )}
        {data?.release?.serving && (
          <p className="text-xs text-muted-foreground break-all">
            Serving release: {data.release.serving}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Pushes run in receipt order at their exact commits and saved
          configuration revisions. New drafts do not rewrite or cancel queued
          deployments.
        </p>
        {!pending.length && (
          <p className="text-sm text-muted-foreground">
            No queued or active deployments.
          </p>
        )}
        {[...pending].reverse().map((run) => (
          <div
            key={run.id}
            className="flex flex-wrap items-center justify-between gap-3   pt-3"
          >
            <Separator className="basis-full" />
            <div className="text-xs">
              <p>
                #{run.receipt_order} ·{' '}
                <StatusBadge deployment>{run.status}</StatusBadge>
                {run.stage && ` · ${run.stage}`}
              </p>
              <p className="text-muted-foreground break-all">
                Commit {run.commit ?? 'image / retained artifact'} ·
                configuration {run.revision}
              </p>
            </div>
            {canDeploy && run.status === 'queued' && (
              <Button
                disabled={busy}
                onClick={async () => {
                  if (
                    !window.confirm(
                      'Cancel this queued deployment? Active deployments are not interrupted.',
                    )
                  )
                    return
                  setError('')
                  setBusy(true)
                  try {
                    await api(`${path}/runs/${run.id}/cancel`, 'POST', {})
                    setRefresh((n) => n + 1)
                  } catch (e) {
                    setError(
                      e instanceof Error
                        ? e.message
                        : 'Unable to cancel queued run',
                    )
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                Cancel queued run
              </Button>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
