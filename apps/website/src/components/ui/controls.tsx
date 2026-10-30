import type { ComponentProps } from 'react'
import { Slot } from '@radix-ui/react-slot'
import * as LabelPrimitive from '@radix-ui/react-label'
import * as CheckboxPrimitive from '@radix-ui/react-checkbox'
import { cva, type VariantProps } from 'class-variance-authority'
import { clsx } from 'clsx'

// shadcn/ui's Radix composition, adapted to the dashboard's CSS theme.
// https://ui.shadcn.com/docs/components/radix/button
const buttonVariants = cva('ui-button', {
  variants: {
    variant: { default: '', primary: 'primary', destructive: 'danger' },
  },
  defaultVariants: { variant: 'default' },
})
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
      className={clsx('ui-input', className)}
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
      className={clsx('ui-label', className)}
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
      className={clsx('ui-native-select', className)}
      {...props}
    />
  )
}
export function Checkbox({
  className,
  ...props
}: ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={clsx('ui-checkbox', className)}
      {...props}
    >
      <CheckboxPrimitive.Indicator>
        <svg
          width="11"
          height="11"
          viewBox="0 0 16 16"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="m3 8 3 3 7-7" />
        </svg>
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}
