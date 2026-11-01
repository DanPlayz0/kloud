import { CardFieldset } from './components/ui/card'
import { useState } from 'react'
import { serviceCapabilities, type ServiceGrant, type Service } from './api'
import { Button, Label, NativeSelect } from './components/ui/controls'
import {
  CheckboxTree,
  CheckboxTreeCheckboxState,
  getInitialCheckboxTreeValues,
} from './components/ui/checkbox-tree'

const labels = {
  read: 'View service and build history',
  create: 'Create services',
  update: 'Edit service details',
  delete: 'Remove service records',
  deploy: 'Configure deployments and webhooks',
  reveal: 'Reveal service secrets and use developer variable editor',
}
export function ServiceGrantsEditor({
  value,
  onChange,
  services,
  disabled,
}: {
  value: ServiceGrant[]
  onChange: (grants: ServiceGrant[]) => void
  services: Service[]
  disabled: boolean
}) {
  const [target, setTarget] = useState('')
  const [selected, setSelected] = useState<string[]>(['read'])
  const capabilities = serviceCapabilities.filter(
    (c) => c !== 'create' || !target,
  )
  const items = capabilities.map((capability, i) => ({
    id: i + 1,
    parentId: 0,
    value: capability,
    name: labels[capability],
    dependentIds:
      capability === 'update' ||
      capability === 'delete' ||
      capability === 'deploy' ||
      capability === 'reveal'
        ? [1]
        : [],
  }))
  function add() {
    const next: ServiceGrant[] = selected
      .filter((c) => capabilities.includes(c as ServiceGrant['capability']))
      .map((c) => ({
        capability: c as ServiceGrant['capability'],
        service: target || null,
      }))
    if (
      next.some((g) =>
        ['update', 'delete', 'deploy', 'reveal'].includes(g.capability),
      )
    )
      next.push({ capability: 'read', service: target || null })
    onChange(
      [...value, ...next].filter(
        (g, i, all) =>
          all.findIndex(
            (other) =>
              other.capability === g.capability && other.service === g.service,
          ) === i,
      ),
    )
  }
  return (
    <CardFieldset disabled={disabled}>
      <legend className="px-2 font-medium">Service permissions</legend>
      <p className="text-sm text-muted-foreground">
        Project administrators have all service permissions. Deployment access
        lets members run repository code on the selected host.
      </p>
      {value.map((grant, i) => (
        <div
          key={`${grant.capability}:${grant.service}`}
          className="flex items-center justify-between gap-2 text-sm"
        >
          <span>
            {labels[grant.capability]} ·{' '}
            {grant.service === null
              ? 'All services (including future services)'
              : (services.find((s) => s.slug === grant.service)?.name ??
                grant.service)}
          </span>
          <Button
            type="button"
            disabled={disabled}
            aria-label={`Remove service grant ${i + 1}`}
            onClick={() =>
              onChange(
                value.filter(
                  (g) =>
                    !(
                      g.service === grant.service &&
                      (g.capability === grant.capability ||
                        (grant.capability === 'read' &&
                          ['update', 'delete', 'deploy', 'reveal'].includes(
                            g.capability,
                          )))
                    ),
                ),
              )
            }
          >
            Remove
          </Button>
        </div>
      ))}
      {!value.length && (
        <p className="text-sm text-muted-foreground">
          No member service permissions.
        </p>
      )}
      <Label>
        Service target
        <NativeSelect
          aria-label="Service target"
          value={target}
          disabled={disabled}
          onChange={(e) => setTarget(e.target.value)}
        >
          <option value="">All services in this project</option>
          {services.map((service) => (
            <option key={service.slug} value={service.slug}>
              {service.name}
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
            states
              .filter((s) => s.state === CheckboxTreeCheckboxState.CHECKED)
              .map((s) => s.value),
          )
        }
      />
      <Button
        type="button"
        disabled={
          disabled ||
          !selected.some((c) =>
            capabilities.includes(c as ServiceGrant['capability']),
          )
        }
        onClick={add}
      >
        Add service permissions
      </Button>
    </CardFieldset>
  )
}
