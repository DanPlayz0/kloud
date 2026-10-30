import * as Primitive from '@radix-ui/react-popover'
import { clsx } from 'clsx'
import type { ComponentProps } from 'react'

export const Popover = Primitive.Root
export const PopoverTrigger = Primitive.Trigger
export function PopoverContent({
  className,
  align = 'start',
  sideOffset = 6,
  ...props
}: ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        align={align}
        sideOffset={sideOffset}
        className={clsx(
          'z-50 w-[var(--radix-popover-trigger-width)] max-w-[calc(100vw-2rem)] rounded-md border border-border bg-card text-foreground shadow-xl outline-none',
          className,
        )}
        {...props}
      />
    </Primitive.Portal>
  )
}
