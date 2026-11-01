import { Button } from '../components/ui/controls'
import { Alert, AlertTitle, AlertDescription } from '../components/ui/alert'
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyContent,
} from '../components/ui/empty'
import { createRootRoute, Outlet } from '@tanstack/react-router'

export const Route = createRootRoute({
  component: Outlet,
  errorComponent: ({ error, reset }) => (
    <Alert>
      <AlertTitle>
        <h1>Unable to open this page</h1>
      </AlertTitle>
      <AlertDescription>
        {error instanceof Error ? error.message : 'Unable to load this page'}
      </AlertDescription>
      <Button onClick={reset}>Try again</Button> <a href="/">Go home</a>
    </Alert>
  ),
  notFoundComponent: () => (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>
          <h1>Page not found</h1>
        </EmptyTitle>
      </EmptyHeader>
      <EmptyContent>
        <Button asChild>
          <a href="/">Go home</a>
        </Button>
      </EmptyContent>
    </Empty>
  ),
})
