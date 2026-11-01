import * as Collapsible from '@radix-ui/react-collapsible'
import { ChevronDown } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Button } from './ui/controls'

/** Categories remain expanded on desktop; mobile users can reduce navigation clutter. */
export function NavigationGroup({
  title,
  mobile,
  children,
}: {
  title: string
  mobile: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(true)
  if (!mobile)
    return (
      <div className="nav-group">
        <p>{title}</p>
        {children}
      </div>
    )
  return (
    <Collapsible.Root className="nav-group" open={open} onOpenChange={setOpen}>
      <Collapsible.Trigger asChild>
        <Button
          variant="ghost"
          className="mb-1 min-h-11 w-full justify-between text-xs font-semibold tracking-wide text-sidebar-muted"
        >
          {title}
          <ChevronDown
            aria-hidden="true"
            className={open ? 'rotate-180' : ''}
          />
        </Button>
      </Collapsible.Trigger>
      <Collapsible.Content>{children}</Collapsible.Content>
    </Collapsible.Root>
  )
}
