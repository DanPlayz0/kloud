import type { ComponentProps, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Card } from './ui/card'

export function InventoryCard({
  name,
  icon: Icon,
  metadata,
  status,
  children,
  onSubmit,
}: {
  name: string
  icon: LucideIcon
  metadata: ReactNode
  status: ReactNode
  children: ReactNode
  onSubmit: ComponentProps<'form'>['onSubmit']
}) {
  return (
    <Card size="flush" className="inventory-card">
      <div className="inventory-card-header">
        <div className="inventory-card-icon bg-muted text-muted-foreground border-border">
          <Icon size={20} aria-hidden="true" />
        </div>
        <div className="inventory-card-identity">
          <h3 className="text-sm font-semibold text-foreground">{name}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{metadata}</p>
        </div>
        {status}
      </div>
      <form
        className="inventory-card-form border-border"
        aria-label={`Assignment for ${name}`}
        onSubmit={onSubmit}
      >
        {children}
      </form>
    </Card>
  )
}
