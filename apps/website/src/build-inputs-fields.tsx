import { useState } from 'react'
import { CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import {
  FieldGroup,
  Field,
  FieldLabel,
  FieldDescription,
} from '@/components/ui/field'
import { RegistryConnectionsFields } from './registry-connections-fields'
import type { BuildInputs } from '@kloud/protocol/platform'
import { Button, Input } from './components/ui/controls'
import { Card } from './components/ui/card'

export function BuildInputsFields({
  value,
  onChange,
  project,
  service,
}: {
  value?: BuildInputs
  onChange: (value: BuildInputs) => void
  project?: string
  service?: string
}) {
  const [secretId, setSecretId] = useState('')
  const [secretError, setSecretError] = useState('')
  const inputs = value ?? { secrets: {}, registries: [] }
  function addSecret() {
    const key = secretId.trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      setSecretError('Enter a valid build secret ID.')
      return
    }
    if (Object.hasOwn(inputs.secrets, key)) {
      setSecretError('A build secret with this ID already exists.')
      return
    }
    onChange({ ...inputs, secrets: { ...inputs.secrets, [key]: '' } })
    setSecretId('')
    setSecretError('')
  }
  return (
    <Card size="compact" className="flex flex-col gap-4">
      <CardHeader>
        <CardTitle asChild>
          <h3 className="font-semibold">
            Private build and registry credentials
          </h3>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground">
          Build secrets are encrypted separately from public build arguments and
          runtime variables. The committed Dockerfile must use a BuildKit secret
          mount, such as --mount=type=secret,id=npmrc,target=/root/.npmrc.
          Registry credentials authenticate private base images and runtime
          pulls in an isolated Docker configuration.
        </p>
        {Object.entries(inputs.secrets).map(([key, secret]) => (
          <FieldGroup
            key={key}
            className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end"
          >
            <Field className="min-w-0">
              <FieldLabel>Build secret ID</FieldLabel>
              <Input readOnly value={key} />
            </Field>
            <Field className="min-w-0">
              <FieldLabel>Secret value</FieldLabel>
              <Input
                type="password"
                autoComplete="new-password"
                value={secret}
                onChange={(e) =>
                  onChange({
                    ...inputs,
                    secrets: { ...inputs.secrets, [key]: e.target.value },
                  })
                }
              />
            </Field>
            <Button
              type="button"
              aria-label={`Remove build secret ${key}`}
              onClick={() => {
                const next = { ...inputs.secrets }
                delete next[key]
                onChange({ ...inputs, secrets: next })
              }}
            >
              Remove
            </Button>
          </FieldGroup>
        ))}
        <FieldGroup className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
          <Field>
            <FieldLabel>New build secret ID</FieldLabel>
            <Input
              value={secretId}
              placeholder="npmrc"
              autoComplete="off"
              validationMessage={secretError}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  addSecret()
                }
              }}
              onChange={(event) => {
                setSecretId(event.target.value)
                setSecretError('')
              }}
            />
            <FieldDescription>
              Use letters, digits, and underscores; start with a letter or
              underscore.
            </FieldDescription>
          </Field>
          <Button type="button" className="sm:mt-6" onClick={addSecret}>
            Add build secret
          </Button>
        </FieldGroup>
        {inputs.registries.map((registry, index) => (
          <FieldGroup
            key={index}
            className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end"
          >
            <Field>
              <FieldLabel>Registry server</FieldLabel>
              <Input
                value={registry.server}
                required
                placeholder="ghcr.io"
                onChange={(e) =>
                  onChange({
                    ...inputs,
                    registries: inputs.registries.map((v, i) =>
                      i === index ? { ...v, server: e.target.value } : v,
                    ),
                  })
                }
              />
            </Field>
            <Field>
              <FieldLabel>Username</FieldLabel>
              <Input
                value={registry.username}
                required
                onChange={(e) =>
                  onChange({
                    ...inputs,
                    registries: inputs.registries.map((v, i) =>
                      i === index ? { ...v, username: e.target.value } : v,
                    ),
                  })
                }
              />
            </Field>
            <Field>
              <FieldLabel>Password / token</FieldLabel>
              <Input
                type="password"
                autoComplete="new-password"
                value={registry.password}
                required
                onChange={(e) =>
                  onChange({
                    ...inputs,
                    registries: inputs.registries.map((v, i) =>
                      i === index ? { ...v, password: e.target.value } : v,
                    ),
                  })
                }
              />
            </Field>
            <Button
              type="button"
              onClick={() =>
                onChange({
                  ...inputs,
                  registries: inputs.registries.filter((_, i) => i !== index),
                })
              }
            >
              Remove registry
            </Button>
          </FieldGroup>
        ))}
        <Button
          type="button"
          onClick={() =>
            onChange({
              ...inputs,
              registries: [
                ...inputs.registries,
                { server: '', username: '', password: '' },
              ],
            })
          }
        >
          Add registry credential
        </Button>
        {project && service && (
          <RegistryConnectionsFields
            project={project}
            service={service}
            value={inputs.registry_connection_ids ?? []}
            onChange={(registry_connection_ids) =>
              onChange({ ...inputs, registry_connection_ids })
            }
          />
        )}
      </CardContent>
    </Card>
  )
}
