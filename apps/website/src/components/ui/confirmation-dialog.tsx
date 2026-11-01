import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from './controls'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogCancel,
  AlertDialogAction,
} from './alert-dialog'

interface ConfirmationOptions {
  title: string
  description: ReactNode
  actionLabel?: string
  variant?: 'default' | 'destructive'
}

/** Accessible replacement for browser confirmations, shared by async actions. */
export function useConfirmation() {
  const [options, setOptions] = useState<ConfirmationOptions | null>(null)
  const pending = useRef<((accepted: boolean) => void) | null>(null)
  const trigger = useRef<HTMLElement | null>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      pending.current?.(false)
      pending.current = null
    }
  }, [])
  const settle = useCallback((accepted: boolean) => {
    const resolve = pending.current
    pending.current = null
    setOptions(null)
    resolve?.(accepted)
  }, [])
  const confirm = useCallback((request: string | ConfirmationOptions) => {
    if (!mounted.current || pending.current) return Promise.resolve(false)
    trigger.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    setOptions(
      typeof request === 'string'
        ? { title: 'Confirm action', description: request }
        : request,
    )
    return new Promise<boolean>((resolve) => {
      pending.current = resolve
    })
  }, [])
  const confirmationDialog = (
    <AlertDialog
      open={options !== null}
      onOpenChange={(open) => {
        if (!open) settle(false)
      }}
    >
      <AlertDialogContent
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          cancel.current?.focus()
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (trigger.current?.isConnected) trigger.current.focus()
        }}
      >
        <AlertDialogTitle>{options?.title}</AlertDialogTitle>
        <AlertDialogDescription className="whitespace-pre-line">
          {options?.description}
        </AlertDialogDescription>
        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <AlertDialogCancel asChild>
            <Button
              ref={cancel}
              type="button"
              variant="outline"
              onClick={() => settle(false)}
            >
              Cancel
            </Button>
          </AlertDialogCancel>
          <AlertDialogAction asChild>
            <Button
              type="button"
              variant={options?.variant ?? 'default'}
              onClick={() => settle(true)}
            >
              {options?.actionLabel ?? 'Continue'}
            </Button>
          </AlertDialogAction>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  )
  return { confirm, confirmationDialog }
}
