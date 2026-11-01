import type { Project } from './api'
import { Checkbox } from './components/ui/controls'
import {
  Field,
  FieldSet,
  FieldLegend,
  FieldDescription,
  FieldLabel,
} from './components/ui/field'

export interface ConnectionAvailability {
  all_projects: boolean
  available_projects: string[]
}

export function ConnectionAvailabilityFields({
  value,
  projects,
  onChange,
  disabled = false,
}: {
  value: ConnectionAvailability
  projects: Project[]
  onChange: (value: ConnectionAvailability) => void
  disabled?: boolean
}) {
  return (
    <FieldSet className="gap-3" disabled={disabled}>
      <FieldLegend variant="label">Project and team availability</FieldLegend>
      <Field orientation="horizontal">
        <Checkbox
          aria-label="Available in all projects and teams"
          checked={value.all_projects}
          disabled={disabled}
          onCheckedChange={(checked) =>
            onChange({ ...value, all_projects: checked === true })
          }
        />
        <FieldLabel>
          All projects and teams, including future projects
        </FieldLabel>
      </Field>
      {!value.all_projects && (
        <div className="grid gap-2 rounded-md border border-border p-3 sm:grid-cols-2">
          {projects.map((project) => (
            <Field key={project.slug} orientation="horizontal">
              <Checkbox
                aria-label={`Available in ${project.name}`}
                checked={value.available_projects.includes(project.slug)}
                disabled={disabled}
                onCheckedChange={(checked) =>
                  onChange({
                    ...value,
                    available_projects:
                      checked === true
                        ? [
                            ...new Set([
                              ...value.available_projects,
                              project.slug,
                            ]),
                          ]
                        : value.available_projects.filter(
                            (slug) => slug !== project.slug,
                          ),
                  })
                }
              />
              <FieldLabel>{project.name}</FieldLabel>
            </Field>
          ))}
          {!projects.length && (
            <p className="text-sm text-muted-foreground">
              No projects available.
            </p>
          )}
        </div>
      )}
      <FieldDescription>
        Reuse the same saved credentials across the selected projects and their
        teams. Users still need deployment permission for their service and
        access to the selected repository. Existing explicit service bindings
        remain usable when broad availability is removed; revoke those bindings
        separately. Credentials are never shared with the browser.
      </FieldDescription>
    </FieldSet>
  )
}
