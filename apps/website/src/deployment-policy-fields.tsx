import { CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { FieldGroup, Field, FieldLabel } from '@/components/ui/field'
import type { DeploymentPolicy } from '@kloud/protocol/platform'
import { deploymentPolicySchema } from '@kloud/protocol/platform'
import { Checkbox, Input, NativeSelect } from './components/ui/controls'
import { Card } from './components/ui/card'

export function defaultDeploymentPolicy(): DeploymentPolicy {
  return deploymentPolicySchema.parse({})
}
export function DeploymentPolicyFields({
  value,
  onChange,
}: {
  value?: DeploymentPolicy
  onChange: (value: DeploymentPolicy) => void
}) {
  const policy = value ?? defaultDeploymentPolicy()
  const update = (patch: Partial<DeploymentPolicy>) =>
    onChange({ ...policy, ...patch })
  return (
    <Card className="flex flex-col gap-4">
      <CardHeader>
        <CardTitle asChild>
          <h2 className="font-semibold">Deployment policy</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {!value && (
          <p className="text-sm text-muted-foreground">
            This app needs a compatibility review before deployment. Review
            ports, volume writers, startup migrations and internal service
            discovery.
          </p>
        )}
        <Field>
          <FieldLabel>Replacement strategy</FieldLabel>
          <NativeSelect
            value={policy.strategy}
            onChange={(e) =>
              update({
                strategy: e.target.value as DeploymentPolicy['strategy'],
              })
            }
          >
            <option value="blue-green">
              Blue/green: verify candidate before switching traffic
            </option>
            <option value="stop-first">
              Stop before start (requires downtime permission)
            </option>
          </NativeSelect>
        </Field>
        <Field orientation="horizontal" className="flex items-center gap-2">
          <Checkbox
            checked={policy.compatibilityReviewed}
            onCheckedChange={(v) =>
              update({ compatibilityReviewed: v === true })
            }
          />
          <FieldLabel>
            I reviewed compatibility with overlapping releases
          </FieldLabel>
        </Field>
        <Field orientation="horizontal" className="flex items-center gap-2">
          <Checkbox
            checked={policy.allowDowntime}
            onCheckedChange={(v) => update({ allowDowntime: v === true })}
          />
          <FieldLabel>Explicitly allow downtime for this app</FieldLabel>
        </Field>
        <p className="text-xs text-muted-foreground">
          Blue/green never falls back to stop-first automatically. Existing
          requests and long-lived connections may close at cutover. Startup
          migrations remain app-managed and must be compatible with the serving
          release.
        </p>
        <Field orientation="horizontal" className="flex items-center gap-2">
          <Checkbox
            checked={policy.readiness.dockerHealth}
            onCheckedChange={(v) =>
              update({
                readiness: { ...policy.readiness, dockerHealth: v === true },
              })
            }
          />
          <FieldLabel>Require Docker healthy status</FieldLabel>
        </Field>
        <Field orientation="horizontal" className="flex items-center gap-2">
          <Checkbox
            checked={!!policy.readiness.http}
            onCheckedChange={(v) =>
              update({
                readiness: {
                  ...policy.readiness,
                  http:
                    v === true
                      ? { port: 80, path: '/', timeoutSeconds: 5 }
                      : undefined,
                },
              })
            }
          />
          <FieldLabel>Require HTTP readiness (200–299)</FieldLabel>
        </Field>
        {policy.readiness.http && (
          <FieldGroup className="grid gap-3 sm:grid-cols-3">
            <Field>
              <FieldLabel>Internal port</FieldLabel>
              <Input
                type="number"
                min={1}
                max={65535}
                value={policy.readiness.http.port}
                onChange={(e) =>
                  update({
                    readiness: {
                      ...policy.readiness,
                      http: {
                        ...policy.readiness.http!,
                        port: Number(e.target.value),
                      },
                    },
                  })
                }
              />
            </Field>
            <Field>
              <FieldLabel>Path</FieldLabel>
              <Input
                value={policy.readiness.http.path}
                onChange={(e) =>
                  update({
                    readiness: {
                      ...policy.readiness,
                      http: { ...policy.readiness.http!, path: e.target.value },
                    },
                  })
                }
              />
            </Field>
            <Field>
              <FieldLabel>Request timeout (seconds)</FieldLabel>
              <Input
                type="number"
                min={1}
                max={60}
                value={policy.readiness.http.timeoutSeconds}
                onChange={(e) =>
                  update({
                    readiness: {
                      ...policy.readiness,
                      http: {
                        ...policy.readiness.http!,
                        timeoutSeconds: Number(e.target.value),
                      },
                    },
                  })
                }
              />
            </Field>
          </FieldGroup>
        )}
        <FieldGroup className="grid gap-3 sm:grid-cols-3">
          <Field>
            <FieldLabel>Readiness window (seconds)</FieldLabel>
            <Input
              type="number"
              min={1}
              max={1800}
              value={policy.readiness.timeoutSeconds}
              onChange={(e) =>
                update({
                  readiness: {
                    ...policy.readiness,
                    timeoutSeconds: Number(e.target.value),
                  },
                })
              }
            />
          </Field>
          <Field>
            <FieldLabel>Probe interval (seconds)</FieldLabel>
            <Input
              type="number"
              min={1}
              max={60}
              value={policy.readiness.intervalSeconds}
              onChange={(e) =>
                update({
                  readiness: {
                    ...policy.readiness,
                    intervalSeconds: Number(e.target.value),
                  },
                })
              }
            />
          </Field>
          <Field>
            <FieldLabel>Shutdown grace (seconds)</FieldLabel>
            <Input
              type="number"
              min={0}
              max={300}
              value={policy.stopGraceSeconds}
              onChange={(e) =>
                update({ stopGraceSeconds: Number(e.target.value) })
              }
            />
          </Field>
        </FieldGroup>
      </CardContent>
    </Card>
  )
}
