import * as Primitive from '@radix-ui/react-dialog'
import { clsx } from 'clsx'
import type { ComponentProps } from 'react'

export const Dialog = Primitive.Root
export const DialogTitle = Primitive.Title
export const DialogDescription = Primitive.Description
export function DialogContent({
  className,
  ...props
}: ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Overlay className="fixed inset-0 z-50 bg-black/60" />
      <Primitive.Content
        className={clsx(
          'fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-card p-6 text-foreground shadow-xl outline-none',
          className,
        )}
        {...props}
      />
    </Primitive.Portal>
  )
}
