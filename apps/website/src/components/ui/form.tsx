import { type ComponentProps } from 'react'
import { FieldGroup } from './field'
import { cn } from '@/lib/utils'

/** Native submission semantics with the shared shadcn field layout. */
export function Form({
  children,
  className,
  ...props
}: ComponentProps<'form'>) {
  return (
    <form className={cn('min-w-0', className)} {...props}>
      <FieldGroup>{children}</FieldGroup>
    </form>
  )
}
