import { z } from 'zod'
export const buildArtifactSchema: z.ZodType<{
  images: { tag: string; file: string }[]
}>
export interface DeploymentConfig {
  connector_id: string
  container_name: string
  repository: string
  branch: string
  kind: 'dockerfile' | 'compose'
  build_file: string
  context: string
  service: string
  enabled: boolean
  managed?: boolean
}
export interface DeploymentJob {
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
