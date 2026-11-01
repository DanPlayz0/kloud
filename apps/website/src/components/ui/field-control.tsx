import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type ChangeEvent,
  type InvalidEvent,
} from 'react'

export const FieldContext = createContext<{
  id: string
  error: string
  setError: (message: string) => void
  descriptions: string[]
  registerDescription: (id: string) => () => void
} | null>(null)
export const DisabledFieldContext = createContext(false)

export function useFieldControl<
  T extends HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
>(props: {
  id?: string
  validationMessage?: string
  'aria-describedby'?: string
  'aria-invalid'?: boolean | 'true' | 'false' | 'grammar' | 'spelling'
  onInvalid?: (event: InvalidEvent<T>) => void
  onChange?: (event: ChangeEvent<T>) => void
}) {
  const field = useContext(FieldContext)
  const element = useRef<T | null>(null)
  useEffect(() => {
    if (props.validationMessage !== undefined) {
      element.current?.setCustomValidity(props.validationMessage)
      field?.setError(props.validationMessage)
    }
  }, [props.validationMessage, field?.setError])
  useEffect(() => {
    const control = element.current
    if (!control || !field) return
    const invalid = () =>
      field.setError(
        control.getAttribute('data-validation-error') ||
          control.validationMessage ||
          '',
      )
    control.addEventListener('field-invalid', invalid)
    return () => control.removeEventListener('field-invalid', invalid)
  }, [field])
  return {
    ref: element,
    id: props.id ?? field?.id,
    'aria-invalid': props['aria-invalid'] ?? (field?.error ? true : undefined),
    'aria-describedby':
      [
        props['aria-describedby'],
        ...(field?.descriptions ?? []),
        field?.error ? `${field.id}-error` : undefined,
      ]
        .filter(Boolean)
        .join(' ') || undefined,
    onInvalid(event: InvalidEvent<T>) {
      field?.setError(event.currentTarget.validationMessage)
      props.onInvalid?.(event)
    },
    onChange(event: ChangeEvent<T>) {
      if (props.validationMessage === undefined) field?.setError('')
      event.currentTarget.removeAttribute('data-validation-error')
      props.onChange?.(event)
    },
  }
}

/** Associate server/schema validation with the same field used by native validation. */
export function markFieldInvalid(
  control: HTMLElement | null | undefined,
  message: string,
) {
  if (!control) return
  control.setAttribute('data-validation-error', message)
  control.dispatchEvent(new Event('field-invalid'))
}
