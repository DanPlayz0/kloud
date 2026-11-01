import type { DeploymentPolicy } from '@kloud/protocol/platform'
import {
  Button,
  Checkbox,
  Input,
  Label,
  NativeSelect,
  Textarea,
} from './components/ui/controls'
import { Card } from './components/ui/card'
export function ComposeWatchFields({
  value,
  onChange,
}: {
  value: DeploymentPolicy
  onChange: (value: DeploymentPolicy) => void
}) {
  const services = value.compose?.services
  if (!services)
    return (
      <Card className="space-y-3">
        <h2 className="font-semibold">Selective Compose rollout</h2>
        <p className="text-sm text-muted-foreground">
          Select replaceable web/API services. Databases and unselected
          dependencies stay in the stable project; their resolved configuration
          changes can require an interrupting restart.
        </p>
        <Button
          type="button"
          onClick={() =>
            onChange({
              ...value,
              compose: {
                services: {
                  web: { include: [], exclude: [], action: 'redeploy' },
                },
              },
            })
          }
        >
          Configure services and watch paths
        </Button>
      </Card>
    )
  const update = (
    name: string,
    patch: Partial<
      NonNullable<DeploymentPolicy['compose']>['services'][string]
    >,
  ) =>
    onChange({
      ...value,
      compose: {
        services: { ...services, [name]: { ...services[name]!, ...patch } },
      },
    })
  const lines = (text: string) =>
    text
      .split('\n')
      .map((v) => v.trim())
      .filter(Boolean)
  return (
    <Card className="space-y-4">
      <h2 className="font-semibold">Selected Compose services</h2>
      <p className="text-sm text-muted-foreground">
        Use case-sensitive repository-relative globs: **, * and ?. Empty
        includes match all paths; exclusions win. Manual deployments bypass
        filters. Shared paths may trigger several services. Each service
        compares against its last successfully deployed source, including
        renames and deletions.
      </p>
      {Object.entries(services).map(([name, rule], index) => (
        <Card key={index} className="space-y-3">
          <Label>
            Compose service name
            <Input
              required
              pattern="[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}"
              value={name}
              onChange={(e) => {
                const next = e.target.value
                if (!next || (next !== name && Object.hasOwn(services, next))) {
                  e.target.setCustomValidity(
                    'Use a unique Compose service name',
                  )
                  return
                }
                e.target.setCustomValidity('')
                onChange({
                  ...value,
                  compose: {
                    services: Object.fromEntries(
                      Object.entries(services).map(([key, v]) => [
                        key === name ? next : key,
                        v,
                      ]),
                    ),
                  },
                })
              }}
            />
          </Label>
          <div className="grid gap-3 md:grid-cols-2">
            <Label>
              Include paths (one glob per line)
              <Textarea
                rows={4}
                value={rule.include.join('\n')}
                placeholder={'apps/web/**\npackages/shared/**'}
                onChange={(e) =>
                  update(name, { include: lines(e.target.value) })
                }
              />
            </Label>
            <Label>
              Exclude paths (one glob per line)
              <Textarea
                rows={4}
                value={rule.exclude.join('\n')}
                placeholder="**/*.md"
                onChange={(e) =>
                  update(name, { exclude: lines(e.target.value) })
                }
              />
            </Label>
          </div>
          <Label>
            Action
            <NativeSelect
              value={rule.action}
              onChange={(e) =>
                update(name, {
                  action: e.target.value as 'redeploy' | 'restart',
                })
              }
            >
              <option value="redeploy">
                Build/pull the queued revision and replace this service
              </option>
              <option value="restart">
                Restart the current service without updating its source
              </option>
            </NativeSelect>
          </Label>
          <Label className="flex items-center gap-2">
            <Checkbox
              checked={!!rule.http}
              onCheckedChange={(v) =>
                update(name, {
                  http:
                    v === true
                      ? { port: 3000, path: '/', timeoutSeconds: 5 }
                      : undefined,
                })
              }
            />
            Override this service’s HTTP readiness probe
          </Label>
          {rule.http && (
            <div className="grid gap-3 md:grid-cols-3">
              <Label>
                Internal port
                <Input
                  required
                  type="number"
                  min={1}
                  max={65535}
                  value={rule.http.port}
                  onChange={(e) =>
                    update(name, {
                      http: { ...rule.http!, port: Number(e.target.value) },
                    })
                  }
                />
              </Label>
              <Label>
                HTTP path
                <Input
                  required
                  value={rule.http.path}
                  onChange={(e) =>
                    update(name, {
                      http: { ...rule.http!, path: e.target.value },
                    })
                  }
                />
              </Label>
              <Label>
                Request timeout (seconds)
                <Input
                  required
                  type="number"
                  min={1}
                  max={60}
                  value={rule.http.timeoutSeconds}
                  onChange={(e) =>
                    update(name, {
                      http: {
                        ...rule.http!,
                        timeoutSeconds: Number(e.target.value),
                      },
                    })
                  }
                />
              </Label>
            </div>
          )}
          <Button
            type="button"
            onClick={() =>
              onChange({
                ...value,
                compose: {
                  services: Object.fromEntries(
                    Object.entries(services).filter(([key]) => key !== name),
                  ),
                },
              })
            }
          >
            Remove selection
          </Button>
        </Card>
      ))}
      <Button
        type="button"
        onClick={() => {
          let name = 'web'
          for (let i = 2; Object.hasOwn(services, name); i++)
            name = `service-${i}`
          onChange({
            ...value,
            compose: {
              services: {
                ...services,
                [name]: { include: [], exclude: [], action: 'redeploy' },
              },
            },
          })
        }}
      >
        Add selected service
      </Button>
      {Object.values(services).some((v) => v.action === 'restart') && (
        <Label className="flex items-center gap-2">
          <Checkbox
            checked={value.allowDowntime}
            onCheckedChange={(v) =>
              onChange({ ...value, allowDowntime: v === true })
            }
          />
          Allow interrupting restarts for this app’s selected services
        </Label>
      )}
      <p className="text-xs text-muted-foreground">
        Blue/green blocks fixed host ports, writable candidate volumes, shared
        namespaces, fixed IPs, links, and dependencies between selected
        candidates until release-specific internal discovery is verified. All
        selected candidates must be ready before their managed routes switch
        together. Dependency restarts may interrupt the app.
      </p>
    </Card>
  )
}
