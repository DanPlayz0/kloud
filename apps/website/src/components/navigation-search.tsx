import { useEffect, useRef } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Search } from 'lucide-react'
import {
  adminCapabilities,
  canBrowseConnectors,
  canBrowseConnectorResources,
  hasServer,
  type User,
  type Project,
  type Connector,
} from '../api'
import { Button } from './ui/controls'
import QuickTip from './quickTip'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from './ui/dialog'
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from './ui/command'

export function NavigationSearch({
  user,
  projects,
  connectors,
  open,
  onOpenChange,
}: {
  user: User
  projects: Project[]
  connectors: Connector[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const navigate = useNavigate()
  const trigger = useRef<HTMLButtonElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const changeOpen = (value: boolean) => {
    if (value && !open)
      returnFocus.current = document.activeElement as HTMLElement | null
    onOpenChange(value)
  }
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== 'k' ||
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.shiftKey ||
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat
      )
        return
      event.preventDefault()
      changeOpen(!open)
    }
    document.addEventListener('keydown', shortcut)
    return () => document.removeEventListener('keydown', shortcut)
  })
  const item = (label: string, href: string, context: string) => (
    <CommandItem
      key={href}
      value={`${context} ${label} ${href}`}
      onSelect={() => {
        onOpenChange(false)
        void navigate({ to: href })
      }}
    >
      <span>{label}</span>
    </CommandItem>
  )
  return (
    <>
      <QuickTip portal content="Search pages (Command/Ctrl+K)">
        <Button
          ref={trigger}
          variant="ghost"
          size="icon"
          aria-label="Search navigation"
          aria-keyshortcuts="Meta+K Control+K"
          onClick={() => changeOpen(true)}
        >
          <Search aria-hidden="true" />
        </Button>
      </QuickTip>
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent
          className="gap-0 overflow-hidden p-0"
          closeLabel="Close search"
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            const target = returnFocus.current
            if (
              target?.isConnected &&
              !target.closest('[inert],[aria-hidden="true"]')
            )
              target.focus()
            else trigger.current?.focus()
          }}
        >
          <DialogTitle className="sr-only">Go to a page</DialogTitle>
          <DialogDescription className="sr-only">
            Search project tabs, connector pages, administration, and account
            settings. Use the arrow keys and Enter to navigate, or Escape to
            close.
          </DialogDescription>
          <Command key={open ? 'open' : 'closed'} label="Navigation">
            <CommandInput
              className="pr-10"
              autoFocus
              placeholder="Search pages…"
              aria-label="Search pages"
            />
            <CommandList>
              <CommandEmpty>No matching pages.</CommandEmpty>
              {projects.map((project) => (
                <CommandGroup
                  key={project.slug}
                  heading={`Project: ${project.name}`}
                >
                  {[
                    ['Services', 'services'],
                    ['Containers', 'compute/containers'],
                    ['PM2', 'compute/pm2'],
                    ['Serverless', 'compute/serverless'],
                    ['Databases', 'databases'],
                    ['Cache', 'cache'],
                    ['Cloud DNS', 'dns'],
                    ...(project.can_manage_access
                      ? [['Access', 'access']]
                      : []),
                  ].map(([label, path]) =>
                    item(
                      label!,
                      `/projects/${encodeURIComponent(project.slug)}/${path}`,
                      `Project ${project.name} ${project.slug}`,
                    ),
                  )}
                </CommandGroup>
              ))}
              {canBrowseConnectors(user) &&
                connectors.map((connector) => (
                  <CommandGroup
                    key={connector.id}
                    heading={`Connector: ${connector.name}`}
                  >
                    {item(
                      'Overview',
                      `/connectors/${encodeURIComponent(connector.id)}/overview`,
                      connector.name,
                    )}
                    {canBrowseConnectorResources(user) && (
                      <>
                        {item(
                          'Containers',
                          `/connectors/${encodeURIComponent(connector.id)}/compute/containers`,
                          connector.name,
                        )}
                        {item(
                          'PM2',
                          `/connectors/${encodeURIComponent(connector.id)}/compute/pm2`,
                          connector.name,
                        )}
                      </>
                    )}
                  </CommandGroup>
                ))}
              <CommandGroup heading="Administration">
                {[
                  ['Projects', 'projects'],
                  ['Users', 'users'],
                  ['Connectors', 'connectors'],
                  ['Inventory', 'containers'],
                  ['DNS providers', 'dns'],
                  ['Git connections', 'git-connections'],
                ]
                  .filter(([, path]) =>
                    hasServer(user, adminCapabilities[path!]!),
                  )
                  .map(([label, path]) =>
                    item(label!, `/admin/${path}`, 'Administration'),
                  )}
              </CommandGroup>
              <CommandGroup heading="Account">
                {item('Account security', '/account/security', 'Account')}
                {item('About', '/about', 'Account')}
              </CommandGroup>
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>
    </>
  )
}
