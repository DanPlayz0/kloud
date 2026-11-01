import { useConfirmation } from './ui/confirmation-dialog'
import { Badge } from './ui/badge'
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
  TableCaption,
} from '@/components/ui/table'
import { FieldSet, Field, FieldLabel } from '@/components/ui/field'
import { Form } from '@/components/ui/form'
import { TableCard } from './ui/card'
import { useRef, useState, type FormEvent } from 'react'
import { KeyRound, Search, UserPen, UserPlus } from 'lucide-react'
import {
  hasServer,
  type Project,
  type ServerCapability,
  type User,
} from '../api'
import { ErrorMessage, usePolling } from '../components'
import { Button, Checkbox, Input } from './ui/controls'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogDescription,
  DialogTitle,
} from './ui/dialog'
import { ServerPermissionTree } from './server-permission-tree'
import QuickTip from './quickTip'

type AdminUser = User & {
  disabled: boolean
  enrolled: boolean
  projects: string[]
}
type Action = (path: string, method: string, body: unknown) => Promise<boolean>
type EditorProps = {
  user?: AdminUser
  current: User
  projects: Project[]
  action: Action
}
const isProtected = (user: AdminUser, current: User) =>
  !current.admin && (user.admin || !!user.capabilities?.length)

export function Users({
  revision,
  action,
  current,
  projects,
}: Omit<EditorProps, 'user'> & { revision: number }) {
  const { confirm: confirmAction, confirmationDialog } = useConfirmation()
  const { data, error } = usePolling<AdminUser[]>('/admin/users', revision)
  const [search, setSearch] = useState('')
  const query = search.trim().toLowerCase()
  const users =
    data?.filter((user) =>
      [
        user.username,
        user.email ?? '',
        user.admin ? 'Organization Administrator' : 'Member',
        user.disabled ? 'Disabled' : user.enrolled ? 'Active' : 'Invited',
        ...user.projects,
        ...(user.capabilities ?? []),
      ].some((value) => value.toLowerCase().includes(query)),
    ) ?? []
  return (
    <div className="min-w-0 flex flex-col gap-4">
      {confirmationDialog}
      <p className="text-sm text-muted-foreground">
        Manage who can access this organization and its projects.
      </p>
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div className="relative w-80 max-w-full">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            aria-label="Search users"
            placeholder="Search users..."
            className="pl-9!"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <UserDialog current={current} projects={projects} action={action} />
      </div>
      <ErrorMessage message={error} />
      <TableCard>
        <Table>
          <TableCaption className="sr-only">
            Organization users, access, and invitation status
          </TableCaption>
          <TableHeader>
            <TableRow>
              {['User', 'Permissions', 'Projects', 'Status'].map((title) => (
                <TableHead key={title} scope="col" className="p-4 font-medium">
                  {title}
                </TableHead>
              ))}
              <TableHead scope="col" className="p-4">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((user) => (
              <TableRow
                key={user.id}
                className="user-row border-b border-border last:border-0"
              >
                <TableCell className="p-4">
                  <div className="flex items-center gap-3">
                    <span
                      className="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary font-medium text-muted-foreground"
                      aria-hidden="true"
                    >
                      {user.username.slice(0, 2).toUpperCase()}
                    </span>
                    <div>
                      <p className="break-all font-medium">{user.username}</p>
                      {user.email && (
                        <p className="break-all text-xs text-muted-foreground">
                          {user.email}
                        </p>
                      )}
                      {user.id === current.id && (
                        <p className="text-xs text-muted-foreground">You</p>
                      )}
                    </div>
                  </div>
                </TableCell>
                <TableCell className="p-4 text-muted-foreground">
                  {user.admin
                    ? 'Organization Administrator'
                    : user.capabilities?.length
                      ? `${user.capabilities.length} permission${user.capabilities.length === 1 ? '' : 's'}`
                      : 'Member'}
                </TableCell>
                <TableCell className="p-4 text-muted-foreground">
                  {hasServer(user, 'projects.manage')
                    ? 'All projects'
                    : `${user.projects.length} project${user.projects.length === 1 ? '' : 's'}`}
                </TableCell>
                <TableCell className="p-4">
                  <Badge variant={user.disabled ? 'outline' : 'secondary'}>
                    {user.disabled
                      ? 'Disabled'
                      : user.enrolled
                        ? 'Active'
                        : 'Invited'}
                  </Badge>
                </TableCell>
                <TableCell className="p-4">
                  {isProtected(user, current) ? (
                    <span className="cursor-not-allowed text-xs text-muted-foreground">
                      Organization Administrator required
                    </span>
                  ) : (
                    <div className="flex justify-end gap-2">
                      <UserDialog
                        user={user}
                        current={current}
                        projects={projects}
                        action={action}
                      />
                      {current.id !== user.id && !user.enrolled && (
                        <QuickTip content="Regenerate invitation">
                          <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            aria-label={`Regenerate invitation for ${user.username}`}
                            onClick={async () => {
                              if (
                                await confirmAction({
                                  title: 'Replace invitation',
                                  description: `Replace ${user.username}'s pending invitation? The previous link will stop working.`,
                                  actionLabel: 'Replace invitation',
                                })
                              )
                                void action(
                                  `/admin/users/${user.id}/enrollment`,
                                  'POST',
                                  {},
                                )
                            }}
                          >
                            <KeyRound
                              data-icon="inline-start"

                              aria-hidden="true"
                            />
                          </Button>
                        </QuickTip>
                      )}
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {!users.length && (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="h-28 p-4 text-center text-muted-foreground"
                >
                  {!data
                    ? error
                      ? 'Unable to load users.'
                      : 'Loading users...'
                    : query
                      ? 'No users match your search.'
                      : 'No users yet. Invite someone to get started.'}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableCard>
    </div>
  )
}

function UserDialog(props: EditorProps) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  const trigger = useRef<HTMLButtonElement>(null)
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!submitting.current) setOpen(next)
      }}
    >
      <QuickTip content={props.user ? 'Edit user' : 'Invite user'}>
        <Button
          ref={trigger}
          type="button"
          variant={props.user ? 'outline' : 'primary'}
          size={props.user ? 'icon' : 'default'}
          aria-label={props.user ? `Edit ${props.user.username}` : undefined}
          onClick={() => setOpen(true)}
        >
          {props.user ? (
            <UserPen data-icon="inline-start" aria-hidden="true" />
          ) : (
            <>
              <UserPlus
                data-icon="inline-start"

                aria-hidden="true"
              />{' '}
              Invite user
            </>
          )}
        </Button>
      </QuickTip>
      <DialogContent
        className="max-w-xl"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          trigger.current?.focus()
        }}
      >
        <DialogHeader className="pr-6">
          <DialogTitle className="break-all">
            {props.user ? `Edit ${props.user.username}` : 'Invite user'}
          </DialogTitle>
          <DialogDescription>
            {props.user
              ? "Manage this user's permissions, project access, and account status."
              : 'Invite an email address to this organization. Existing accounts keep their password and security settings.'}
          </DialogDescription>
        </DialogHeader>
        <UserForm
          {...props}
          busy={busy}
          onCancel={() => setOpen(false)}
          action={async (...args) => {
            if (submitting.current) return false
            submitting.current = true
            setBusy(true)
            try {
              const success = await props.action(...args)
              if (success) setOpen(false)
              return success
            } finally {
              submitting.current = false
              setBusy(false)
            }
          }}
        />
      </DialogContent>
    </Dialog>
  )
}

function UserForm({
  user,
  current,
  projects,
  action,
  busy,
  onCancel,
}: EditorProps & { busy: boolean; onCancel: () => void }) {
  const [selected, setSelected] = useState(user?.projects ?? [])
  const [disabled, setDisabled] = useState(user?.disabled ?? false)
  const [admin, setAdmin] = useState(user?.admin ?? false)
  const [capabilities, setCapabilities] = useState<ServerCapability[]>(
    user?.capabilities ?? [],
  )
  const [error, setError] = useState('')
  const allProjects = admin || capabilities.includes('projects.manage')
  const changed =
    !user ||
    disabled !== user.disabled ||
    admin !== user.admin ||
    JSON.stringify([...selected].sort()) !==
      JSON.stringify([...user.projects].sort()) ||
    JSON.stringify([...capabilities].sort()) !==
      JSON.stringify([...(user.capabilities ?? [])].sort())
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    const body = user
      ? {
          disabled,
          ...(hasServer(current, 'projects.manage')
            ? { projects: selected }
            : {}),
          ...(current.admin ? { admin, capabilities } : {}),
        }
      : {
          email: new FormData(event.currentTarget).get('email'),
          ...(current.admin ? { admin, capabilities } : {}),
        }
    void action(
      user ? `/admin/users/${user.id}` : '/admin/users',
      user ? 'PUT' : 'POST',
      body,
    ).then((success) => {
      if (!success) setError('Could not save this user. Please try again.')
    })
  }
  return (
    <Form onSubmit={submit} className="flex flex-col gap-5" aria-busy={busy}>
      <FieldSet disabled={busy} className="min-w-0 flex flex-col gap-5">
        {!user && (
          <Field>
            <FieldLabel>Email address</FieldLabel>
            <Input
              name="email"
              type="email"
              required
              maxLength={254}
              autoComplete="email"
              placeholder="person@example.com"
            />
          </Field>
        )}
        {user && (
          <Field>
            <FieldLabel>Account email</FieldLabel>
            <Input value={user.email ?? 'Not set'} readOnly />
            <p className="text-xs text-muted-foreground">
              The account owner manages their email and password in account
              security. Organization access changes apply only here.
            </p>
          </Field>
        )}
        {current.admin && (
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Permissions</h3>
            <ServerPermissionTree
              admin={admin}
              capabilities={capabilities}
              onChange={(admin, capabilities) => {
                setAdmin(admin)
                setCapabilities(capabilities)
              }}
            />
          </section>
        )}
        {user && hasServer(current, 'projects.manage') && (
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Project access</h3>
            {allProjects && (
              <p className="text-sm text-muted-foreground">
                {admin
                  ? 'Organization Administrators'
                  : 'Users with Manage all projects and project access'}{' '}
                can access every project. Saved memberships are retained.
              </p>
            )}
            {projects.map((project) => (
              <Field
                data-disabled={allProjects}
                orientation="horizontal"
                className="checkbox flex items-center gap-2"
                key={project.slug}
              >
                <Checkbox
                  checked={allProjects || selected.includes(project.slug)}
                  disabled={allProjects}
                  onCheckedChange={(checked) =>
                    setSelected(
                      checked === true
                        ? [...selected, project.slug]
                        : selected.filter((slug) => slug !== project.slug),
                    )
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
          </section>
        )}
        {user && (
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Account status</h3>
            <Field
              data-disabled={current.id === user.id}
              orientation="horizontal"
              className="checkbox flex items-center gap-2"
            >
              <Checkbox
                checked={disabled}
                disabled={current.id === user.id}
                onCheckedChange={(checked) => setDisabled(checked === true)}
              />
              <FieldLabel>Disabled</FieldLabel>
            </Field>
            {current.id === user.id && (
              <p className="text-xs text-muted-foreground">
                You cannot disable your own account.
              </p>
            )}
          </section>
        )}
      </FieldSet>
      <ErrorMessage message={error} />
      <DialogFooter className="flex-wrap border-t pt-4">
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={busy || !changed}>
          {busy ? 'Saving…' : user ? 'Save access' : 'Invite user'}
        </Button>
      </DialogFooter>
    </Form>
  )
}
