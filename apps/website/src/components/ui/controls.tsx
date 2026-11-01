import { useImperativeHandle, useContext, type ComponentProps } from 'react'
import { useFieldControl, FieldContext } from './field-control'
import { Slot } from '@radix-ui/react-slot'
import * as LabelPrimitive from '@radix-ui/react-label'
import * as CheckboxPrimitive from '@radix-ui/react-checkbox'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'
import { Check, Minus } from 'lucide-react'

// shadcn/ui's Radix composition, adapted to the dashboard's CSS theme.
// https://ui.shadcn.com/docs/components/radix/button
const buttonVariants = cva(
  'ui-button bg-secondary text-foreground border-border',
  {
    variants: {
      variant: {
        default: '',
        primary: 'primary',
        destructive: 'danger',
        ghost: 'ui-button-ghost',
        outline: 'ui-button-outline',
        choice: 'ui-button-choice',
        link: 'ui-button-link',
      },
      size: { default: '', sm: 'ui-button-sm', icon: 'ui-button-icon' },
    },
    defaultVariants: { variant: 'default' },
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
        'ui-input bg-muted text-foreground border-border',
        className,
      )}
      {...props}
      {...field}
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
      className={cn('ui-label text-muted-foreground', className)}
      {...props}
    />
  )
}
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
        'ui-input min-h-28 w-full bg-muted text-foreground border-border font-mono text-sm',
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
        'ui-native-select bg-muted text-foreground border-border',
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
  return (
    <CheckboxPrimitive.Root
      id={props.id ?? field?.id}
      data-slot="checkbox"
      className={cn('ui-checkbox', className)}
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
