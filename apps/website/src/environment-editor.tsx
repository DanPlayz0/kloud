import { FieldGroup, Field, FieldLabel } from '@/components/ui/field'
import { useEffect, useState } from 'react'
import {
  parseEnvironment,
  formatEnvironment,
} from '@kloud/protocol/environment'
import { api } from './api'
import { ErrorMessage } from './components'
import { ToggleGroup, ToggleGroupItem } from './components/ui/toggle-group'
import { Button, Input, Textarea } from './components/ui/controls'

export function EnvironmentEditor({
  value,
  onChange,
  revealUrl,
  onReveal,
  allowPlaintext = false,
}: {
  value: Record<string, string>
  onChange: (value: Record<string, string>) => void
  revealUrl?: string
  onReveal?: (original: Record<string, string>) => void
  /** New, locally entered values do not require revealing saved secrets. */
  allowPlaintext?: boolean
}) {
  const [mode, setMode] = useState<'normal' | 'developer'>('normal')
  const [rows, setRows] = useState(() => Object.entries(value))
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [revealed, setRevealed] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (mode === 'normal')
      setRows((previous) => [
        ...Object.entries(value),
        ...previous.filter(([key]) => !key),
      ])
  }, [value])
  function update(next: [string, string][]) {
    setRows(next)
    const names = next.map(([key]) => key).filter(Boolean)
    if (new Set(names).size !== names.length) {
      setError('Variable names must be unique.')
      return
    }
    if (names.some((key) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) {
      setError(
        'Use letters, digits, and underscores; start with a letter or underscore.',
      )
      return
    }
    setError('')
    onChange(Object.fromEntries(next.filter(([key]) => key)))
  }
  async function developer() {
    setError('')
    if (!allowPlaintext && !revealed) {
      if (!revealUrl) return
      if (
        !window.confirm(
          'Load the complete plaintext variables into this editor?',
        )
      )
        return
      setBusy(true)
      try {
        const result = await api<{ text: string }>(revealUrl)
        const original = parseEnvironment(result.text)
        // Preserve unsaved additions, deletions and edits in normal mode.
        const next = Object.fromEntries(
          Object.entries(value).map(([key, v]) => [
            key,
            v === '********' && Object.hasOwn(original, key)
              ? original[key]!
              : v,
          ]),
        )
        onChange(next)
        onReveal?.(original)
        setRevealed(true)
        setText(formatEnvironment(next))
        setMode('developer')
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Unable to reveal variables')
      } finally {
        setBusy(false)
      }
    } else {
      setText(formatEnvironment(value))
      setMode('developer')
    }
  }
  return (
    <div className="flex flex-col gap-3">
      <ToggleGroup
        type="single"
        value={mode}
        spacing={2}
        aria-label="Environment editor mode"
        onValueChange={(value) => {
          if (!value || value === mode) return
          if (value === 'developer') {
            void developer()
            return
          }
          try {
            const next = parseEnvironment(text)
            onChange(next)
            setRows(Object.entries(next))
            setError('')
            setMode('normal')
          } catch (e) {
            setError(e instanceof Error ? e.message : 'Invalid document')
          }
        }}
      >
        <ToggleGroupItem value="normal" disabled={busy}>
          Normal
        </ToggleGroupItem>
        <ToggleGroupItem
          value="developer"
          disabled={busy || (!allowPlaintext && !revealUrl)}
        >
          Developer .env
        </ToggleGroupItem>
      </ToggleGroup>
      {!allowPlaintext && !revealUrl && (
        <p className="text-xs text-muted-foreground">
          Full developer mode requires a saved draft and the separate Reveal
          service secrets permission. Masked editing remains available.
        </p>
      )}
      <ErrorMessage message={error} />
      {mode === 'developer' ? (
        <Field>
          <FieldLabel>Complete .env document</FieldLabel>
          <Textarea
            placeholder="Paste your existing .env here"
            validationMessage={error}
            rows={16}
            value={text}
            spellCheck={false}
            onChange={(e) => {
              setText(e.target.value)
              try {
                onChange(parseEnvironment(e.target.value))
                setError('')
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Invalid document')
              }
            }}
          />
          <span className="text-xs text-muted-foreground">
            {allowPlaintext
              ? 'Paste your complete .env to import its variables. '
              : 'Omitted keys are deleted after review. '}
            Dollar signs are literal. Double quotes support escaped newlines,
            tabs, quotes and backslashes; quoted values may span lines.
          </span>
        </Field>
      ) : (
        <>
          {rows.map(([key, v], index) => (
            <FieldGroup key={index} className="flex items-end gap-2 flex-row">
              <Field className="min-w-0 flex-1">
                <FieldLabel>Variable name</FieldLabel>
                <Input
                  required
                  pattern="[A-Za-z_][A-Za-z0-9_]*"
                  validationMessage={error}
                  value={key}
                  onChange={(e) =>
                    update(
                      rows.map((row, i) =>
                        i === index ? [e.target.value, row[1]] : row,
                      ),
                    )
                  }
                />
              </Field>
              <Field className="min-w-0 flex-1">
                <FieldLabel>Value</FieldLabel>
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={v}
                  onChange={(e) =>
                    update(
                      rows.map((row, i) =>
                        i === index ? [row[0], e.target.value] : row,
                      ),
                    )
                  }
                />
              </Field>
              <Button
                type="button"
                onClick={() => update(rows.filter((_, i) => i !== index))}
              >
                Remove
              </Button>
            </FieldGroup>
          ))}
          <Button type="button" onClick={() => setRows([...rows, ['', '']])}>
            Add variable
          </Button>
        </>
      )}
    </div>
  )
}
