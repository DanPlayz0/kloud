import { createRootRoute, Link, Outlet } from '@tanstack/react-router'

export const Route = createRootRoute({
  component: () => (
    <main>
      <header>
        <Link to="/">Dedi Dash</Link>
        <nav><Link to="/about">About</Link></nav>
      </header>
      <Outlet />
    </main>
  ),
  notFoundComponent: () => <p>Page not found. <Link to="/">Go home</Link></p>,
})
