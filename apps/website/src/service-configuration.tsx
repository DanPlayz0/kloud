import { FieldGroup, Field, FieldLabel } from '@/components/ui/field'
import { RepositoryOnboarding } from './repository-onboarding'
import { BuildInputsFields } from './build-inputs-fields'
import { defaultDeploymentPolicy } from './deployment-policy-fields'
import type { ServerAddresses } from './server-addresses'
import { EnvironmentEditor } from './environment-editor'
import { Children, isValidElement, type ReactNode } from 'react'
import type { PlatformConfig, RuntimeConfig } from '@kloud/protocol/platform'
import {
  Button,
  Checkbox,
  Input,
  NativeSelect,
  Textarea,
} from './components/ui/controls'
import { Card, CardHeader, CardTitle, CardContent } from './components/ui/card'
import { CollapsibleSection } from './components/ui/collapsible'

export interface Host extends ServerAddresses {
  id: string
  name: string
  capabilities: string[]
  seen: string | null
}
export const emptyRuntime: RuntimeConfig = {
  environment: {},
  ports: [],
  volumes: [],
  networks: [],
  restart: 'unless-stopped',
}
export function newConfig(): PlatformConfig {
  return {
    connector_id: '',
    deployment: defaultDeploymentPolicy(),
    source: { type: 'image', image: '' },
    runtime: { ...emptyRuntime },
  }
}
export function SourceFields({
  config,
  onChange,
  serviceType,
  mode,
  project,
  service,
}: {
  config: PlatformConfig
  onChange: (config: PlatformConfig) => void
  serviceType?: 'application' | 'compose'
  project?: string
  service?: string
  mode?: 'create'
}) {
  const source = config.source
  return (
    <div className="flex flex-col gap-4">
      {mode !== 'create' && (
        <>
          {' '}
          <Field>
            <FieldLabel>Deployment source</FieldLabel>
            <NativeSelect
              value={
                source.type === 'github'
                  ? source.config.kind === 'compose'
                    ? 'git-compose'
                    : 'dockerfile'
                  : source.type
              }
              onChange={(e) => {
                const value = e.target.value
                onChange({
                  ...config,
                  source:
                    value === 'image'
                      ? { type: 'image', image: '' }
                      : value === 'compose'
                        ? { type: 'compose', content: '' }
                        : {
                            type: 'github',
                            config: {
                              connector_id: config.connector_id,
                              container_name: 'managed',
                              repository: '',
                              branch: 'main',
                              kind:
                                value === 'dockerfile'
                                  ? 'dockerfile'
                                  : 'compose',
                              build_file:
                                value === 'dockerfile'
                                  ? 'Dockerfile'
                                  : 'compose.yaml',
                              context: '.',
                              service: 'app',
                              enabled: true,
                              managed: true,
                            },
                          },
                })
              }}
            >
              <option value="image" disabled={serviceType === 'compose'}>
                Registry image
              </option>
              <option value="dockerfile" disabled={serviceType === 'compose'}>
                GitHub Dockerfile
              </option>
              <option
                value="git-compose"
                disabled={serviceType === 'application'}
              >
                GitHub Compose
              </option>
              <option value="compose" disabled={serviceType === 'application'}>
                Pasted Compose
              </option>
            </NativeSelect>
          </Field>
        </>
      )}
      {source.type === 'image' && (
        <>
          <Field>
            <FieldLabel>Image</FieldLabel>
            <Input
              data-source-input
              required
              placeholder="nginx:alpine"
              value={source.image}
              onChange={(e) =>
                onChange({
                  ...config,
                  source: { ...source, image: e.target.value },
                })
              }
            />
          </Field>
          <CreationSettings
            compact={mode === 'create'}
            title="Registry credentials"
            count={source.registry ? 1 : 0}
          >
            <Field>
              <FieldLabel>Registry server (optional)</FieldLabel>
              <Input
                placeholder="ghcr.io"
                value={source.registry?.server ?? ''}
                onChange={(e) =>
                  onChange({
                    ...config,
                    source: {
                      ...source,
                      registry: e.target.value
                        ? {
                            server: e.target.value,
                            username: source.registry?.username ?? '',
                            password: source.registry?.password ?? '',
                          }
                        : undefined,
                    },
                  })
                }
              />
            </Field>
            {source.registry && (
              <>
                <Field>
                  <FieldLabel>Registry username</FieldLabel>
                  <Input
                    required
                    value={source.registry.username}
                    onChange={(e) =>
                      onChange({
                        ...config,
                        source: {
                          ...source,
                          registry: {
                            ...source.registry!,
                            username: e.target.value,
                          },
                        },
                      })
                    }
                  />
                </Field>
                <Field>
                  <FieldLabel>Registry password</FieldLabel>
                  <Input
                    type="password"
                    autoComplete="new-password"
                    required
                    value={source.registry.password}
                    onChange={(e) =>
                      onChange({
                        ...config,
                        source: {
                          ...source,
                          registry: {
                            ...source.registry!,
                            password: e.target.value,
                          },
                        },
                      })
                    }
                  />
                </Field>
              </>
            )}
          </CreationSettings>
        </>
      )}
      {source.type === 'compose' && (
        <Field>
          <FieldLabel>Compose definition</FieldLabel>
          <Textarea
            data-source-input
            required
            rows={12}
            placeholder={'services:\n  web:\n    image: nginx:alpine'}
            value={source.content}
            onChange={(e) =>
              onChange({
                ...config,
                source: { ...source, content: e.target.value },
              })
            }
          />
          {mode !== 'create' && (
            <>
              {' '}
              <span className="text-xs text-muted-foreground">
                Compose owns environment, ports, volumes, networks, and health
                checks. Use images here; use GitHub Compose for builds.
              </span>
            </>
          )}
        </Field>
      )}
      {source.type === 'github' && (
        <>
          {project && service ? (
            <RepositoryOnboarding
              project={project}
              service={service}
              value={source.config}
              onChange={(next) =>
                onChange({ ...config, source: { ...source, config: next } })
              }
            />
          ) : (
            <Field>
              <FieldLabel>GitHub repository (owner/repo)</FieldLabel>
              <Input
                data-source-input
                required
                value={source.config.repository}
                onChange={(e) =>
                  onChange({
                    ...config,
                    source: {
                      ...source,
                      config: { ...source.config, repository: e.target.value },
                    },
                  })
                }
              />
            </Field>
          )}
          <Field orientation="horizontal" className="flex items-center gap-2">
            <Checkbox
              checked={source.config.enabled}
              onCheckedChange={(v) =>
                onChange({
                  ...config,
                  source: {
                    ...source,
                    config: { ...source.config, enabled: v === true },
                  },
                })
              }
            />
            <FieldLabel>
              Automatically deploy signed pushes after setup is completed
            </FieldLabel>
          </Field>
          <CreationSettings
            compact={mode === 'create'}
            title="Build settings"
            count={
              Number(source.config.branch !== 'main') +
              Number(
                source.config.build_file !==
                  (source.config.kind === 'dockerfile'
                    ? 'Dockerfile'
                    : 'compose.yaml'),
              ) +
              Number(source.config.context !== '.')
            }
          >
            {(!project || !service || !source.config.connection_id) && (
              <Field>
                <FieldLabel>Branch</FieldLabel>
                <Input
                  data-config-path="source.config.branch"
                  data-source-input
                  required
                  value={source.config.branch}
                  onChange={(e) =>
                    onChange({
                      ...config,
                      source: {
                        ...source,
                        config: { ...source.config, branch: e.target.value },
                      },
                    })
                  }
                />
              </Field>
            )}
            <Field>
              <FieldLabel>Application root (repository-relative)</FieldLabel>
              <Input
                value={source.config.app_root ?? '.'}
                required
                onChange={(e) =>
                  onChange({
                    ...config,
                    source: {
                      ...source,
                      config: { ...source.config, app_root: e.target.value },
                    },
                  })
                }
              />
              <span className="text-xs text-muted-foreground">
                The app directory is separate from its Dockerfile and build
                context. Workspace apps may need a repository-root context.
              </span>
            </Field>
            <Field>
              <FieldLabel>Build file</FieldLabel>
              <Input
                data-config-path="source.config.build_file"
                data-source-input
                required
                value={source.config.build_file}
                onChange={(e) =>
                  onChange({
                    ...config,
                    source: {
                      ...source,
                      config: { ...source.config, build_file: e.target.value },
                    },
                  })
                }
              />
            </Field>
            <Field>
              <FieldLabel>Build context (repository-relative)</FieldLabel>
              <Input
                data-config-path="source.config.context"
                data-source-input
                required
                value={source.config.context}
                onChange={(e) =>
                  onChange({
                    ...config,
                    source: {
                      ...source,
                      config: { ...source.config, context: e.target.value },
                    },
                  })
                }
              />
            </Field>
            {source.config.kind === 'dockerfile' && (
              <Field>
                <FieldLabel>Public build arguments (JSON object)</FieldLabel>
                <Textarea
                  defaultValue={JSON.stringify(
                    source.config.build_arguments ?? {},
                    null,
                    2,
                  )}
                  onChange={(e) => {
                    try {
                      const value = JSON.parse(e.target.value || '{}')
                      if (
                        !value ||
                        Array.isArray(value) ||
                        typeof value !== 'object' ||
                        Object.values(value).some(
                          (v) => typeof v !== 'string',
                        ) ||
                        Object.keys(value).some(
                          (k) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k),
                        )
                      )
                        throw new Error(
                          'Use a JSON object with variable names and string values.',
                        )
                      e.target.setCustomValidity('')
                      onChange({
                        ...config,
                        source: {
                          ...source,
                          config: { ...source.config, build_arguments: value },
                        },
                      })
                    } catch {
                      e.target.setCustomValidity(
                        'Use a JSON object with variable names and string values.',
                      )
                    }
                  }}
                />
                <span className="text-xs text-muted-foreground">
                  Public values such as NEXT_PUBLIC_* and VITE_*. The committed
                  Dockerfile must declare ARG. Never enter credentials here;
                  these values can appear in image history and browser bundles.
                </span>
              </Field>
            )}
          </CreationSettings>
        </>
      )}
      <BuildInputsFields
        project={project}
        service={service}
        value={config.build_inputs}
        onChange={(build_inputs) => onChange({ ...config, build_inputs })}
      />
    </div>
  )
}
export function RuntimeFields({
  value,
  onChange,
  compact = false,
  revealUrl,
  onReveal,
}: {
  value: RuntimeConfig
  onChange: (value: RuntimeConfig) => void
  compact?: boolean
  revealUrl?: string
  onReveal?: (original: Record<string, string>) => void
}) {
  return (
    <div className="flex flex-col gap-5">
      <CreationSettings
        compact={compact}
        card
        title="Environment and secrets"
        count={Object.keys(value.environment).length}
      >
        <h2 className="font-semibold">Environment and secrets</h2>
        <p className="text-xs text-muted-foreground">
          Values are encrypted and masked on later reads.
        </p>
        <EnvironmentEditor
          value={value.environment}
          onChange={(environment) => onChange({ ...value, environment })}
          revealUrl={revealUrl}
          onReveal={onReveal}
        />
      </CreationSettings>
      <CreationSettings
        compact={compact}
        title="Resources and restart"
        count={
          Number(!!value.memoryMb) +
          Number(!!value.cpus) +
          Number(value.restart !== 'unless-stopped')
        }
      >
        <FieldGroup className="grid gap-4 md:grid-cols-3">
          <Field>
            <FieldLabel>Restart policy</FieldLabel>
            <NativeSelect
              value={value.restart}
              onChange={(e) =>
                onChange({
                  ...value,
                  restart: e.target.value as RuntimeConfig['restart'],
                })
              }
            >
              {['unless-stopped', 'always', 'on-failure', 'no'].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel>Memory limit (MiB)</FieldLabel>
            <Input
              type="number"
              min={16}
              value={value.memoryMb ?? ''}
              onChange={(e) =>
                onChange({
                  ...value,
                  memoryMb: e.target.value ? Number(e.target.value) : undefined,
                })
              }
            />
          </Field>
          <Field>
            <FieldLabel>CPU limit</FieldLabel>
            <Input
              type="number"
              min={0.1}
              step={0.1}
              value={value.cpus ?? ''}
              onChange={(e) =>
                onChange({
                  ...value,
                  cpus: e.target.value ? Number(e.target.value) : undefined,
                })
              }
            />
          </Field>
        </FieldGroup>
      </CreationSettings>
      <CreationSettings
        compact={compact}
        card
        title="Published ports"
        count={value.ports.length}
      >
        <h2 className="font-semibold">Published ports</h2>
        {value.ports.map((port, i) => (
          <FieldGroup
            key={i}
            className="flex flex-wrap items-end gap-2 flex-row"
          >
            <Field className="min-w-24 flex-1">
              <FieldLabel>Host port</FieldLabel>
              <Input
                type="number"
                required
                min={1}
                max={65535}
                value={port.host}
                onChange={(e) =>
                  onChange({
                    ...value,
                    ports: value.ports.map((p, j) =>
                      i === j ? { ...p, host: Number(e.target.value) } : p,
                    ),
                  })
                }
              />
            </Field>
            <Field className="min-w-24 flex-1">
              <FieldLabel>Container port</FieldLabel>
              <Input
                type="number"
                required
                min={1}
                max={65535}
                value={port.container}
                onChange={(e) =>
                  onChange({
                    ...value,
                    ports: value.ports.map((p, j) =>
                      i === j ? { ...p, container: Number(e.target.value) } : p,
                    ),
                  })
                }
              />
            </Field>
            <Field>
              <FieldLabel>Protocol</FieldLabel>
              <NativeSelect
                value={port.protocol}
                onChange={(e) =>
                  onChange({
                    ...value,
                    ports: value.ports.map((p, j) =>
                      i === j
                        ? { ...p, protocol: e.target.value as 'tcp' | 'udp' }
                        : p,
                    ),
                  })
                }
              >
                <option value="tcp">TCP</option>
                <option value="udp">UDP</option>
              </NativeSelect>
            </Field>
            <Button
              type="button"
              aria-label={'Remove port ' + port.host}
              onClick={() =>
                onChange({
                  ...value,
                  ports: value.ports.filter((_, j) => j !== i),
                })
              }
            >
              Remove
            </Button>
          </FieldGroup>
        ))}
        <Button
          type="button"
          onClick={() =>
            onChange({
              ...value,
              ports: [
                ...value.ports,
                { host: 8080, container: 80, protocol: 'tcp' },
              ],
            })
          }
        >
          Add port
        </Button>
      </CreationSettings>
      <CreationSettings
        compact={compact}
        card
        title="Persistent volumes"
        count={value.volumes.length}
      >
        <h2 className="font-semibold">Persistent volumes</h2>
        {value.volumes.map((volume, i) => (
          <FieldGroup
            key={i}
            className="flex flex-wrap items-end gap-2 flex-row"
          >
            <Field className="min-w-24 flex-1">
              <FieldLabel>Volume name</FieldLabel>
              <Input
                required
                value={volume.source}
                onChange={(e) =>
                  onChange({
                    ...value,
                    volumes: value.volumes.map((v, j) =>
                      i === j ? { ...v, source: e.target.value } : v,
                    ),
                  })
                }
              />
            </Field>
            <Field className="min-w-24 flex-1">
              <FieldLabel>Mount path</FieldLabel>
              <Input
                required
                placeholder="/data"
                value={volume.target}
                onChange={(e) =>
                  onChange({
                    ...value,
                    volumes: value.volumes.map((v, j) =>
                      i === j ? { ...v, target: e.target.value } : v,
                    ),
                  })
                }
              />
            </Field>
            <Field>
              <FieldLabel>Access</FieldLabel>
              <NativeSelect
                value={String(volume.readOnly)}
                onChange={(e) =>
                  onChange({
                    ...value,
                    volumes: value.volumes.map((v, j) =>
                      i === j
                        ? { ...v, readOnly: e.target.value === 'true' }
                        : v,
                    ),
                  })
                }
              >
                <option value="false">Read and write</option>
                <option value="true">Read only</option>
              </NativeSelect>
            </Field>
            <Button
              type="button"
              aria-label={'Remove volume ' + volume.source}
              onClick={() =>
                onChange({
                  ...value,
                  volumes: value.volumes.filter((_, j) => j !== i),
                })
              }
            >
              Remove
            </Button>
          </FieldGroup>
        ))}
        <Button
          type="button"
          onClick={() =>
            onChange({
              ...value,
              volumes: [
                ...value.volumes,
                { source: 'data', target: '/data', readOnly: false },
              ],
            })
          }
        >
          Add volume
        </Button>
      </CreationSettings>
      <CreationSettings
        compact={compact}
        title="Networks"
        count={value.networks.length}
      >
        <Field>
          <FieldLabel>Networks</FieldLabel>
          <Input
            placeholder="app-network, shared-network"
            defaultValue={value.networks.join(', ')}
            onChange={(e) =>
              onChange({
                ...value,
                networks: e.target.value
                  .split(',')
                  .map((v) => v.trim())
                  .filter(Boolean),
              })
            }
          />
          <span className="text-xs">
            Comma-separated existing Docker network names.
          </span>
        </Field>
      </CreationSettings>
      <CreationSettings
        compact={compact}
        title="Health check"
        count={value.healthcheck ? 1 : 0}
      >
        <Field>
          <FieldLabel>Health check command</FieldLabel>
          <Textarea
            placeholder={
              '/bin/sh\n-c\ncurl --fail http://localhost:3000/health'
            }
            defaultValue={value.healthcheck?.command.join('\n') ?? ''}
            onChange={(e) =>
              onChange({
                ...value,
                healthcheck: e.target.value
                  ? {
                      command: e.target.value.split('\n'),
                      intervalSeconds: value.healthcheck?.intervalSeconds ?? 30,
                    }
                  : undefined,
              })
            }
          />
          <span className="text-xs">
            One argument per line. Leave blank to use the image’s health check.
          </span>
        </Field>
        {value.healthcheck && (
          <Field>
            <FieldLabel>Health check interval (seconds)</FieldLabel>
            <Input
              type="number"
              min={1}
              max={3600}
              value={value.healthcheck.intervalSeconds}
              onChange={(e) =>
                onChange({
                  ...value,
                  healthcheck: {
                    ...value.healthcheck!,
                    intervalSeconds: Number(e.target.value),
                  },
                })
              }
            />
          </Field>
        )}
      </CreationSettings>
    </div>
  )
}
export function HostField({
  config,
  hosts,
  onChange,
}: {
  config: PlatformConfig
  hosts: Host[]
  onChange: (config: PlatformConfig) => void
}) {
  return (
    <Field>
      <FieldLabel>Deployment host</FieldLabel>
      <NativeSelect
        required
        value={config.connector_id}
        onChange={(e) =>
          onChange({
            ...config,
            connector_id: e.target.value,
            source:
              config.source.type === 'github'
                ? {
                    ...config.source,
                    config: {
                      ...config.source.config,
                      connector_id: e.target.value,
                      kind:
                        config.source.config.kind === ('git-compose' as string)
                          ? 'compose'
                          : config.source.config.kind,
                    },
                  }
                : config.source,
          })
        }
      >
        <option value="">Select a host</option>
        {hosts.map((h) => (
          <option
            key={h.id}
            value={h.id}
            disabled={
              !h.capabilities.includes('deploy') ||
              !h.seen ||
              Date.now() - Date.parse(h.seen) > 20000
            }
          >
            {h.name}
            {!h.capabilities.includes('deploy')
              ? ' — deployments disabled'
              : !h.seen || Date.now() - Date.parse(h.seen) > 20000
                ? ' — disconnected'
                : ''}
          </option>
        ))}
      </NativeSelect>
    </Field>
  )
}

function CreationSettings({
  compact,
  title,
  count,
  children,
  card = false,
}: {
  compact?: boolean
  title: string
  count: number
  children: ReactNode
  card?: boolean
}) {
  const parts = Children.toArray(children)
  const heading = parts.find(
    (part) => isValidElement(part) && part.type === 'h2',
  )
  if (compact)
    return (
      <CollapsibleSection title={title} count={count}>
        <div className="flex flex-col gap-4 [&>h2]:hidden [&>p]:hidden">
          {children}
        </div>
      </CollapsibleSection>
    )
  return card ? (
    <Card size="compact" className="flex flex-col gap-3">
      <CardHeader>
        <CardTitle asChild>{heading ?? <h2>{title}</h2>}</CardTitle>
      </CardHeader>
      <CardContent>{parts.filter((part) => part !== heading)}</CardContent>
    </Card>
  ) : (
    <>{children}</>
  )
}
