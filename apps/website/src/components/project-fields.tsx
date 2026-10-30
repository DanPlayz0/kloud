import { Input, Label } from './ui/controls'

export function ProjectFields() {
  return (
    <>
      <Label>
        Project name
        <Input name="name" required maxLength={100} placeholder="Miki" />
      </Label>
      <Label>
        Project slug
        <Input
          name="slug"
          required
          pattern="[a-z0-9]+(-[a-z0-9]+)*"
          maxLength={100}
          placeholder="miki"
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
