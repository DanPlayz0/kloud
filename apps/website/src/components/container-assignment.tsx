import { useState } from 'react'
import { api, type ContainerRow, type Project } from '../api'
import { ErrorMessage, usePolling } from '../components'
import { Button, Input, NativeSelect } from './ui/controls'
import { Field, FieldLabel } from './ui/field'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from './ui/dialog'

/** Shared inventory assignment uses the same authority and API as administration. */
export function ContainerAssignment({
  container,
  onSaved,
}: {
  container: ContainerRow
  onSaved: () => void
}) {
  const [open, setOpen] = useState(false)
  const [project, setProject] = useState(container.project ?? '')
  const [application, setApplication] = useState(container.application ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const projects = usePolling<Project[]>(
    open ? '/admin/containers/projects' : null,
  )
  async function save(value: { project: string; application: string } | null) {
    setBusy(true)
    setError('')
    try {
      await api(
        `/admin/containers/${container.connector_id}/${container.container_id}`,
        'PUT',
        value,
      )
      onSaved()
      setOpen(false)
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'Unable to assign container',
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" onClick={(event) => event.stopPropagation()}>
          {container.assignment === 'manual'
            ? 'Change assignment'
            : 'Assign to project'}
          <span className="sr-only"> for {container.data.name}</span>
        </Button>
      </DialogTrigger>
      <DialogContent onClick={(event) => event.stopPropagation()}>
        <DialogTitle>Assign {container.data.name}</DialogTitle>
        <DialogDescription>
          Choose the project and application that can access this container.
          Docker label assignments take precedence.
        </DialogDescription>
        <form
          className="mt-4 flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void save({ project, application })
          }}
        >
          <ErrorMessage message={error || projects.error} />
          <Field>
            <FieldLabel htmlFor="container-assignment-project">
              Project
            </FieldLabel>
            <NativeSelect
              id="container-assignment-project"
              value={project}
              required
              disabled={busy || !projects.data}
              onChange={(event) => setProject(event.target.value)}
            >
              <option value="">Select project</option>
              {projects.data?.map((project) => (
                <option key={project.slug} value={project.slug}>
                  {project.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor="container-assignment-application">
              Application slug
            </FieldLabel>
            <Input
              id="container-assignment-application"
              value={application}
              required
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              maxLength={100}
              disabled={busy}
              onChange={(event) => setApplication(event.target.value)}
              placeholder="Application slug"
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy || !projects.data?.length}>
              {busy ? 'Saving…' : 'Assign'}
            </Button>
            {container.assignment === 'manual' && (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => void save(null)}
              >
                Unassign
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
