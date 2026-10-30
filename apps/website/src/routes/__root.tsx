import { Button } from '../components/ui/controls'
import { createRootRoute, Outlet } from '@tanstack/react-router'

export const Route = createRootRoute({
  component: Outlet,
  errorComponent: ({ error, reset }) => (
    <div className="notice">
      <h1>Unable to open this page</h1>
      <p role="alert">
        {error instanceof Error ? error.message : 'Unable to load this page'}
      </p>
      <Button onClick={reset}>Try again</Button> <a href="/">Go home</a>
    </div>
  ),
  notFoundComponent: () => (
    <div className="notice">
      <h1>Page not found</h1>
      <a href="/">Go home</a>
    </div>
  ),
})
