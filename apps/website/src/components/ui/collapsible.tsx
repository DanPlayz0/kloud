import { cn } from '@/lib/utils'
import { useRef, useState, useEffect, type ReactNode } from 'react'
import * as Primitive from '@radix-ui/react-collapsible'
import { ChevronDown } from 'lucide-react'
import { Button } from './controls'
import { Card } from './card'
import { Badge } from './badge'

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
            className="h-auto w-full justify-between p-4 text-left"
            variant="ghost"
            aria-label={title}
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="font-medium">{title}</span>
              {count !== undefined && <Badge variant="outline">{count}</Badge>}
            </span>
            <ChevronDown
              data-icon="inline-start"
              aria-hidden="true"

              className={cn(
                'shrink-0 text-muted-foreground transition-transform',
                open ? 'rotate-180' : '',
              )}
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
