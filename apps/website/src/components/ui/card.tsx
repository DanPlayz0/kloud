import type { ComponentProps } from 'react'
import { clsx } from 'clsx'
import { Slot } from '@radix-ui/react-slot'

/** Shared surface, with explicit spacing so page CSS cannot override utilities. */
export function Card({
  className,
  size = 'default',
  asChild = false,
  ...props
}: ComponentProps<'div'> & {
  size?: 'default' | 'compact' | 'flush'
  asChild?: boolean
}) {
  const Component = asChild ? Slot : 'div'
  return (
    <Component
      data-slot="card"
      data-size={size}
      className={clsx(
        'ui-card bg-card text-foreground border-border',
        className,
      )}
      {...props}
    />
  )
}

/** Keep wide tables contained without changing their native table semantics. */
export function TableCard({ className, ...props }: ComponentProps<'div'>) {
  return (
    <Card
      size="flush"
      className={clsx('relative overflow-x-auto', className)}
      {...props}
    />
  )
}

export function FormCard({ className, ...props }: ComponentProps<'form'>) {
  return (
    <Card asChild>
      <form className={clsx('inline-form', className)} {...props} />
    </Card>
  )
}

export function CardFieldset({
  className,
  ...props
}: ComponentProps<'fieldset'>) {
  return (
    <Card size="compact" asChild>
      <fieldset className={clsx('space-y-3', className)} {...props} />
    </Card>
  )
}
