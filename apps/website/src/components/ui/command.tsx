import { Command as Primitive } from 'cmdk'
import { Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ComponentProps } from 'react'

export function Command({
  className,
  ...props
}: ComponentProps<typeof Primitive>) {
  return (
    <Primitive
      className={cn(
        'flex flex-col overflow-hidden rounded-md bg-card text-foreground',
        className,
      )}
      {...props}
    />
  )
}
export function CommandInput(props: ComponentProps<typeof Primitive.Input>) {
  return (
    <div className="flex items-center gap-2 border-b border-border px-3">
      <Search
        className="size-4 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <Primitive.Input
        className="h-11 min-w-0 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        {...props}
      />
    </div>
  )
}
export function CommandList(props: ComponentProps<typeof Primitive.List>) {
  return (
    <Primitive.List
      className="max-h-[min(18rem,40dvh)] overflow-y-auto p-1"
      {...props}
    />
  )
}
export function CommandEmpty(props: ComponentProps<typeof Primitive.Empty>) {
  return (
    <Primitive.Empty
      className="px-3 py-6 text-center text-sm text-muted-foreground"
      {...props}
    />
  )
}
export function CommandItem({
  className,
  ...props
}: ComponentProps<typeof Primitive.Item>) {
  return (
    <Primitive.Item
      className={cn(
        'flex cursor-pointer items-center gap-2 rounded-sm px-2 py-2 text-sm outline-none data-[selected=true]:bg-secondary data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-50',
        className,
      )}
      {...props}
    />
  )
}

export function CommandGroup({
  className,
  ...props
}: ComponentProps<typeof Primitive.Group>) {
  return (
    <Primitive.Group
      className={cn(
        'overflow-hidden p-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-muted-foreground',
        className,
      )}
      {...props}
    />
  )
}
