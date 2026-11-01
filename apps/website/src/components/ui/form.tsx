import { type ComponentProps } from 'react'
import { FieldGroup } from './field'
import { cn } from '@/lib/utils'

/** Native submission semantics with the shared shadcn field layout. */
export function Form({
  children,
  className,
  layout = 'vertical',
  ...props
}: ComponentProps<'form'> & { layout?: 'vertical' | 'inline' }) {
  return (
    <form className={cn('min-w-0', className)} {...props}>
      <FieldGroup
        className={
          layout === 'inline'
            ? 'flex-row flex-wrap items-end gap-4 max-[720px]:flex-col max-[720px]:items-stretch max-[720px]:[&>[data-slot=field]]:basis-auto'
            : undefined
        }
      >
        {children}
      </FieldGroup>
    </form>
  )
}
