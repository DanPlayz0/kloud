import { z } from 'zod'
export interface ConnectorStatus {
  type: 'connector-status'
  version: string
  revision: string
  started_at: string
  updater: {
    configured: boolean
    enabled: boolean
    state: 'idle' | 'checking' | 'failed'
    checked_at: string | null
    completed_at: string | null
    error: string | null
  }
}
export type ConnectorUpdate =
  | { kind: 'connector-update'; action: 'check' }
  | { kind: 'connector-update'; action: 'configure'; enabled: boolean }
export const connectorStatusSchema: z.ZodType<ConnectorStatus>
export const connectorUpdateSchema: z.ZodType<ConnectorUpdate>
