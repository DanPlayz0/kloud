import { Form } from '@/components/ui/form'
import type { ComponentProps, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from './ui/card'

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
      <CardHeader className="inventory-card-header">
        <div className="inventory-card-icon bg-muted text-muted-foreground border-border">
          <Icon size={20} aria-hidden="true" />
        </div>
        <div className="inventory-card-identity">
          <CardTitle asChild>
            <h3>{name}</h3>
          </CardTitle>
          <CardDescription>{metadata}</CardDescription>
        </div>
        {status}
      </CardHeader>
      <CardContent>
        <Form
          className="inventory-card-form border-border"
          aria-label={`Assignment for ${name}`}
          onSubmit={onSubmit}
        >
          {children}
        </Form>
      </CardContent>
    </Card>
  )
}
