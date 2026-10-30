import { createRootRoute, createRoute, createRouter, Link, Outlet } from '@tanstack/react-router'

const rootRoute = createRootRoute({
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

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: () => (
    <section>
      <h1>Dedi Dash</h1>
      <p>Your React, TypeScript, and TanStack Router website is ready.</p>
      <a href="/api/health">Check API health</a>
    </section>
  ),
})

const aboutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/about',
  component: () => (
    <section>
      <h1>About</h1>
      <p>A Vite website and a Hono API, built together in one TypeScript monorepo.</p>
    </section>
  ),
})

export const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute, aboutRoute]),
  defaultPreload: 'intent',
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
