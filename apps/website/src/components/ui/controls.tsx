import { useImperativeHandle, useContext, type ComponentProps } from 'react'
import {
  useFieldControl,
  FieldContext,
  DisabledFieldContext,
} from './field-control'
import { Slot } from '@radix-ui/react-slot'
import * as CheckboxPrimitive from '@radix-ui/react-checkbox'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'
import { Check, Minus } from 'lucide-react'

// shadcn/ui's Radix composition, adapted to the dashboard's CSS theme.
// https://ui.shadcn.com/docs/components/radix/button
export const buttonVariants = cva(
  "ui-button inline-flex min-h-9 min-w-0 max-w-full shrink-0 items-center justify-center gap-2 rounded-md border border-transparent px-4 py-2 text-sm font-medium whitespace-normal break-words transition-[color,background-color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-[3px] aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground shadow-xs hover:bg-primary/90',
        primary:
          'primary bg-primary text-primary-foreground shadow-xs hover:bg-primary/90',
        secondary:
          'bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80',
        destructive:
          'bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/90 focus-visible:ring-destructive/30',
        outline:
          'border-input bg-background text-foreground shadow-xs hover:bg-accent hover:text-accent-foreground',
        ghost:
          'bg-transparent text-foreground hover:bg-accent hover:text-accent-foreground',
        choice:
          'h-auto justify-start rounded-xl border-border bg-card p-6 text-card-foreground hover:bg-accent aria-pressed:border-primary',
        link: 'min-h-0 rounded-none bg-transparent p-0 text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: '',
        xs: 'min-h-7 px-2 py-1 text-xs',
        sm: 'min-h-8 px-3 py-1.5 text-xs',
        lg: 'min-h-10 px-6',
        icon: 'size-9 min-h-9 p-0',
        'icon-sm': 'size-8 min-h-8 p-0',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'default' },
  },
)
export function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Component = asChild ? Slot : 'button'
  return (
    <Component
      data-slot="button"
      data-variant={variant ?? 'secondary'}
      data-size={size ?? 'default'}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  )
}
export function Input({
  className,
  type,
  ref,
  validationMessage,
  ...props
}: ComponentProps<'input'> & { validationMessage?: string }) {
  const field = useFieldControl<HTMLInputElement>({
    ...props,
    validationMessage,
  })
  useImperativeHandle(ref, () => field.ref.current!)
  return (
    <input
      data-slot="input"
      type={type}
      className={cn(
        'ui-input flex h-9 w-full min-w-0 rounded-md border border-input bg-input/20 px-3 py-1 text-base text-foreground md:text-sm shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground file:mr-3 file:rounded-sm file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20',
        className,
      )}
      {...props}
      {...field}
    />
  )
}
export { Label } from './label'
export function Textarea({
  className,
  ref,
  validationMessage,
  ...props
}: ComponentProps<'textarea'> & { validationMessage?: string }) {
  const field = useFieldControl<HTMLTextAreaElement>({
    ...props,
    validationMessage,
  })
  useImperativeHandle(ref, () => field.ref.current!)
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'ui-input flex min-h-28 w-full min-w-0 rounded-md border border-input bg-input/20 px-3 py-2 text-base text-foreground md:text-sm shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20',
        className,
      )}
      {...props}
      {...field}
    />
  )
}
// NativeSelect is a shadcn/ui component; native platform selection preserves
// keyboard and mobile behavior for these short project lists.
export function NativeSelect({
  className,
  ref,
  ...props
}: ComponentProps<'select'>) {
  const field = useFieldControl<HTMLSelectElement>(props)
  useImperativeHandle(ref, () => field.ref.current!)
  return (
    <select
      data-slot="native-select"
      className={cn(
        'ui-native-select h-9 w-full min-w-0 rounded-md border border-input bg-input/20 px-3 py-1 text-base text-foreground md:text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 [&>option]:bg-popover [&>option]:text-popover-foreground',
        className,
      )}
      {...props}
      {...field}
    />
  )
}
export function Checkbox({
  className,
  checked,
  ...props
}: ComponentProps<typeof CheckboxPrimitive.Root>) {
  const field = useContext(FieldContext)
  const disabled = useContext(DisabledFieldContext) || props.disabled
  return (
    <CheckboxPrimitive.Root
      id={props.id ?? field?.id}
      data-slot="checkbox"
      className={cn(
        'ui-checkbox peer inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input bg-input/20 text-primary-foreground shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary aria-invalid:border-destructive aria-invalid:ring-destructive/20',
        className,
      )}
      checked={checked}
      {...props}
      disabled={disabled}
      aria-invalid={props['aria-invalid'] ?? (field?.error ? true : undefined)}
      aria-describedby={
        [
          props['aria-describedby'],
          ...(field?.descriptions ?? []),
          field?.error ? `${field.id}-error` : undefined,
        ]
          .filter(Boolean)
          .join(' ') || undefined
      }
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center">
        {checked === 'indeterminate' ? (
          <Minus size={11} strokeWidth={2} aria-hidden="true" />
        ) : (
          <Check size={11} strokeWidth={2} aria-hidden="true" />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}
