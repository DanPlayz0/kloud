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
  ChevronsUpDown,
  Ellipsis,
  ArrowUpRight,
  ArrowRight,
  X,
  type LucideIcon,
} from 'lucide-react'
import { Button } from './components/ui/controls'
import QuickTip from './components/quickTip'
import { ProjectPicker } from './components/project-picker'
import { Card } from './components/ui/card'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from './components/ui/breadcrumb'
import { Fragment, useEffect, useState, type ReactNode } from 'react'
import {
  api,
  hasServer,
  adminCapabilities,
  type Project,
  type User,
} from './api'

const icons: Record<string, LucideIcon> = {
  box: Server,
  database: Database,
  chart: ChartColumnIncreasing,
  key: KeyRound,
  users: Users,
  network: Network,
  globe: Globe,
  activity: History,
  build: Hammer,
  shield: ShieldCheck,
  menu: Menu,
  chevrons: ChevronsUpDown,
  more: Ellipsis,
  external: ArrowUpRight,
  arrow: ArrowRight,
  close: X,
}
export function Icon({
  name = 'box',
  className,
}: {
  name?: string
  className?: string
}) {
  const Component = icons[name] ?? Server
  return (
    <Component
      size={16}
      strokeWidth={1.6}
      className={className}
      aria-hidden="true"
    />
  )
}
const groups = [
  [
    'BUILD',
    [
      ['Builds', 'build'],
      ['Triggers', 'network'],
    ],
  ],
  [
    'STORAGE',
    [
      ['Database', 'database'],
      ['Cache', 'activity'],
      ['Block storage', 'box'],
      ['Messaging', 'box'],
      ['Analytics', 'chart'],
    ],
  ],
  [
    'NETWORKING',
    [
      ['Load balancers', 'network'],
      ['Domain management', 'globe'],
      ['Cloud DNS', 'network'],
    ],
  ],
  [
    'OPERATIONS',
    [
      ['Secrets', 'key'],
      ['Access', 'users'],
      ['Activity', 'activity'],
    ],
  ],
] as const

export function Shell({
  user,
  projects,
  project,
  active = 'services',
  title,
  children,
}: {
  user: User
  projects: Project[]
  project?: string
  active?: string
  title: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(false),
    [account, setAccount] = useState(false),
    [error, setError] = useState('')
  return (
    <div className="app-shell bg-background text-foreground">
      <Button
        className="mobile-toggle"
        onClick={() => setOpen(!open)}
        aria-label="Toggle navigation"
        aria-expanded={open}
      >
        <Icon name="menu" />
      </Button>
      {open && (
        <Button
          className="sidebar-overlay"
          aria-label="Close navigation"
          onClick={() => setOpen(false)}
        />
      )}
      <aside
        className={`sidebar bg-background border-border ${open ? 'open' : ''}`}
      >
        <ProjectPicker user={user} projects={projects} project={project} />
        <nav aria-label="Main navigation">
          {project && (
            <>
              <div className="nav-group">
                <p>COMPUTE</p>
                <a
                  className={
                    active === 'services' ? 'nav-item active' : 'nav-item'
                  }
                  href={`/projects/${project}/services`}
                >
                  <Icon name="box" />
                  Services
                </a>
                <a
                  className={
                    active === 'containers' ? 'nav-item active' : 'nav-item'
                  }
                  href={
                    project ? `/projects/${project}/compute/containers` : '/'
                  }
                >
                  <Icon />
                  Containers
                </a>
                <a
                  className={
                    active === 'serverless' ? 'nav-item active' : 'nav-item'
                  }
                  href={
                    project ? `/projects/${project}/compute/serverless` : '/'
                  }
                >
                  <Icon name="network" />
                  Serverless<span className="soon">Soon</span>
                </a>
                <a
                  className={active === 'pm2' ? 'nav-item active' : 'nav-item'}
                  href={`/projects/${project}/compute/pm2`}
                >
                  <Icon name="activity" />
                  PM2
                </a>
              </div>
              {groups.map(([label, items]) => (
                <div className="nav-group" key={label}>
                  <p>{label}</p>
                  {items
                    .filter(
                      ([name]) =>
                        name !== 'Access' ||
                        !project ||
                        projects.find((p) => p.slug === project)
                          ?.can_manage_access,
                    )
                    .map(([name, icon]) =>
                      name === 'Cloud DNS' && project ? (
                        <a
                          key={name}
                          className={`nav-item ${active === 'dns' ? 'active' : ''}`}
                          href={`/projects/${project}/dns`}
                        >
                          <Icon name={icon} />
                          Cloud DNS
                        </a>
                      ) : name === 'Access' &&
                        project &&
                        projects.find((p) => p.slug === project)
                          ?.can_manage_access ? (
                        <a
                          key={name}
                          className={`nav-item ${active === 'access' ? 'active' : ''}`}
                          href={`/projects/${project}/access`}
                        >
                          <Icon name={icon} />
                          Access
                        </a>
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
                              className="nav-item deferred pointer-events-none"
                              disabled
                            >
                              <Icon name={icon} />
                              {name}
                            </Button>
                          </span>
                        </QuickTip>
                      ),
                    )}
                </div>
              ))}
            </>
          )}
          {(user.admin || !!user.capabilities?.length) && (
            <div className="nav-group">
              <p>ADMINISTRATION</p>
              {[
                ['Projects', 'projects', 'box'],
                ['Users', 'users', 'users'],
                ['Connectors', 'connectors', 'network'],
                ['Inventory', 'containers', 'database'],
                ['DNS providers', 'dns', 'globe'],
              ]
                .filter(([, path]) =>
                  hasServer(user, adminCapabilities[path!]!),
                )
                .map(([label, path, icon]) => (
                  <a
                    className={`nav-item ${active === `admin-${path}` ? 'active' : ''}`}
                    key={path}
                    href={`/admin/${path}`}
                  >
                    <Icon name={icon} />
                    {label}
                  </a>
                ))}
            </div>
          )}
        </nav>
        <div className="account border-border">
          {account && (
            <Card className="account-menu">
              <Button
                onClick={() => {
                  void api('/auth/logout', 'POST')
                    .then(() => location.assign('/login'))
                    .catch((e) => setError(e.message))
                }}
              >
                Sign out
              </Button>
              {error && <p role="alert">{error}</p>}
            </Card>
          )}
          <Button
            className="account-button"
            onClick={() => setAccount(!account)}
            aria-expanded={account}
          >
            <span className="avatar">
              <Icon name="shield" />
            </span>
            <span>
              <strong>{user.username}</strong>
              <small>
                {user.admin
                  ? 'Server Administrator'
                  : user.capabilities?.length
                    ? 'Server permissions'
                    : projects.find((p) => p.slug === project)?.role === 'admin'
                      ? 'Project Administrator'
                      : 'Project Member'}
              </small>
            </span>
            <Icon name="more" className="account-dots" />
          </Button>
        </div>
      </aside>
      <main className="workspace bg-background">
        <header className="topbar border-border text-muted-foreground">
          <Breadcrumb className="min-w-0">
            <BreadcrumbList className="text-xs">
              {title.split(' / ').map((part, index, parts) => (
                <Fragment key={index}>
                  {index > 0 && <BreadcrumbSeparator />}
                  <BreadcrumbItem>
                    {index === parts.length - 1 ? (
                      <BreadcrumbPage className="break-all">
                        {part}
                      </BreadcrumbPage>
                    ) : (
                      <span>{part}</span>
                    )}
                  </BreadcrumbItem>
                </Fragment>
              ))}
            </BreadcrumbList>
          </Breadcrumb>
          <span className="topbar-brand">DEDI DASH</span>
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
    <div className="notice">
      <Icon />
      <h2>{title}</h2>
      <p>{children}</p>
    </div>
  )
}
export function ErrorMessage({ message }: { message: string }) {
  return message ? (
    <p className="error" role="alert">
      {message}
    </p>
  ) : null
}
export function bytes(value: number | null) {
  if (value === null) return '—'
  return value >= 1073741824
    ? `${(value / 1073741824).toFixed(1)} GiB`
    : `${(value / 1048576).toFixed(0)} MiB`
}
