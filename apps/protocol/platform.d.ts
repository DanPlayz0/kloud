import { z } from 'zod'
import type { DeploymentConfig } from './index.js'
export interface RuntimeConfig {
  environment: Record<string, string>
  ports: { host: number; container: number; protocol: 'tcp' | 'udp' }[]
  volumes: { source: string; target: string; readOnly: boolean }[]
  networks: string[]
  restart: 'no' | 'always' | 'unless-stopped' | 'on-failure'
  memoryMb?: number
  cpus?: number
  healthcheck?: { command: string[]; intervalSeconds: number }
}
export interface BuildInputs {
  registry_connection_ids?: string[]
  secrets: Record<string, string>
  registries: { server: string; username: string; password: string }[]
}
export const buildInputsSchema: z.ZodType<BuildInputs>
export interface DeploymentPolicy {
  strategy: 'blue-green' | 'stop-first'
  allowDowntime: boolean
  compatibilityReviewed: boolean
  stopGraceSeconds: number
  compose?: {
    services: Record<
      string,
      {
        include: string[]
        exclude: string[]
        action: 'redeploy' | 'restart'
        http?: { port: number; path: string; timeoutSeconds: number }
      }
    >
  }
  readiness: {
    dockerHealth: boolean
    http?: { port: number; path: string; timeoutSeconds: number }
    timeoutSeconds: number
    intervalSeconds: number
  }
}
export const deploymentPolicySchema: z.ZodType<DeploymentPolicy>
export interface PlatformConfig {
  deployment?: DeploymentPolicy
  build_inputs?: BuildInputs
  connector_id: string
  source:
    | { type: 'github'; config: DeploymentConfig }
    | {
        type: 'image'
        image: string
        registry?: { server: string; username: string; password: string }
      }
    | { type: 'compose'; content: string }
  runtime: RuntimeConfig
}
export interface Domain {
  hostname: string
  path: string
  port: number
  container: string
  network: string
  https: boolean
  redirect: boolean
}
export interface RuntimeRequest {
  action:
    | 'inspect'
    | 'logs'
    | 'start'
    | 'stop'
    | 'restart'
    | 'terminal-open'
    | 'terminal-read'
    | 'terminal-write'
    | 'terminal-close'
    | 'terminal-resize'
  session?: string
  input?: string
  rows?: number
  cols?: number
}
export const runtimeSchema: z.ZodType<RuntimeConfig>
export const platformConfigSchema: z.ZodType<PlatformConfig>
export const runtimeRequestSchema: z.ZodType<RuntimeRequest>
export const domainSchema: z.ZodType<Domain>
