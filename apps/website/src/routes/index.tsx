import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  component: () => (
    <section>
      <h1>Dedi Dash</h1>
      <p>Your React, TypeScript, and TanStack Router website is ready.</p>
      <a href="/api/health">Check API health</a>
    </section>
  ),
})
