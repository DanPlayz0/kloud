import { z } from 'zod'
export const buildArtifactSchema: z.ZodType<{
  images: { tag: string; file: string }[]
}>
export interface DeploymentConfig {
  connector_id: string
  container_name: string
  repository: string
  connection_id?: string
  repository_id?: string
  provider_url?: string
  branch: string
  kind: 'dockerfile' | 'compose'
  app_root?: string
  build_arguments?: Record<string, string>
  build_file: string
  context: string
  service: string
  enabled: boolean
  managed?: boolean
}
export interface DeploymentJob {
  watch_baselines?: Record<string, string>
  source_auth?: { token: string; url: string; username?: string }
  id: string
  deployment_id: string
  project: string
  application: string
  commit: string
  config: DeploymentConfig
}
export const deploymentSchema: z.ZodType<DeploymentConfig>
export const deploymentJobSchema: z.ZodType<DeploymentJob>
export interface Container {
  health?: 'healthy' | 'unhealthy' | 'starting'
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
  public_addresses?: import('./addresses.js').PublicAddresses
  host: string
  containers: Container[]
}
export const slug: z.ZodString
export const containerSchema: z.ZodType<Container>
export const snapshotSchema: z.ZodType<Snapshot>
