import { useState } from 'react'
import { Input, Label } from './ui/controls'

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
      <Label>
        Project name
        <Input
          name="name"
          required
          maxLength={100}
          placeholder="Miki"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </Label>
      <Label>
        Project slug
        <Input
          name="slug"
          required
          pattern="[a-z0-9]+(-[a-z0-9]+)*"
          maxLength={100}
          placeholder="miki"
          value={customSlug ?? generatedSlug}
          onChange={(event) => setCustomSlug(event.target.value || undefined)}
        />
      </Label>
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
