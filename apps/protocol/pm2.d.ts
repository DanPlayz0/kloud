import { z } from 'zod'
export interface Pm2Worker {
  id: number
  name: string
  namespace: string
  status:
    | 'online'
    | 'stopping'
    | 'stopped'
    | 'launching'
    | 'errored'
    | 'one-launch-status'
    | 'waiting restart'
    | 'unknown'
  mode: 'fork_mode' | 'cluster_mode' | 'unknown'
  pid: number
  uptime: number | null
  restarts: number
  cpu: number | null
  memory: number | null
}
export interface Pm2Snapshot {
  version: 1
  type: 'pm2-snapshot'
  host: string
  available: boolean
  workers: Pm2Worker[]
}
export type Pm2Action = 'start' | 'stop' | 'restart' | 'reload' | 'delete'
export interface Pm2Grant {
  capability: 'view' | 'logs' | 'manage' | 'delete'
  app: string | null
}
export interface Pm2Request {
  kind: 'pm2'
  name: string
  namespace: string
  action: Pm2Action | 'logs'
  stream?: 'combined' | 'stdout' | 'stderr'
  worker?: number
}
export interface Pm2Result {
  results: { id: number; ok: boolean }[]
}
export interface Pm2Logs {
  output: string
  unavailable: boolean
}
export const pm2Actions: Pm2Action[]
export const pm2WorkerSchema: z.ZodType<Pm2Worker>
export const pm2SnapshotSchema: z.ZodType<Pm2Snapshot>
export const pm2OperationSchema: z.ZodType<{ action: Pm2Action }>
export const pm2LogQuerySchema: z.ZodType<{
  stream: 'combined' | 'stdout' | 'stderr'
  worker?: number
}>
export const pm2RequestSchema: z.ZodType<Pm2Request>
export const pm2ResultSchema: z.ZodType<Pm2Result>
export const pm2LogsSchema: z.ZodType<Pm2Logs>
export const pm2GrantSchema: z.ZodType<Pm2Grant>
export const pm2GrantsSchema: z.ZodType<Pm2Grant[]>
export function normalizePm2Grants(grants: Pm2Grant[]): Pm2Grant[]
