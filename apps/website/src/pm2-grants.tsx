import { useState } from 'react'
import { normalizePm2Grants, type Pm2Grant } from '@kloud/protocol/pm2'
import type { Pm2App } from './pm2'
import { usePolling, ErrorMessage } from './components'
import { Button, Label, NativeSelect } from './components/ui/controls'
import {
  CheckboxTree,
  CheckboxTreeCheckboxState,
  getInitialCheckboxTreeValues,
} from './components/ui/checkbox-tree'

const capabilities = ['view', 'logs', 'manage', 'delete'] as const
const items = capabilities.map((capability, i) => ({
  id: i + 1,
  parentId: 0,
  value: capability,
  name: {
    view: 'View PM2 apps and metrics',
    logs: 'Read PM2 logs',
    manage: 'Start, stop, restart and reload',
    delete: 'Delete apps from PM2',
  }[capability],
  dependentIds: i ? [1] : [],
}))

export function Pm2GrantsEditor({
  project,
  value,
  onChange,
  disabled,
}: {
  project: string
  value: Pm2Grant[]
  onChange: (grants: Pm2Grant[]) => void
  disabled: boolean
}) {
  const { data, error } = usePolling<Pm2App[]>(`/projects/${project}/pm2`)
  const [target, setTarget] = useState(''),
    [selected, setSelected] = useState<string[]>(['view'])
  return (
    <fieldset
      disabled={disabled}
      className="space-y-3 rounded border border-border p-4"
    >
      <legend className="px-2 font-medium">PM2 permissions</legend>
      <p className="text-sm text-muted-foreground">
        Project administrators have all PM2 permissions. Other permissions
        include View. Manage excludes Delete.
      </p>
      <ErrorMessage message={error} />
      {value.map((grant, i) => (
        <div
          key={`${grant.app}:${grant.capability}`}
          className="flex items-center justify-between gap-2 text-sm"
        >
          <span>
            {grant.capability} ·{' '}
            {grant.app === null
              ? 'All PM2 apps in this project'
              : (() => {
                  const app = data?.find((a) => a.id === grant.app)
                  return app
                    ? `${app.name} (${app.namespace} · ${app.connector_name})`
                    : grant.app
                })()}
          </span>
          <Button
            type="button"
            aria-label={`Remove PM2 grant ${i + 1}`}
            onClick={() =>
              onChange(
                value.filter(
                  (g) =>
                    !(
                      g.app === grant.app &&
                      (grant.capability === 'view' ||
                        g.capability === grant.capability)
                    ),
                ),
              )
            }
          >
            Remove
          </Button>
        </div>
      ))}
      <Label>
        PM2 application
        <NativeSelect
          aria-label="PM2 grant target"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        >
          <option value="">All PM2 apps in this project</option>
          {data?.map((app) => (
            <option key={app.id} value={app.id}>
              {app.name} ({app.namespace} · {app.connector_name})
            </option>
          ))}
        </NativeSelect>
      </Label>
      <CheckboxTree
        data={items}
        disabled={disabled}
        value={getInitialCheckboxTreeValues(
          items,
          disabled ? [...capabilities] : selected,
        )}
        onChange={(states) =>
          setSelected(
            capabilities.filter((capability) =>
              states.some(
                (state) =>
                  state.value === capability &&
                  state.state === CheckboxTreeCheckboxState.CHECKED,
              ),
            ),
          )
        }
      />
      <Button
        type="button"
        disabled={
          disabled ||
          !selected.length ||
          (!!target && !data?.some((a) => a.id === target))
        }
        onClick={() =>
          onChange(
            normalizePm2Grants([
              ...value,
              ...selected.map((capability) => ({
                capability: capability as Pm2Grant['capability'],
                app: target || null,
              })),
            ]),
          )
        }
      >
        Add PM2 grants
      </Button>
    </fieldset>
  )
}
