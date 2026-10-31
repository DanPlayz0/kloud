import { useState, type FormEvent } from 'react'
import { platformConfigSchema } from '@dedi-dash/protocol/platform'
import { api } from './api'
import { usePolling, ErrorMessage } from './components'
import {
  newConfig,
  SourceFields,
  HostField,
  RuntimeFields,
  type Host,
} from './service-configuration'
import { Button, Input, Label, NativeSelect } from './components/ui/controls'
import {
  DialogContent,
  DialogTitle,
  DialogDescription,
} from './components/ui/dialog'

export function ServiceCreate({
  project,
  canDeploy,
}: {
  project: string
  canDeploy: boolean
}) {
  const [step, setStep] = useState(0),
    [name, setName] = useState(''),
    [slug, setSlug] = useState(''),
    [config, setConfig] = useState(newConfig)
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [created, setCreated] = useState(false),
    [commit, setCommit] = useState('')
  const [requestKey] = useState(() => crypto.randomUUID())
  const { data: hosts, error: hostError } = usePolling<Host[]>(
    `/projects/${project}/hosts`,
  )
  const compose =
    config.source.type === 'compose' ||
    (config.source.type === 'github' && config.source.config.kind === 'compose')
  async function submit(event: FormEvent<HTMLFormElement>, deploy = false) {
    event.preventDefault()
    setError('')
    if (step < 3 && canDeploy) {
      setStep(step + 1)
      return
    }
    setBusy(true)
    try {
      if (!canDeploy) {
        await api(`/projects/${project}/services`, 'POST', {
          name,
          slug,
          type: compose ? 'compose' : 'application',
          description: '',
        })
        location.assign(`/projects/${project}/applications/${slug}`)
        return
      }
      const parsed = platformConfigSchema.safeParse(config)
      if (!parsed.success)
        throw new Error(
          parsed.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; '),
        )
      if (!created) {
        await api(`/projects/${project}/services`, 'POST', {
          name,
          slug,
          type: compose ? 'compose' : 'application',
          description: '',
        })
        setCreated(true)
      }
      const revision = await api<{ id: string }>(
        `/projects/${project}/services/${slug}/configuration`,
        'PUT',
        { config: parsed.data },
      )
      if (deploy)
        await api(`/projects/${project}/services/${slug}/deploy`, 'POST', {
          revision: revision.id,
          request_key: requestKey,
          ...(config.source.type === 'github' ? { commit } : {}),
        })
      location.assign(`/projects/${project}/applications/${slug}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to create service')
    } finally {
      setBusy(false)
    }
  }
  return (
    <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
      <DialogTitle>Create service</DialogTitle>
      <DialogDescription>
        Choose a source, configure its host, then save a draft or deploy.
      </DialogDescription>
      {canDeploy ? (
        <ol className="my-4 flex flex-wrap gap-3 text-xs text-muted-foreground">
          {['Source', 'Host', 'Configuration', 'Review'].map((s, i) => (
            <li
              key={s}
              aria-current={i === step ? 'step' : undefined}
              className={i === step ? 'font-semibold text-foreground' : ''}
            >
              {i + 1}. {s}
            </li>
          ))}
        </ol>
      ) : (
        <p className="my-4 text-sm text-muted-foreground">
          You can create a service. An administrator must grant deployment
          permission before you configure its host and deploy.
        </p>
      )}
      <form onSubmit={submit} className="space-y-4">
        <fieldset disabled={busy} className="min-w-0 space-y-4">
          {step === 0 && (
            <>
              <Label>
                Name
                <Input
                  required
                  maxLength={100}
                  value={name}
                  disabled={created}
                  onChange={(e) => {
                    setName(e.target.value)
                    if (!created)
                      setSlug(
                        e.target.value
                          .toLowerCase()
                          .replace(/[^a-z0-9]+/g, '-')
                          .replace(/^-|-$/g, ''),
                      )
                  }}
                />
              </Label>
              <Label>
                Slug
                <Input
                  required
                  maxLength={100}
                  pattern="[a-z0-9]+(-[a-z0-9]+)*"
                  disabled={created}
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                />
              </Label>
              {canDeploy ? (
                <SourceFields config={config} onChange={setConfig} />
              ) : (
                <Label>
                  Service type
                  <NativeSelect
                    value={compose ? 'compose' : 'application'}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        source:
                          e.target.value === 'compose'
                            ? { type: 'compose', content: '' }
                            : { type: 'image', image: '' },
                      })
                    }
                  >
                    <option value="application">Application</option>
                    <option value="compose">Compose stack</option>
                  </NativeSelect>
                </Label>
              )}
            </>
          )}
          {step === 1 && (
            <>
              <ErrorMessage message={hostError} />
              <HostField
                config={config}
                hosts={hosts ?? []}
                onChange={setConfig}
              />
            </>
          )}
          {step === 2 &&
            (compose ? (
              <p className="text-muted-foreground">
                Your Compose definition owns the stack’s runtime settings,
                networks, and persistent storage.
              </p>
            ) : (
              <RuntimeFields
                value={config.runtime}
                onChange={(runtime) => setConfig({ ...config, runtime })}
              />
            ))}
          {step === 3 && (
            <>
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <dt>Name</dt>
                <dd>{name}</dd>
                <dt>Source</dt>
                <dd>
                  {config.source.type === 'github'
                    ? `${config.source.config.repository} (${config.source.config.kind})`
                    : config.source.type === 'image'
                      ? config.source.image
                      : 'Compose stack'}
                </dd>
                <dt>Host</dt>
                <dd>
                  {hosts?.find((h) => h.id === config.connector_id)?.name}
                </dd>
                <dt>Deployment</dt>
                <dd>Explicit; saving creates a draft</dd>
              </dl>
              {config.source.type === 'github' && (
                <Label>
                  Commit SHA (required to deploy)
                  <Input
                    pattern="[a-f0-9]{40}"
                    value={commit}
                    onChange={(e) => setCommit(e.target.value)}
                  />
                </Label>
              )}
              <p className="text-sm text-muted-foreground">
                Deployment requires service deploy permission. Creating a
                service does not grant it automatically.
              </p>
            </>
          )}
          <ErrorMessage message={error} />
          {created && error && (
            <Button asChild>
              <a href={`/projects/${project}/applications/${slug}`}>
                Open created service
              </a>
            </Button>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            {step > 0 && (
              <Button type="button" onClick={() => setStep(step - 1)}>
                Back
              </Button>
            )}
            <Button variant="primary" disabled={busy}>
              {busy
                ? 'Saving…'
                : !canDeploy
                  ? 'Create service'
                  : step === 3
                    ? 'Save draft'
                    : 'Continue'}
            </Button>
            {step === 3 && (
              <Button
                type="button"
                disabled={
                  busy ||
                  (config.source.type === 'github' &&
                    !/^[a-f0-9]{40}$/.test(commit))
                }
                onClick={(e) => {
                  const form = e.currentTarget.form!
                  if (form.reportValidity())
                    void submit(
                      { preventDefault() {} } as FormEvent<HTMLFormElement>,
                      true,
                    )
                }}
              >
                Create and deploy
              </Button>
            )}
          </div>
        </fieldset>
      </form>
    </DialogContent>
  )
}
