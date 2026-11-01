import { useRef, useState, useEffect, type ReactNode } from 'react'
import * as Primitive from '@radix-ui/react-collapsible'
import { ChevronDown } from 'lucide-react'
import { Button } from './controls'
import { Card } from './card'

/** shadcn/Radix composition with persistent form fields and validation reveal. */
export function CollapsibleSection({
  title,
  count,
  children,
}: {
  title: string
  count?: number
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = root.current
    const reveal = () => setOpen(true)
    element?.addEventListener('reveal-settings', reveal)
    return () => element?.removeEventListener('reveal-settings', reveal)
  }, [])
  return (
    <Card size="flush" asChild>
      <Primitive.Root
        ref={root}
        open={open}
        onOpenChange={setOpen}
        data-settings-section={title}
        onInvalidCapture={(event) => {
          event.preventDefault()
          setOpen(true)
        }}
      >
        <Primitive.Trigger asChild>
          <Button
            type="button"
            className="!h-auto w-full !justify-between !border-0 !bg-transparent !p-4 text-left"
            aria-label={title}
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="font-medium">{title}</span>
              {count !== undefined && (
                <span className="rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
                  {count}
                </span>
              )}
            </span>
            <ChevronDown
              aria-hidden="true"
              size={16}
              className={`shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`}
            />
          </Button>
        </Primitive.Trigger>
        <Primitive.Content
          forceMount
          hidden={!open}
          className="min-w-0 px-4 pb-4"
        >
          {children}
        </Primitive.Content>
      </Primitive.Root>
    </Card>
  )
}
