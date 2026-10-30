import type { ComponentProps } from 'react'
import { clsx } from 'clsx'

/** Shared shadcn-style card shell: padding and containment belong to the surface. */
export function Card({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="card"
      className={clsx(
        'ui-card bg-card text-foreground border-border',
        className,
      )}
      {...props}
    />
  )
}
