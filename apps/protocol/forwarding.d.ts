import { z } from 'zod'
export interface ListenerConfig {
  protocol: 'tcp' | 'udp'
  bind_address: string
  port: number
  container: string
  compose_service?: string
  network: string
  target_port: number
  sources: string[]
  enabled: boolean
  application_protocol: 'generic' | 'postgresql'
}
export function addressNumber(input: string): { bits: number; value: bigint }
export function validCidr(input: string): boolean
export function sourceAllowed(source: string, cidrs: string[]): boolean
export const protectedPorts: number[]
export const listenerSchema: z.ZodType<ListenerConfig>
