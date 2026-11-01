import { Field, FieldLabel, FieldDescription } from '@/components/ui/field'
import { useState } from 'react'
import { Input } from './ui/controls'

export function ProjectFields() {
  const [name, setName] = useState('')
  const [customSlug, setCustomSlug] = useState<string>()
  const generatedSlug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
    .replace(/-+$/g, '')

  return (
    <>
      <Field>
        <FieldLabel>Project name</FieldLabel>
        <Input
          name="name"
          required
          maxLength={100}
          placeholder="Your project name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel>Project slug</FieldLabel>
        <Input
          name="slug"
          required
          pattern="[a-z0-9]+(-[a-z0-9]+)*"
          maxLength={100}
          placeholder="your-project-slug"
          value={customSlug ?? generatedSlug}
          onChange={(event) => setCustomSlug(event.target.value || undefined)}
        />
        <FieldDescription>
          Generated from the project name. Use lowercase letters, numbers, and
          hyphens.
        </FieldDescription>
      </Field>
    </>
  )
}

export function projectFormValues(form: HTMLFormElement) {
  const data = new FormData(form)
  return {
    name: String(data.get('name') ?? ''),
    slug: String(data.get('slug') ?? ''),
  }
}
