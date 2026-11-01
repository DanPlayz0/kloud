import { isValidElement, type ComponentProps, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import {
  Tooltip,
  TooltipContent,
  TooltipPortal,
  TooltipProvider,
  TooltipTrigger,
} from './ui/tooltip'

type Props = {
  children: ReactNode
  content: ReactNode
  disabled?: boolean
  instant?: boolean
  className?: string
  portal?: boolean
  keybind?: string[]
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'center' | 'end' | 'start'
  contentProps?: ComponentProps<typeof TooltipContent>
}

export type QuickTipProps = Partial<Props>

// Adapted from the supplied QuickTip to use this project's theme and imports.
export default function QuickTip({
  children,
  content,
  disabled,
  instant,
  className,
  side,
  align,
  contentProps,
  portal,
  keybind,
  ...tooltipProps
}: Props & ComponentProps<typeof Tooltip>) {
  // Radix must attach its events and ref to an HTML element. Text, fragments,
  // SVGs, and icon components (including Lucide) get a focusable HTML wrapper.
  const trigger =
    isValidElement(children) &&
    typeof children.type === 'string' &&
    children.type !== 'svg' ? (
      children
    ) : (
      <span
        tabIndex={0}
        className="inline-flex max-w-full items-center align-middle"
      >
        {children}
      </span>
    )
  const tooltipContent = (
    <TooltipContent
      side={side}
      align={align}
      {...contentProps}
      className={cn(
        keybind?.length && 'flex items-center gap-2',
        className,
        contentProps?.className,
      )}
    >
      {content}
      {keybind?.length ? (
        <span className="flex items-center gap-1">
          {keybind.map((key, index) => (
            <kbd
              key={index}
              className="rounded border border-border bg-muted px-1 text-xs text-muted-foreground"
            >
              {key}
            </kbd>
          ))}
        </span>
      ) : null}
    </TooltipContent>
  )
  return (
    <TooltipProvider>
      <Tooltip
        {...tooltipProps}
        open={disabled ? false : tooltipProps.open}
        delayDuration={instant ? 0 : tooltipProps.delayDuration}
      >
        <TooltipTrigger asChild>{trigger}</TooltipTrigger>
        {portal ? (
          <TooltipPortal>{tooltipContent}</TooltipPortal>
        ) : (
          tooltipContent
        )}
      </Tooltip>
    </TooltipProvider>
  )
}
