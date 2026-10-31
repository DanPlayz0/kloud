import { clsx } from 'clsx'

function statusTone(status: string, deployment: boolean) {
  const value = status.toLowerCase()
  if (
    deployment &&
    ['running', 'queued', 'building', 'deploying'].includes(value)
  )
    return 'info'
  if (
    ['running', 'online', 'connected', 'healthy', 'succeeded'].includes(value)
  )
    return 'success'
  if (
    [
      'failed',
      'errored',
      'dead',
      'unhealthy',
      'unavailable',
      'revoked',
    ].includes(value)
  )
    return 'danger'
  if (
    [
      'stale',
      'offline / stale',
      'host disconnected',
      'needs attention',
      'mixed',
      'restarting',
      'paused',
      'starting',
      'stopping',
      'launching',
      'waiting restart',
    ].includes(value)
  )
    return 'warning'
  if (value === 'loading') return 'info'
  return 'neutral'
}

export function StatusBadge({
  children,
  deployment = false,
  className,
}: {
  children: string
  deployment?: boolean
  className?: string
}) {
  return (
    <span
      className={clsx('status-badge', className)}
      data-tone={statusTone(children, deployment)}
    >
      <span className="status-dot" aria-hidden="true" />
      {children}
    </span>
  )
}
