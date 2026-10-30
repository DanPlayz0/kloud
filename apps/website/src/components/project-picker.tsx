import { useRef, useState, type FormEvent } from 'react'
import { Check, ChevronsUpDown, Plus } from 'lucide-react'
import { api, hasServer, type Project, type User } from '../api'
import { Button } from './ui/controls'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from './ui/command'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from './ui/dialog'
import { ProjectFields, projectFormValues } from './project-fields'

export function ProjectPicker({
  user,
  projects,
  project,
}: {
  user: User
  projects: Project[]
  project?: string
}) {
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submitting = useRef(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const canCreate = hasServer(user, 'projects.create')
  const filtered = projects.filter((p) =>
    `${p.name}\n${p.slug}`.toLowerCase().includes(query.toLowerCase().trim()),
  )
  const navigate = (slug: string) =>
    location.assign(`/projects/${encodeURIComponent(slug)}/compute/containers`)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting.current || !canCreate) return
    const values = projectFormValues(event.currentTarget)
    submitting.current = true
    setBusy(true)
    setError('')
    try {
      await api('/admin/projects', 'POST', values)
      setCreating(false)
      navigate(values.slug)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to create project')
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  return (
    <div className="project-picker">
      <Popover
        open={open}
        onOpenChange={(value) => {
          setOpen(value)
          if (!value) setQuery('')
        }}
      >
        <PopoverTrigger asChild>
          <Button
            ref={trigger}
            type="button"
            aria-label="Project"
            className="flex w-full min-w-0 items-center justify-between gap-2 bg-card px-3 py-3 text-xs font-semibold"
          >
            <span className="truncate">
              {projects.find((p) => p.slug === project)?.name ??
                'Select project'}
            </span>
            <ChevronsUpDown
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          aria-label="Select project"
          onCloseAutoFocus={(event) => {
            if (creating) event.preventDefault()
          }}
        >
          <Command shouldFilter={false}>
            <CommandInput
              aria-label="Search projects"
              placeholder="Search projects…"
              value={query}
              onValueChange={setQuery}
            />
            <CommandList label="Projects">
              <CommandEmpty>No projects found</CommandEmpty>
              {filtered.map((p) => (
                <CommandItem
                  key={p.slug}
                  value={p.slug}
                  onSelect={() => {
                    setOpen(false)
                    navigate(p.slug)
                  }}
                >
                  <Check
                    className={`size-4 shrink-0 ${project === p.slug ? 'opacity-100' : 'opacity-0'}`}
                    aria-hidden="true"
                  />
                  <span className="min-w-0">
                    <span className="block truncate">{p.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {p.slug}
                    </span>
                  </span>
                </CommandItem>
              ))}
            </CommandList>
          </Command>
          {canCreate && (
            <div className="border-t border-border p-1">
              <Button
                type="button"
                className="flex w-full items-center gap-2 text-left text-sm"
                onClick={() => {
                  setError('')
                  setCreating(true)
                  setOpen(false)
                  setQuery('')
                }}
              >
                <Plus className="size-4" aria-hidden="true" />
                Create project
              </Button>
            </div>
          )}
        </PopoverContent>
      </Popover>
      <Dialog
        open={creating}
        onOpenChange={(value) => {
          if (!submitting.current) setCreating(value)
        }}
      >
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            trigger.current?.focus()
          }}
          onEscapeKeyDown={(event) => {
            if (submitting.current) event.preventDefault()
          }}
          onInteractOutside={(event) => {
            if (submitting.current) event.preventDefault()
          }}
        >
          <DialogTitle className="text-lg font-semibold">
            Create project
          </DialogTitle>
          <DialogDescription className="mt-2 text-sm text-muted-foreground">
            Create a project on this infrastructure.
          </DialogDescription>
          <form onSubmit={submit} className="mt-5 space-y-4" aria-busy={busy}>
            <fieldset disabled={busy} className="min-w-0 space-y-4">
              <ProjectFields />
            </fieldset>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                disabled={busy}
                onClick={() => setCreating(false)}
              >
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={busy}>
                {busy ? 'Creating…' : 'Create project'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
