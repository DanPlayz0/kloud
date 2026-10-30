import { Button, NativeSelect, Label } from './components/ui/controls'
import { useEffect, useState, type ReactNode } from 'react'
import { api, type Project, type User } from './api'

export function Icon({ name = 'box' }: { name?: string }) {
  const shapes: Record<string, ReactNode> = {
    box: (
      <>
        <rect x="3" y="3" width="18" height="7" rx="2" />
        <rect x="3" y="14" width="18" height="7" rx="2" />
        <path d="M7 6.5h.01M7 17.5h.01" />
      </>
    ),
    database: (
      <>
        <ellipse cx="12" cy="5" rx="8" ry="3" />
        <path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0" />
      </>
    ),
    chart: (
      <>
        <path d="M4 3v17h17M8 15v-4M13 15V6M18 15v-7" />
      </>
    ),
    key: (
      <>
        <circle cx="15" cy="8" r="5" />
        <path d="m11 12-8 8v2h4v-3h3v-3l3-3" />
      </>
    ),
    users: (
      <>
        <circle cx="9" cy="7" r="3" />
        <path d="M3 21v-4a6 6 0 0 1 12 0v4M17 4a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 5v2" />
      </>
    ),
    network: (
      <>
        <circle cx="12" cy="4" r="2" />
        <circle cx="4" cy="19" r="2" />
        <circle cx="20" cy="19" r="2" />
        <path d="M12 6v6H4v5M12 12h8v5" />
      </>
    ),
    globe: (
      <>
        <circle cx="12" cy="12" r="9" />
        <ellipse cx="12" cy="12" rx="4" ry="9" />
        <path d="M3 12h18" />
      </>
    ),
    activity: (
      <>
        <path d="M3 5v5h5M3 10a9 9 0 1 1 1 7M12 7v5l3 2" />
      </>
    ),
    build: (
      <>
        <path d="m3 21 9-9M14 3l7 7-4 4-7-7zM3 4l4-1 3 4-3 3z" />
      </>
    ),
    shield: (
      <>
        <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8 12l3 3 5-6" />
      </>
    ),
  }
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {shapes[name] ?? shapes.box}
    </svg>
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
  active = 'containers',
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
    <div className="app-shell">
      <Button
        className="mobile-toggle"
        onClick={() => setOpen(!open)}
        aria-label="Toggle navigation"
        aria-expanded={open}
      >
        ☰
      </Button>
      {open && (
        <Button
          className="sidebar-overlay"
          aria-label="Close navigation"
          onClick={() => setOpen(false)}
        />
      )}
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <Label className="project-picker">
          <span className="sr-only">Project</span>
          <NativeSelect
            aria-label="Project"
            value={project ?? ''}
            onChange={(e) => {
              if (e.target.value)
                location.assign(
                  `/projects/${e.target.value}/compute/containers`,
                )
            }}
          >
            <option value="" disabled>
              Select project
            </option>
            {projects.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.name}
              </option>
            ))}
          </NativeSelect>
          <span>
            ⌃<br />⌄
          </span>
        </Label>
        <nav aria-label="Main navigation">
          <div className="nav-group">
            <p>COMPUTE</p>
            <a
              className={
                active === 'containers' ? 'nav-item active' : 'nav-item'
              }
              href={project ? `/projects/${project}/compute/containers` : '/'}
            >
              <Icon />
              Containers
            </a>
            <a
              className={
                active === 'serverless' ? 'nav-item active' : 'nav-item'
              }
              href={project ? `/projects/${project}/compute/serverless` : '/'}
            >
              <Icon name="network" />
              Serverless<span className="soon">Soon</span>
            </a>
          </div>
          {groups.map(([label, items]) => (
            <div className="nav-group" key={label}>
              <p>{label}</p>
              {items.map(([name, icon]) => (
                <Button
                  className="nav-item deferred"
                  disabled
                  key={name}
                  title="Coming in a later update"
                >
                  <Icon name={icon} />
                  {name}
                </Button>
              ))}
            </div>
          ))}
          {user.admin && (
            <div className="nav-group">
              <p>ADMINISTRATION</p>
              {[
                ['Projects', 'projects', 'box'],
                ['Users', 'users', 'users'],
                ['Connectors', 'connectors', 'network'],
                ['Inventory', 'containers', 'database'],
              ].map(([label, path, icon]) => (
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
        <div className="account">
          {account && (
            <div className="account-menu">
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
            </div>
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
                {user.admin ? 'Super administrator' : 'Project member'}
              </small>
            </span>
            <span className="account-dots">···</span>
          </Button>
        </div>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <span>{title}</span>
          <span className="topbar-brand">DEDI DASH</span>
        </header>
        {children}
      </main>
    </div>
  )
}
export function usePolling<T>(path: string) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(clock)
  }, [])
  const [data, setData] = useState<T>(),
    [error, setError] = useState('')
  useEffect(() => {
    let stopped = false,
      timer: ReturnType<typeof setTimeout>
    setData(undefined)
    setError('')
    const load = async () => {
      try {
        const result = await api<T>(path)
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
      clearTimeout(timer)
    }
  }, [path])
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
