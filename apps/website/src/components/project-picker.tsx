import { useNavigate } from '@tanstack/react-router'
import { Separator } from '@/components/ui/separator'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { cn } from '@/lib/utils'
import { FieldSet } from '@/components/ui/field'
import { Form } from '@/components/ui/form'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Check, ChevronsUpDown, FolderKanban, Plus, Server } from 'lucide-react'
import { api, hasServer, type Project, type User, type Connector } from '../api'
import { Button } from './ui/controls'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from './ui/command'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
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
      className={cn(
        'project-mark flex shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground',
        compact ? 'size-7 text-[10px]' : 'size-9 text-xs',
      )}
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
  const routerNavigate = useNavigate()
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
    routerNavigate({
      to: '/projects/$projectSlug/services',
      params: { projectSlug: slug },
    })

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
      await navigate(values.slug)
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
                <Server
                  data-icon="inline-start"

                  aria-hidden="true"
                />
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
              data-icon="inline-start"
              className="shrink-0 text-muted-foreground"
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
              <CommandEmpty>
                {showConnectors
                  ? 'No projects or connectors found'
                  : 'No projects found'}
              </CommandEmpty>
              <CommandGroup heading="Projects">
                {filtered.map((p) => (
                  <CommandItem
                    key={p.slug}
                    value={'project:' + p.slug}
                    disabled={p.slug === project}
                    aria-current={p.slug === project ? 'true' : undefined}
                    onSelect={() => {
                      setOpen(false)
                      setQuery('')
                      void navigate(p.slug)
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
              </CommandGroup>
              {showConnectors && (
                <CommandGroup heading="Connectors">
                  {connectorError && (
                    <Alert variant="destructive">
                      <AlertDescription>{connectorError}</AlertDescription>
                    </Alert>
                  )}
                  {filteredConnectors.map((c) => (
                    <CommandItem
                      key={c.id}
                      value={'connector:' + c.id}
                      disabled={c.id === connector?.id}
                      aria-current={c.id === connector?.id ? 'true' : undefined}
                      onSelect={() => {
                        setOpen(false)
                        setQuery('')
                        void routerNavigate({
                          to: '/connectors/$connectorId/compute/containers',
                          params: { connectorId: c.id },
                        })
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
                </CommandGroup>
              )}
            </CommandList>
          </Command>
          {canCreate && (
            <div className="p-1">
              <Separator className="basis-full" />
              <Button
                type="button"
                variant="ghost"
                className="project-picker-create w-full justify-start text-left text-sm"
                onClick={() => {
                  setError('')
                  setCreating(true)
                  setOpen(false)
                  setQuery('')
                }}
              >
                <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-background">
                  <Plus
                    data-icon="inline-start"

                    aria-hidden="true"
                  />
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
          <DialogHeader className="pr-6">
            <DialogTitle className="text-lg font-semibold">
              Create project
            </DialogTitle>
            <DialogDescription>
              Create a project on this infrastructure.
            </DialogDescription>
          </DialogHeader>
          <Form
            onSubmit={submit}
            className="flex flex-col gap-4"
            aria-busy={busy}
          >
            <FieldSet disabled={busy} className="min-w-0 flex flex-col gap-4">
              <ProjectFields />
            </FieldSet>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setCreating(false)}
              >
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={busy}>
                {busy ? 'Creating…' : 'Create project'}
              </Button>
            </DialogFooter>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
