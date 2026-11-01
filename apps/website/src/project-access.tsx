import { Separator } from '@/components/ui/separator'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@/components/ui/table'
import { FieldGroup, FieldSet, Field, FieldLabel } from '@/components/ui/field'
import { Form } from '@/components/ui/form'
import { TableCard, FormCard } from './components/ui/card'
import { useRef, useState, type FormEvent } from 'react'
import { ServiceGrantsEditor } from './service-grants'
import { Pm2GrantsEditor } from './pm2-grants'
import type { Pm2Grant } from '@kloud/protocol/pm2'
import { DnsMemberGrants } from './dns'
import type { DnsGrant } from '@kloud/protocol/dns'
import type { Service, ServiceList, ServiceGrant } from './api'
import { Search, UserPen, UserPlus, UserX } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from './components/ui/dialog'
import {
  api,
  containerCapabilities,
  type Grant,
  type ProjectAccess,
  type ProjectMember,
  type ContainerRow,
  type User,
  type Project,
} from './api'
import { usePolling, ErrorMessage } from './components'
import { Button, Input, NativeSelect } from './components/ui/controls'
import {
  CheckboxTree,
  CheckboxTreeCheckboxState,
  getInitialCheckboxTreeValues,
  type CheckboxTreeItem,
} from './components/ui/checkbox-tree'

const containerPermissionItems: CheckboxTreeItem[] = [
  { id: 1, parentId: 0, name: 'All container capabilities', value: 'all' },
  ...containerCapabilities.map((value, index) => ({
    id: index + 2,
    parentId: 1,
    name: value === 'view' ? 'View' : `${value} (planned)`,
    value,
    dependentIds: value === 'view' ? [] : [2],
  })),
]

export function ProjectAccessPage({
  user,
  projects,
  project,
}: {
  user: User
  projects: Project[]
  project: string
}) {
  const [revision, setRevision] = useState(0),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false)
  const base = `/projects/${project}/access`
  const [search, setSearch] = useState('')
  const { data, error: loadError } = usePolling<ProjectAccess>(base, revision)
  const inventory = usePolling<ContainerRow[]>(
    `/projects/${project}/containers`,
  )
  const serviceList = usePolling<ServiceList>(`/projects/${project}/services`)
  const query = search.trim().toLowerCase()
  const members =
    data?.members.filter((member) =>
      [
        member.username,
        member.role,
        member.disabled ? 'disabled' : 'active',
      ].some((value) => value.toLowerCase().includes(query)),
    ) ?? []
  async function action(path: string, method: string, body?: unknown) {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const result = await api<{ enrollmentUrl?: string }>(path, method, body)
      setMessage(
        result.enrollmentUrl
          ? `Enrollment link (valid for 24 hours): ${result.enrollmentUrl}`
          : 'Changes saved.',
      )
      setRevision((n) => n + 1)
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed')
      return false
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <section className="admin-content flex flex-col gap-6">
        <div className="page-heading">
          <h1>Project access</h1>
        </div>
        <ErrorMessage
          message={error || loadError || inventory.error || serviceList.error}
        />
        {message && (
          <p className="success break-all" role="status">
            {message}
          </p>
        )}
        {data && (
          <FieldSet disabled={busy} className="flex flex-col gap-6 min-w-0">
            <FormCard
              key={`settings:${revision}`}
              onSubmit={(e) => {
                e.preventDefault()
                void action(`${base}/settings`, 'PUT', {
                  grant_mode: new FormData(e.currentTarget).get('grant_mode'),
                })
              }}
            >
              <Field>
                <FieldLabel>Default matching mode</FieldLabel>
                <NativeSelect
                  aria-label="Default matching mode"
                  name="grant_mode"
                  defaultValue={data.grant_mode}
                >
                  <option value="id">Container IDs</option>
                  <option value="name">Exact container names</option>
                </NativeSelect>
              </Field>
              <Button>Save default</Button>
              <p className="text-muted-foreground text-sm">
                Existing grants stay unchanged. Names follow recreated
                containers on the same connector in this project.
              </p>
            </FormCard>
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
              <div className="relative w-80 max-w-full">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  aria-label="Search members"
                  placeholder="Search members..."
                  className="pl-9"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
              <MemberDialog
                project={project}
                services={serviceList.data?.services ?? []}
                mode={data.grant_mode}
                containers={inventory.data ?? []}
                onSave={(body) => action(`${base}/members`, 'POST', body)}
              />
            </div>
            <h2>Members</h2>
            <p className="text-muted-foreground text-sm">
              Project Administrators manage access and see every container.
              Members see only containers with View grants. Other capabilities
              are planned and unavailable today, and include View for the same
              target.
            </p>
            <TableCard>
              <Table className="w-full text-left text-sm">
                <TableHeader className="border-b border-border bg-background text-muted-foreground">
                  <TableRow>
                    <TableHead scope="col" className="p-4 font-medium">
                      Member
                    </TableHead>
                    <TableHead scope="col" className="p-4 font-medium">
                      Permissions
                    </TableHead>
                    <TableHead scope="col" className="p-4 font-medium">
                      Status
                    </TableHead>
                    <TableHead scope="col" className="p-4">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {members.map((member) => (
                    <TableRow
                      key={member.id}
                      className="border-b border-border last:border-0"
                    >
                      <TableCell className="p-4 font-medium">
                        <span className="break-all">{member.username}</span>
                      </TableCell>
                      <TableCell className="p-4 text-muted-foreground">
                        {member.role === 'admin'
                          ? 'Project Administrator'
                          : `${member.grants.length} container grants · ${member.service_grants?.length ?? 0} service grants · ${member.pm2_grants?.length ?? 0} PM2 grants`}
                      </TableCell>
                      <TableCell className="p-4 text-muted-foreground">
                        {member.disabled ? 'Disabled' : 'Active'}
                      </TableCell>
                      <TableCell className="p-4">
                        <div className="flex justify-end gap-2">
                          <MemberDialog
                            project={project}
                            services={serviceList.data?.services ?? []}
                            member={member}
                            mode={data.grant_mode}
                            containers={inventory.data ?? []}
                            onSave={(body) =>
                              action(
                                `${base}/members/${member.id}`,
                                'PUT',
                                body,
                              )
                            }
                          />
                          <Button
                            type="button"
                            variant="destructive"
                            aria-label={`Remove ${member.username}`}
                            onClick={() => {
                              if (
                                confirm(
                                  `Remove ${member.username} from this project?`,
                                )
                              )
                                void action(
                                  `${base}/members/${member.id}`,
                                  'DELETE',
                                )
                            }}
                          >
                            <UserX
                              data-icon="inline-start"

                              aria-hidden="true"
                            />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                  {!members.length && (
                    <TableRow>
                      <TableCell
                        colSpan={4}
                        className="h-28 p-4 text-center text-muted-foreground"
                      >
                        {query
                          ? 'No members match your search.'
                          : 'No project members yet.'}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </TableCard>
          </FieldSet>
        )}
      </section>
    </>
  )
}

type MemberEditorProps = {
  project: string
  services: Service[]
  member?: ProjectMember
  mode: 'id' | 'name'
  containers: ContainerRow[]
  onSave: (body: unknown) => Promise<boolean>
}

function MemberDialog(props: MemberEditorProps) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const submitting = useRef(false)
  const trigger = useRef<HTMLButtonElement>(null)
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!submitting.current) setOpen(next)
      }}
    >
      <Button
        ref={trigger}
        type="button"
        variant={props.member ? 'default' : 'primary'}
        aria-label={props.member ? `Edit ${props.member.username}` : undefined}
        onClick={() => setOpen(true)}
      >
        {props.member ? (
          <UserPen data-icon="inline-start" aria-hidden="true" />
        ) : (
          <>
            <UserPlus
              data-icon="inline-start"

              aria-hidden="true"
            />{' '}
            Invite or add member
          </>
        )}
      </Button>
      <DialogContent
        className="max-w-xl"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          trigger.current?.focus()
        }}
      >
        <DialogTitle className="break-all text-lg font-semibold">
          {props.member
            ? `Edit ${props.member.username}`
            : 'Invite or add a member'}
        </DialogTitle>
        <DialogDescription className="mt-2 text-sm text-muted-foreground">
          {props.member
            ? "Make changes to this member's role and container permissions."
            : 'Invite someone to help manage this project.'}
        </DialogDescription>
        <MemberEditor
          {...props}
          saving={saving}
          onCancel={() => setOpen(false)}
          onSave={async (body) => {
            if (submitting.current) return false
            submitting.current = true
            setSaving(true)
            try {
              const success = await props.onSave(body)
              if (success) setOpen(false)
              return success
            } finally {
              submitting.current = false
              setSaving(false)
            }
          }}
        />
      </DialogContent>
    </Dialog>
  )
}

function MemberEditor({
  project,
  services,
  member,
  mode,
  containers,
  onSave,
  onCancel,
  saving,
}: MemberEditorProps & { onCancel: () => void; saving: boolean }) {
  const [saveError, setSaveError] = useState('')
  const [pm2Grants, setPm2Grants] = useState<Pm2Grant[]>(
    member?.pm2_grants ?? [],
  )
  const [dnsGrants, setDnsGrants] = useState<DnsGrant[]>(
    member?.dns_grants ?? [],
  )
  const [role, setRole] = useState(member?.role ?? 'member')
  const [grants, setGrants] = useState<Grant[]>(member?.grants ?? [])
  const [serviceGrants, setServiceGrants] = useState<ServiceGrant[]>(
    member?.service_grants ?? [],
  )
  const [kind, setKind] = useState<Grant['kind']>(mode)
  const [selected, setSelected] = useState('')
  const [capabilities, setCapabilities] = useState<Grant['capability'][]>([
    'view',
  ])
  function addGrant() {
    const row = containers.find(
      (c) => `${c.connector_id}:${c.container_id}` === selected,
    )
    if (kind !== 'all' && !row) return
    const next = [
      ...new Set([
        ...capabilities,
        ...(capabilities.length ? ['view' as const] : []),
      ]),
    ].map((capability) => ({
      capability,
      kind,
      connector_id: kind === 'all' ? null : row!.connector_id,
      target:
        kind === 'all'
          ? null
          : kind === 'id'
            ? row!.container_id
            : row!.data.name,
    }))
    setGrants((old) => [
      ...old,
      ...next.filter(
        (g) => !old.some((o) => JSON.stringify(o) === JSON.stringify(g)),
      ),
    ])
  }
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const body = {
      role,
      grants,
      service_grants: serviceGrants,
      pm2_grants: pm2Grants,
      ...(JSON.stringify(dnsGrants) !==
        JSON.stringify(member?.dns_grants ?? []) || !member
        ? { dns_grants: dnsGrants }
        : {}),
      ...(!member
        ? { username: new FormData(e.currentTarget).get('username') }
        : {}),
    }
    setSaveError('')
    void onSave(body).then((success) => {
      if (!success)
        setSaveError('Could not save member access. Please try again.')
    })
  }
  return (
    <Form
      className="mt-5 flex flex-col gap-4 min-w-0"
      aria-busy={saving}
      onSubmit={submit}
    >
      <FieldSet disabled={saving} className="min-w-0 flex flex-col gap-4">
        <FieldGroup className="flex flex-wrap items-end gap-4 flex-row">
          {member ? (
            <strong className="break-all">
              {member.username}
              {member.disabled && ' (disabled)'}
            </strong>
          ) : (
            <Field>
              <FieldLabel>Username</FieldLabel>
              <Input
                name="username"
                required
                maxLength={100}
                pattern="[a-zA-Z0-9_.@\-]+"
                autoComplete="off"
              />
            </Field>
          )}
          <Field>
            <FieldLabel>Project role</FieldLabel>
            <NativeSelect
              aria-label="Project role"
              value={role}
              onChange={(e) => setRole(e.target.value as typeof role)}
            >
              <option value="member">Project Member</option>
              <option value="admin">Project Administrator</option>
            </NativeSelect>
          </Field>
        </FieldGroup>
        {role === 'admin' && (
          <p className="text-muted-foreground text-sm">
            This role grants all project container capabilities and access
            management. Saved member grants are retained.
          </p>
        )}
        <ServiceGrantsEditor
          value={serviceGrants}
          onChange={setServiceGrants}
          services={services}
          disabled={role === 'admin'}
        />
        <Pm2GrantsEditor
          project={project}
          value={pm2Grants}
          onChange={setPm2Grants}
          disabled={role === 'admin'}
        />
        <DnsMemberGrants
          project={project}
          grants={dnsGrants}
          onChange={setDnsGrants}
          disabled={role === 'admin'}
        />
        <div className="flex flex-col gap-2">
          <h3>Container grants</h3>
          {grants.map((g, index) => (
            <div
              key={index}
              className="flex flex-wrap items-center gap-2 text-sm"
            >
              <span className="break-all">
                {g.capability}
                {g.capability !== 'view' && ' (planned)'} ·{' '}
                {g.kind === 'all'
                  ? 'All containers in this project'
                  : `${g.kind}: ${g.target} · ${containers.find((c) => c.connector_id === g.connector_id)?.connector_name ?? g.connector_id}`}
              </span>
              <Button
                type="button"
                aria-label={`Remove ${g.capability} grant ${index + 1}`}
                onClick={() =>
                  setGrants((old) =>
                    old.filter(
                      (_, i) =>
                        i !== index &&
                        !(
                          g.capability === 'view' &&
                          old[i]?.kind === g.kind &&
                          old[i]?.connector_id === g.connector_id &&
                          old[i]?.target === g.target
                        ),
                    ),
                  )
                }
              >
                Remove
              </Button>
            </div>
          ))}
          {!grants.length && (
            <p className="text-muted-foreground text-sm">
              {role === 'admin'
                ? 'No member grants. The administrator role provides project-wide access.'
                : 'No grants. Project Members cannot view containers until granted access.'}
            </p>
          )}
        </div>
        <FieldGroup className="flex flex-wrap gap-4 items-end flex-row">
          <Field>
            <FieldLabel>Grant target</FieldLabel>
            <NativeSelect
              aria-label="Grant target"
              value={kind}
              onChange={(e) => setKind(e.target.value as Grant['kind'])}
            >
              <option value="all">All containers in this project</option>
              <option value="id">Container ID</option>
              <option value="name">Exact container name</option>
            </NativeSelect>
          </Field>
          {kind !== 'all' && (
            <Field>
              <FieldLabel>Container</FieldLabel>
              <NativeSelect
                aria-label="Container"
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
              >
                <option value="">Select container</option>
                {containers.map((c) => (
                  <option
                    key={`${c.connector_id}:${c.container_id}`}
                    value={`${c.connector_id}:${c.container_id}`}
                  >
                    {c.data.name} ({c.connector_name})
                  </option>
                ))}
              </NativeSelect>
            </Field>
          )}
          <Button
            type="button"
            onClick={addGrant}
            disabled={
              role === 'admin' ||
              !capabilities.length ||
              (kind !== 'all' && !selected)
            }
          >
            Add grant
          </Button>
        </FieldGroup>
        <CheckboxTree
          data={containerPermissionItems}
          value={getInitialCheckboxTreeValues(
            containerPermissionItems,
            role === 'admin' ? ['all'] : capabilities,
          )}
          disabled={role === 'admin'}
          onChange={(states) =>
            setCapabilities(
              containerCapabilities.filter((capability) =>
                states.some(
                  (state) =>
                    state.value === capability &&
                    state.state === CheckboxTreeCheckboxState.CHECKED,
                ),
              ),
            )
          }
        />
      </FieldSet>
      {saveError && (
        <Alert variant="destructive">
          <AlertDescription>{saveError}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap justify-end gap-3   pt-4">
        <Separator className="basis-full" />
        <Button type="button" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={
            saving ||
            (!!member &&
              role === member.role &&
              JSON.stringify(pm2Grants) ===
                JSON.stringify(member.pm2_grants ?? []) &&
              JSON.stringify(grants) === JSON.stringify(member.grants) &&
              JSON.stringify(dnsGrants) ===
                JSON.stringify(member.dns_grants ?? []) &&
              JSON.stringify(serviceGrants) ===
                JSON.stringify(member.service_grants ?? []))
          }
        >
          {saving
            ? 'Saving…'
            : member
              ? 'Save member access'
              : 'Invite or add member'}
        </Button>
      </div>
    </Form>
  )
}
