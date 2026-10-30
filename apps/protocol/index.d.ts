import { z } from 'zod'
export interface Container {
  id: string
  name: string
  state:
    | 'created'
    | 'running'
    | 'paused'
    | 'restarting'
    | 'removing'
    | 'exited'
    | 'dead'
  project: string | null
  application: string | null
  cpu: number | null
  memory: number | null
  memoryLimit: number | null
}
export interface Snapshot {
  version: 1
  type: 'snapshot'
  host: string
  containers: Container[]
}
export const slug: z.ZodString
export const containerSchema: z.ZodType<Container>
export const snapshotSchema: z.ZodType<Snapshot>
