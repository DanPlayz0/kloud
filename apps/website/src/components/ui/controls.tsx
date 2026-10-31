import type { ComponentProps } from 'react'
import { Slot } from '@radix-ui/react-slot'
import * as LabelPrimitive from '@radix-ui/react-label'
import * as CheckboxPrimitive from '@radix-ui/react-checkbox'
import { cva, type VariantProps } from 'class-variance-authority'
import { clsx } from 'clsx'
import { Check, Minus } from 'lucide-react'

// shadcn/ui's Radix composition, adapted to the dashboard's CSS theme.
// https://ui.shadcn.com/docs/components/radix/button
const buttonVariants = cva(
  'ui-button bg-secondary text-foreground border-border',
  {
    variants: {
      variant: { default: '', primary: 'primary', destructive: 'danger' },
    },
    defaultVariants: { variant: 'default' },
  },
)
export function Button({
  className,
  variant,
  asChild = false,
  ...props
}: ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Component = asChild ? Slot : 'button'
  return (
    <Component
      data-slot="button"
      className={clsx(buttonVariants({ variant }), className)}
      {...props}
    />
  )
}
export function Input({ className, type, ...props }: ComponentProps<'input'>) {
  return (
    <input
      data-slot="input"
      type={type}
      className={clsx(
        'ui-input bg-muted text-foreground border-border',
        className,
      )}
      {...props}
    />
  )
}
export function Label({
  className,
  ...props
}: ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={clsx('ui-label text-muted-foreground', className)}
      {...props}
    />
  )
}
export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={clsx(
        'ui-input min-h-28 w-full bg-muted text-foreground border-border font-mono text-sm',
        className,
      )}
      {...props}
    />
  )
}
// NativeSelect is a shadcn/ui component; native platform selection preserves
// keyboard and mobile behavior for these short project lists.
export function NativeSelect({
  className,
  ...props
}: ComponentProps<'select'>) {
  return (
    <select
      data-slot="native-select"
      className={clsx(
        'ui-native-select bg-muted text-foreground border-border',
        className,
      )}
      {...props}
    />
  )
}
export function Checkbox({
  className,
  checked,
  ...props
}: ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={clsx('ui-checkbox', className)}
      checked={checked}
      {...props}
    >
      <CheckboxPrimitive.Indicator>
        {checked === 'indeterminate' ? (
          <Minus size={11} strokeWidth={2} aria-hidden="true" />
        ) : (
          <Check size={11} strokeWidth={2} aria-hidden="true" />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}
