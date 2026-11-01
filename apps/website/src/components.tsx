import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from './components/ui/dialog'
import { NavigationGroup } from './components/navigation-group'
import { NavigationSearch } from './components/navigation-search'
import { Badge } from './components/ui/badge'
import { Link, useLocation } from '@tanstack/react-router'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
} from './components/ui/dropdown-menu'
import { Alert, AlertDescription } from './components/ui/alert'
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from './components/ui/empty'
import { cn } from '@/lib/utils'
import {
  Server,
  Database,
  ChartColumnIncreasing,
  KeyRound,
  Users,
  Network,
  Globe,
  History,
  Hammer,
  ShieldCheck,
  Menu,
  Ellipsis,
  GitBranch,
  type LucideIcon,
} from 'lucide-react'
import { Button } from './components/ui/controls'
import QuickTip from './components/quickTip'
import { ProjectPicker } from './components/project-picker'
import { OrganizationSwitcher } from './organization-switcher'

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from './components/ui/breadcrumb'
import { Fragment, useEffect, useState, useRef, type ReactNode } from 'react'
import {
  api,
  hasServer,
  adminCapabilities,
  canBrowseConnectors,
  canBrowseConnectorResources,
  type Connector,
  type Project,
  type User,
} from './api'

export function Icon({
  icon: Component = Server,
  className,
  ...props
}: {
  icon?: LucideIcon
  className?: string
  'data-icon'?: 'inline-start' | 'inline-end'
}) {
  return (
    <Component
      strokeWidth={1.6}
      className={className}
      aria-hidden="true"
      {...props}
    />
  )
}
const groups = [
  [
    'BUILD',
    [
      ['Builds', Hammer],
      ['Triggers', Network],
    ],
  ],
  [
    'STORAGE',
    [
      ['Databases', Database],
      ['Cache', History],
      ['Block storage', Server],
      ['Messaging', Server],
      ['Analytics', ChartColumnIncreasing],
    ],
  ],
  [
    'NETWORKING',
    [
      ['Load balancers', Network],
      ['Domain management', Globe],
      ['Cloud DNS', Network],
    ],
  ],
  [
    'OPERATIONS',
    [
      ['Secrets', KeyRound],
      ['Access', Users],
      ['Activity', History],
    ],
  ],
] as const

export function Shell({
  user,
  projects,
  project,
  connector,
  active = 'services',
  title,
  children,
}: {
  user: User
  projects: Project[]
  project?: string
  connector?: Connector
  active?: string
  title: string
  children: ReactNode
}) {
  const { data: connectors, error: connectorError } = usePolling<Connector[]>(
    canBrowseConnectors(user) ? '/connectors' : null,
  )
  const currentConnector =
    (Array.isArray(connectors)
      ? connectors.find((c) => c.id === connector?.id)
      : undefined) ?? connector
  const [open, setOpen] = useState(false),
    [account, setAccount] = useState(false),
    [error, setError] = useState('')
  const [mobile, setMobile] = useState(
    () => window.matchMedia('(width < 720px)').matches,
  )
  const navigationTrigger = useRef<HTMLButtonElement>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  useEffect(() => {
    const query = window.matchMedia('(width < 720px)')
    const update = () => {
      setMobile(query.matches)
      if (!query.matches) setOpen(false)
    }
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  const pathname = useLocation({ select: (location) => location.pathname })
  useEffect(() => {
    setOpen(false)
    setAccount(false)
    setSearchOpen(false)
  }, [pathname])
  const navigation = (
    <aside
      id="sidebar-navigation"
      className={cn(
        'sidebar bg-sidebar border-sidebar-border',
        open ? 'open' : '',
        mobile ? 'relative h-full w-full translate-x-0 border-r-0' : '',
      )}
    >
      <OrganizationSwitcher admin={user.admin} />
      <ProjectPicker
        user={user}
        projects={projects}
        project={project}
        connector={currentConnector}
        connectors={Array.isArray(connectors) ? connectors : []}
        connectorError={connectorError}
        showConnectors={canBrowseConnectors(user)}
      />
      <nav aria-label="Main navigation">
        {currentConnector && (
          <NavigationGroup title="CONNECTOR" mobile={mobile}>
            {[
              ['Overview', 'overview', Network] as const,
              ...(canBrowseConnectorResources(user)
                ? [
                    ['Containers', 'compute/containers', Server] as const,
                    ['PM2', 'compute/pm2', History] as const,
                  ]
                : []),
            ].map(([label, path, icon]) => (
              <Link
                key={path}
                className={cn(active === path ? 'nav-item active' : 'nav-item')}
                aria-current={active === path ? 'page' : undefined}
                to={
                  path === 'overview'
                    ? '/connectors/$connectorId/overview'
                    : path === 'compute/pm2'
                      ? '/connectors/$connectorId/compute/pm2'
                      : '/connectors/$connectorId/compute/containers'
                }
                params={{ connectorId: currentConnector.id }}
              >
                <Icon icon={icon as LucideIcon} />
                {label}
              </Link>
            ))}
          </NavigationGroup>
        )}
        {project && (
          <>
            <NavigationGroup title="COMPUTE" mobile={mobile}>
              <Link
                className={cn(
                  active === 'services' ? 'nav-item active' : 'nav-item',
                )}
                to="/projects/$projectSlug/services"
                params={{ projectSlug: project }}
                aria-current={active === 'services' ? 'page' : undefined}
              >
                <Icon icon={Server} />
                Services
              </Link>
              <Link
                className={cn(
                  active === 'containers' ? 'nav-item active' : 'nav-item',
                )}
                to="/projects/$projectSlug/compute/containers"
                params={{ projectSlug: project }}
                aria-current={active === 'containers' ? 'page' : undefined}
              >
                <Icon />
                Containers
              </Link>
              <Link
                className={cn(
                  active === 'serverless' ? 'nav-item active' : 'nav-item',
                )}
                to="/projects/$projectSlug/compute/serverless"
                params={{ projectSlug: project }}
                aria-current={active === 'serverless' ? 'page' : undefined}
              >
                <Icon icon={Network} />
                Serverless
                <Badge variant="outline" className="ml-auto text-sidebar-muted">
                  Soon
                </Badge>
              </Link>
              <Link
                className={cn(
                  active === 'pm2' ? 'nav-item active' : 'nav-item',
                )}
                to="/projects/$projectSlug/compute/pm2"
                params={{ projectSlug: project }}
                aria-current={active === 'pm2' ? 'page' : undefined}
              >
                <Icon icon={History} />
                PM2
              </Link>
            </NavigationGroup>
            {groups.map(([label, items]) => (
              <NavigationGroup title={label} mobile={mobile} key={label}>
                {items
                  .filter(
                    ([name]) =>
                      name !== 'Access' ||
                      !project ||
                      projects.find((p) => p.slug === project)
                        ?.can_manage_access,
                  )
                  .map(([name, icon]) =>
                    name === 'Databases' || name === 'Cache' ? (
                      <Link
                        key={name}
                        className={cn(
                          active === (name === 'Cache' ? 'cache' : 'databases')
                            ? 'nav-item active'
                            : 'nav-item',
                        )}
                        to={
                          name === 'Cache'
                            ? '/projects/$projectSlug/cache'
                            : '/projects/$projectSlug/databases'
                        }
                        params={{ projectSlug: project }}
                        aria-current={
                          active === (name === 'Cache' ? 'cache' : 'databases')
                            ? 'page'
                            : undefined
                        }
                      >
                        <Icon icon={icon as LucideIcon} />
                        {name}
                      </Link>
                    ) : name === 'Cloud DNS' && project ? (
                      <Link
                        key={name}
                        className={cn(
                          'nav-item',
                          active === 'dns' ? 'active' : '',
                        )}
                        to="/projects/$projectSlug/dns"
                        params={{ projectSlug: project }}
                        aria-current={active === 'dns' ? 'page' : undefined}
                      >
                        <Icon icon={icon as LucideIcon} />
                        Cloud DNS
                      </Link>
                    ) : name === 'Access' &&
                      project &&
                      projects.find((p) => p.slug === project)
                        ?.can_manage_access ? (
                      <Link
                        key={name}
                        className={cn(
                          'nav-item',
                          active === 'access' ? 'active' : '',
                        )}
                        to="/projects/$projectSlug/access"
                        params={{ projectSlug: project }}
                        aria-current={active === 'access' ? 'page' : undefined}
                      >
                        <Icon icon={icon as LucideIcon} />
                        Access
                      </Link>
                    ) : (
                      <QuickTip
                        key={name}
                        portal
                        content={
                          name === 'Access'
                            ? 'Select a project to manage access'
                            : 'Coming in a later update'
                        }
                      >
                        <span
                          tabIndex={0}
                          className="block w-full cursor-not-allowed"
                        >
                          <Button
                            variant="ghost"
                            className="nav-item deferred pointer-events-none justify-start"
                            disabled
                          >
                            <Icon
                              data-icon="inline-start"
                              icon={icon as LucideIcon}
                            />
                            {name}
                            <Badge
                              variant="outline"
                              className="ml-auto text-sidebar-muted"
                            >
                              Soon
                            </Badge>
                          </Button>
                        </span>
                      </QuickTip>
                    ),
                  )}
              </NavigationGroup>
            ))}
          </>
        )}
        {Object.values(adminCapabilities).some((capability) =>
          hasServer(user, capability),
        ) && (
          <NavigationGroup title="ADMINISTRATION" mobile={mobile}>
            {(
              [
                ['Projects', 'projects', Server],
                ['Users', 'users', Users],
                ['Connectors', 'connectors', Network],
                ['Inventory', 'containers', Database],
                ['DNS providers', 'dns', Globe],
                ['Git connections', 'git-connections', GitBranch],
              ] as const
            )
              .filter(([, path]) => hasServer(user, adminCapabilities[path!]!))
              .map(([label, path, icon]) => (
                <Link
                  className={cn(
                    'nav-item',
                    active === `admin-${path}` ? 'active' : '',
                  )}
                  key={path}
                  to="/admin/$section"
                  params={{ section: path }}
                  aria-current={active === `admin-${path}` ? 'page' : undefined}
                >
                  <Icon icon={icon as LucideIcon} />
                  {label}
                </Link>
              ))}
          </NavigationGroup>
        )}
      </nav>
      <div className="account border-border">
        <DropdownMenu open={account} onOpenChange={setAccount}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="account-button">
              <span className="avatar">
                <Icon data-icon="inline-start" icon={ShieldCheck} />
              </span>
              <span>
                <strong>{user.username}</strong>
                <small>
                  {user.admin
                    ? 'Organization Administrator'
                    : user.capabilities?.length
                      ? 'Organization permissions'
                      : projects.find((p) => p.slug === project)?.role ===
                          'admin'
                        ? 'Project Administrator'
                        : 'Project Member'}
                </small>
              </span>
              <Icon
                data-icon="inline-start"
                icon={Ellipsis}
                className="account-dots"
              />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="top"
            align="start"
            className="w-[var(--radix-dropdown-menu-trigger-width)]"
          >
            <DropdownMenuGroup>
              <DropdownMenuItem asChild>
                <Link to="/account/security">Account security</Link>
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  void api('/auth/logout', 'POST')
                    .then(() => location.assign('/login'))
                    .catch((e) => setError(e.message))
                }}
              >
                Sign out
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <ErrorMessage message={error} />
      </div>
    </aside>
  )
  return (
    <div className="app-shell bg-background text-foreground">
      <Button
        asChild
        variant="outline"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[100]"
      >
        <a href="#workspace-content">Skip to content</a>
      </Button>
      {mobile ? (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent
            closeLabel="Close navigation"
            className="top-0 left-0 flex h-dvh max-h-none w-72 max-w-[calc(100vw-2rem)] translate-x-0 translate-y-0 gap-0 overflow-hidden rounded-none border-0 p-0"
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              if (!searchOpen) navigationTrigger.current?.focus()
            }}
          >
            <DialogTitle className="sr-only">Navigation</DialogTitle>
            <DialogDescription className="sr-only">
              Choose an organization, project, connector, or account page.
            </DialogDescription>
            {navigation}
          </DialogContent>
        </Dialog>
      ) : (
        navigation
      )}
      <main
        id="workspace-content"
        tabIndex={-1}
        className="workspace bg-background outline-none"
      >
        <header className="topbar border-border bg-background text-muted-foreground">
          <Button
            ref={navigationTrigger}
            className="mobile-toggle hidden shrink-0 max-[720px]:inline-flex"
            variant="outline"
            size="icon"
            onClick={() => setOpen(!open)}
            aria-label="Toggle navigation"
            aria-controls="sidebar-navigation"
            aria-expanded={open}
          >
            <Icon data-icon="inline-start" icon={Menu} />
          </Button>
          <Breadcrumb className="min-w-0 flex-1">
            <BreadcrumbList className="text-xs">
              {(currentConnector
                ? currentConnector.name + ' / ' + title
                : title
              )
                .split(' / ')
                .map((part, index, parts) => (
                  <Fragment key={index}>
                    {index > 0 && <BreadcrumbSeparator />}
                    <BreadcrumbItem>
                      {index === parts.length - 1 ? (
                        <BreadcrumbPage className="break-all">
                          {part}
                        </BreadcrumbPage>
                      ) : (
                        <span className="break-all">{part}</span>
                      )}
                    </BreadcrumbItem>
                  </Fragment>
                ))}
            </BreadcrumbList>
          </Breadcrumb>
          <NavigationSearch
            user={user}
            projects={projects}
            connectors={
              Array.isArray(connectors)
                ? connectors
                : currentConnector
                  ? [currentConnector]
                  : []
            }
            open={searchOpen}
            onOpenChange={(value) => {
              setSearchOpen(value)
              if (value) setOpen(false)
            }}
          />
          <span className="topbar-brand">KLOUD</span>
        </header>
        {children}
      </main>
    </div>
  )
}
export function usePolling<T>(path: string | null, refreshKey = 0) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(clock)
  }, [])
  const [data, setData] = useState<T>(),
    [error, setError] = useState('')
  useEffect(() => setData(undefined), [path])
  useEffect(() => {
    if (path === null) return
    let stopped = false,
      timer: ReturnType<typeof setTimeout>
    const abort = new AbortController()
    setError('')
    const load = async () => {
      try {
        const result = await api<T>(path, 'GET', undefined, abort.signal)
        if (!stopped) {
          setData(result)
          setError('')
        }
      } catch (e) {
        if (!stopped)
          setError(e instanceof Error ? e.message : 'Unable to load data')
      } finally {
        if (!stopped)
          timer = setTimeout(() => {
            void load()
          }, 5000)
      }
    }
    void load()
    return () => {
      stopped = true
      abort.abort()
      clearTimeout(timer)
    }
  }, [path, refreshKey])
  return { data, error, now }
}
export function Notice({
  title,
  children,
}: {
  title: string
  children?: ReactNode
}) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>
          <h2>{title}</h2>
        </EmptyTitle>
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}
export function ErrorMessage({ message }: { message: string }) {
  return message ? (
    <Alert variant="destructive">
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  ) : null
}
export function bytes(value: number | null) {
  if (value === null) return '—'
  return value >= 1073741824
    ? `${(value / 1073741824).toFixed(1)} GiB`
    : `${(value / 1048576).toFixed(0)} MiB`
}
