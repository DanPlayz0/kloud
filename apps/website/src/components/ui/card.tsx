import { Children, isValidElement, type ComponentProps } from 'react'
import { cn } from '@/lib/utils'
import { FieldSet, FieldGroup, FieldLegend } from './field'
import { Form } from './form'
import { Slot } from '@radix-ui/react-slot'

/** Shared surface, with explicit spacing so page CSS cannot override utilities. */
export function Card({
  className,
  size = 'default',
  asChild = false,
  ...props
}: ComponentProps<'div'> & {
  size?: 'default' | 'compact' | 'flush'
  asChild?: boolean
}) {
  const Component = asChild ? Slot : 'div'
  return (
    <Component
      data-slot="card"
      data-size={size}
      className={cn('ui-card bg-card text-foreground border-border', className)}
      {...props}
    />
  )
}

/** Keep wide tables contained without changing their native table semantics. */
export function TableCard({ className, ...props }: ComponentProps<'div'>) {
  return (
    <Card
      size="flush"
      className={cn('relative overflow-x-auto', className)}
      {...props}
    />
  )
}

export function FormCard({ className, ...props }: ComponentProps<'form'>) {
  return (
    <Card asChild>
      <Form className={cn('inline-form', className)} {...props} />
    </Card>
  )
}

export function CardFieldset({
  className,
  ...props
}: ComponentProps<'fieldset'>) {
  const children = Children.toArray(props.children)
  const isLegend = (child: (typeof children)[number]) =>
    isValidElement(child) && child.type === FieldLegend
  return (
    <Card size="compact" asChild>
      <FieldSet className={className} {...props}>
        {children.filter(isLegend)}
        <FieldGroup>{children.filter((child) => !isLegend(child))}</FieldGroup>
      </FieldSet>
    </Card>
  )
}

export function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-header"
      className={cn('flex flex-col gap-2', className)}
      {...props}
    />
  )
}
export function CardTitle({
  className,
  asChild = false,
  ...props
}: ComponentProps<'h2'> & { asChild?: boolean }) {
  const Component = asChild ? Slot : 'h2'
  return (
    <Component
      data-slot="card-title"
      className={cn('font-semibold', className)}
      {...props}
    />
  )
}
export function CardDescription({ className, ...props }: ComponentProps<'p'>) {
  return (
    <p
      data-slot="card-description"
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  )
}
export function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-content"
      className={cn('flex min-w-0 flex-col gap-3', className)}
      {...props}
    />
  )
}
export function CardFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-footer"
      className={cn('flex items-center gap-2', className)}
      {...props}
    />
  )
}
