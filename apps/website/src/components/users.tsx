import { useRef, useState, type FormEvent } from 'react'
import { KeyRound, Search, UserPen, UserPlus } from 'lucide-react'
import {
  hasServer,
  type Project,
  type ServerCapability,
  type User,
} from '../api'
import { ErrorMessage, usePolling } from '../components'
import { Button, Checkbox, Input, Label } from './ui/controls'
import {
  Dialog,
  DialogContent,
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
  const { data, error } = usePolling<AdminUser[]>('/admin/users', revision)
  const [search, setSearch] = useState('')
  const query = search.trim().toLowerCase()
  const users =
    data?.filter((user) =>
      [
        user.username,
        user.admin ? 'Server Administrator' : 'Member',
        user.disabled ? 'Disabled' : user.enrolled ? 'Active' : 'Invited',
        ...user.projects,
        ...(user.capabilities ?? []),
      ].some((value) => value.toLowerCase().includes(query)),
    ) ?? []
  return (
    <div className="min-w-0 space-y-4">
      <p className="text-sm text-muted-foreground">
        Manage who can access your server and projects.
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
      <div className="relative overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-border bg-background text-muted-foreground">
            <tr>
              {['User', 'Permissions', 'Projects', 'Status'].map((title) => (
                <th key={title} scope="col" className="p-4 font-medium">
                  {title}
                </th>
              ))}
              <th scope="col" className="p-4">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr
                key={user.id}
                className="user-row border-b border-border last:border-0"
              >
                <td className="p-4">
                  <div className="flex items-center gap-3">
                    <span
                      className="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary font-medium text-muted-foreground"
                      aria-hidden="true"
                    >
                      {user.username.slice(0, 2).toUpperCase()}
                    </span>
                    <div>
                      <p className="break-all font-medium">{user.username}</p>
                      {user.id === current.id && (
                        <p className="text-xs text-muted-foreground">You</p>
                      )}
                    </div>
                  </div>
                </td>
                <td className="p-4 text-muted-foreground">
                  {user.admin
                    ? 'Server Administrator'
                    : user.capabilities?.length
                      ? `${user.capabilities.length} permission${user.capabilities.length === 1 ? '' : 's'}`
                      : 'Member'}
                </td>
                <td className="p-4 text-muted-foreground">
                  {hasServer(user, 'projects.manage')
                    ? 'All projects'
                    : `${user.projects.length} project${user.projects.length === 1 ? '' : 's'}`}
                </td>
                <td className="p-4">
                  <span className="whitespace-nowrap rounded-sm bg-secondary px-2 py-1 text-xs text-muted-foreground">
                    {user.disabled
                      ? 'Disabled'
                      : user.enrolled
                        ? 'Active'
                        : 'Invited'}
                  </span>
                </td>
                <td className="p-4">
                  {isProtected(user, current) ? (
                    <span className="cursor-not-allowed text-xs text-muted-foreground">
                      Server Administrator required
                    </span>
                  ) : (
                    <div className="flex justify-end gap-2">
                      <UserDialog
                        user={user}
                        current={current}
                        projects={projects}
                        action={action}
                      />
                      {current.id !== user.id && (
                        <QuickTip content="Reset enrollment">
                          <Button
                            type="button"
                            aria-label={`Reset enrollment for ${user.username}`}
                            onClick={() => {
                              if (
                                confirm(
                                  `Reset ${user.username}'s password and passkey enrollment? Existing sessions will end.`,
                                )
                              )
                                void action(
                                  `/admin/users/${user.id}/enrollment`,
                                  'POST',
                                  {},
                                )
                            }}
                          >
                            <KeyRound className="size-4" aria-hidden="true" />
                          </Button>
                        </QuickTip>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {!users.length && (
              <tr>
                <td
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
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
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
          variant={props.user ? 'default' : 'primary'}
          aria-label={props.user ? `Edit ${props.user.username}` : undefined}
          onClick={() => setOpen(true)}
        >
          {props.user ? (
            <UserPen className="size-4" aria-hidden="true" />
          ) : (
            <>
              <UserPlus className="size-4" aria-hidden="true" /> Invite user
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
        <DialogTitle className="break-all text-lg font-semibold">
          {props.user ? `Edit ${props.user.username}` : 'Invite user'}
        </DialogTitle>
        <DialogDescription className="mt-2 text-sm text-muted-foreground">
          {props.user
            ? "Manage this user's permissions, project access, and account status."
            : 'Create an invitation and choose the permissions this user needs.'}
        </DialogDescription>
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
          username: new FormData(event.currentTarget).get('username'),
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
    <form onSubmit={submit} className="mt-5 space-y-5" aria-busy={busy}>
      <fieldset disabled={busy} className="min-w-0 space-y-5">
        {!user && (
          <Label>
            Username
            <Input
              name="username"
              required
              maxLength={100}
              pattern="[a-zA-Z0-9_.@\-]+"
              autoComplete="off"
              placeholder="Enter a username"
            />
          </Label>
        )}
        {current.admin && (
          <section className="space-y-2">
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
          <section className="space-y-2">
            <h3 className="text-sm font-medium">Project access</h3>
            {allProjects && (
              <p className="text-sm text-muted-foreground">
                {admin
                  ? 'Server Administrators'
                  : 'Users with Manage all projects and project access'}{' '}
                can access every project. Saved memberships are retained.
              </p>
            )}
            {projects.map((project) => (
              <Label
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
                {project.name}
              </Label>
            ))}
            {!projects.length && (
              <p className="text-sm text-muted-foreground">
                No projects available.
              </p>
            )}
          </section>
        )}
        {user && (
          <section className="space-y-2">
            <h3 className="text-sm font-medium">Account status</h3>
            <Label className="checkbox flex items-center gap-2">
              <Checkbox
                checked={disabled}
                disabled={current.id === user.id}
                onCheckedChange={(checked) => setDisabled(checked === true)}
              />
              Disabled
            </Label>
            {current.id === user.id && (
              <p className="text-xs text-muted-foreground">
                You cannot disable your own account.
              </p>
            )}
          </section>
        )}
      </fieldset>
      <ErrorMessage message={error} />
      <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
        <Button type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={busy || !changed}>
          {busy ? 'Saving…' : user ? 'Save access' : 'Invite user'}
        </Button>
      </div>
    </form>
  )
}
