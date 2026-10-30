import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/about')({
  component: () => (
    <section>
      <h1>About</h1>
      <p>A Vite website and a Hono API, built together in one TypeScript monorepo.</p>
    </section>
  ),
})
