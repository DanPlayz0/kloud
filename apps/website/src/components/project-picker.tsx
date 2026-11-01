import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Check, ChevronsUpDown, FolderKanban, Plus, Server } from 'lucide-react'
import { api, hasServer, type Project, type User, type Connector } from '../api'
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

function ProjectMark({
  project,
  compact = false,
}: {
  project?: Project
  compact?: boolean
}) {
  return (
    <span
      aria-hidden="true"
      className={`project-mark flex shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground ${compact ? 'size-7 text-[10px]' : 'size-9 text-xs'}`}
    >
      {project ? (
        project.name.trim().slice(0, 2).toUpperCase()
      ) : (
        <FolderKanban className="size-4" />
      )}
    </span>
  )
}

export function ProjectPicker({
  user,
  projects,
  project,
  connector,
  connectors = [],
  connectorError = '',
  showConnectors = false,
}: {
  user: User
  projects: Project[]
  project?: string
  connector?: Connector
  connectors?: Connector[]
  connectorError?: string
  showConnectors?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [mobile, setMobile] = useState(
    () => window.matchMedia('(max-width: 720px)').matches,
  )
  useEffect(() => {
    const media = window.matchMedia('(max-width: 720px)')
    const update = () => setMobile(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  const submitting = useRef(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const current = projects.find((p) => p.slug === project)
  const canCreate = hasServer(user, 'projects.create')
  const filtered = projects.filter((p) =>
    `${p.name}\n${p.slug}`.toLowerCase().includes(query.toLowerCase().trim()),
  )
  const filteredConnectors = connectors.filter((c) =>
    [c.name, c.host, c.id]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(query.toLowerCase().trim()),
  )
  const navigate = (slug: string) =>
    location.assign(`/projects/${encodeURIComponent(slug)}/services`)

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
            aria-label={showConnectors ? 'Project or connector' : 'Project'}
            className="project-picker-trigger w-full min-w-0 bg-background text-foreground"
          >
            {connector ? (
              <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground">
                <Server className="size-4" aria-hidden="true" />
              </span>
            ) : (
              <ProjectMark project={current} />
            )}
            <span className="grid min-w-0 flex-1 gap-1 text-left leading-tight">
              <span className="truncate text-sm font-semibold">
                {connector?.name ?? current?.name ?? 'Select project'}
              </span>
              <span className="truncate text-xs font-normal text-muted-foreground">
                {connector
                  ? (connector.host ?? 'Connector')
                  : (current?.slug ?? 'Projects')}
              </span>
            </span>
            <ChevronsUpDown
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          aria-label={
            showConnectors ? 'Select project or connector' : 'Select project'
          }
          className="project-picker-popover"
          side={mobile ? 'bottom' : 'right'}
          sideOffset={8}
          onCloseAutoFocus={(event) => {
            if (creating) event.preventDefault()
          }}
        >
          <Command shouldFilter={false}>
            <CommandInput
              aria-label={
                showConnectors
                  ? 'Search projects and connectors'
                  : 'Search projects'
              }
              placeholder={
                showConnectors
                  ? 'Search projects and connectors…'
                  : 'Search projects…'
              }
              value={query}
              onValueChange={setQuery}
            />
            <CommandList
              label={showConnectors ? 'Projects and connectors' : 'Projects'}
            >
              <div className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">
                Projects
              </div>
              <CommandEmpty>
                {showConnectors
                  ? 'No projects or connectors found'
                  : 'No projects found'}
              </CommandEmpty>
              {filtered.map((p) => (
                <CommandItem
                  key={p.slug}
                  value={'project:' + p.slug}
                  disabled={p.slug === project}
                  aria-current={p.slug === project ? 'true' : undefined}
                  onSelect={() => {
                    setOpen(false)
                    navigate(p.slug)
                  }}
                >
                  <ProjectMark project={p} compact />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{p.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {p.slug}
                    </span>
                  </span>
                  {project === p.slug && (
                    <Check
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                  )}
                </CommandItem>
              ))}
              {showConnectors && (
                <>
                  <div className="px-2 pt-3 pb-1 text-xs font-medium text-muted-foreground">
                    Connectors
                  </div>
                  {connectorError && (
                    <p
                      role="alert"
                      className="px-2 py-2 text-xs text-muted-foreground"
                    >
                      {connectorError}
                    </p>
                  )}
                  {filteredConnectors.map((c) => (
                    <CommandItem
                      key={c.id}
                      value={'connector:' + c.id}
                      disabled={c.id === connector?.id}
                      aria-current={c.id === connector?.id ? 'true' : undefined}
                      onSelect={() => {
                        setOpen(false)
                        location.assign(
                          '/connectors/' +
                            encodeURIComponent(c.id) +
                            '/compute/containers',
                        )
                      }}
                    >
                      <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground">
                        <Server className="size-4" aria-hidden="true" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{c.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {c.host ?? 'Not connected'}
                        </span>
                      </span>
                      {c.id === connector?.id && (
                        <Check
                          className="size-4 shrink-0 text-muted-foreground"
                          aria-hidden="true"
                        />
                      )}
                    </CommandItem>
                  ))}
                </>
              )}
            </CommandList>
          </Command>
          {canCreate && (
            <div className="border-t border-border p-1">
              <Button
                type="button"
                className="project-picker-create w-full text-left text-sm text-muted-foreground"
                onClick={() => {
                  setError('')
                  setCreating(true)
                  setOpen(false)
                  setQuery('')
                }}
              >
                <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-background">
                  <Plus className="size-4" aria-hidden="true" />
                </span>
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
