import { z } from 'zod'
import { deploymentSchema } from './index.js'

const name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/)
export const runtimeSchema = z
  .object({
    environment: z
      .record(
        z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
        z.string().max(16384),
      )
      .default({}),
    ports: z
      .array(
        z
          .object({
            host: z.number().int().min(1).max(65535),
            container: z.number().int().min(1).max(65535),
            protocol: z.enum(['tcp', 'udp']).default('tcp'),
          })
          .strict(),
      )
      .max(100)
      .default([]),
    volumes: z
      .array(
        z
          .object({
            source: name,
            target: z.string().regex(/^\/[A-Za-z0-9_/.-]+$/),
            readOnly: z.boolean().default(false),
          })
          .strict(),
      )
      .max(100)
      .default([]),
    networks: z.array(name).max(20).default([]),
    restart: z
      .enum(['no', 'always', 'unless-stopped', 'on-failure'])
      .default('unless-stopped'),
    memoryMb: z.number().int().min(16).max(1048576).optional(),
    cpus: z.number().positive().max(1024).optional(),
    healthcheck: z
      .object({
        command: z.array(z.string().max(1000)).min(1).max(30),
        intervalSeconds: z.number().int().min(1).max(3600).default(30),
      })
      .strict()
      .optional(),
  })
  .strict()
export const buildInputsSchema = z
  .object({
    registry_connection_ids: z.array(z.string().uuid()).max(20).optional(),
    secrets: z
      .record(
        z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
        z.string().max(16384),
      )
      .default({}),
    registries: z
      .array(
        z
          .object({
            server: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/),
            username: z.string().min(1).max(256),
            password: z.string().min(1).max(4096),
          })
          .strict(),
      )
      .max(20)
      .default([]),
  })
  .strict()
export const deploymentPolicySchema = z
  .object({
    strategy: z.enum(['blue-green', 'stop-first']).default('blue-green'),
    allowDowntime: z.boolean().default(false),
    compatibilityReviewed: z.boolean().default(false),
    stopGraceSeconds: z.number().int().min(0).max(300).default(10),
    compose: z
      .object({
        services: z.record(
          z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/),
          z
            .object({
              include: z
                .array(
                  z
                    .string()
                    .min(1)
                    .max(256)
                    .refine(
                      (v) =>
                        !v.startsWith('/') &&
                        !v.includes('\\') &&
                        !v.split('/').includes('..'),
                      'Use repository-relative POSIX globs',
                    ),
                )
                .max(100)
                .default([]),
              exclude: z
                .array(
                  z
                    .string()
                    .min(1)
                    .max(256)
                    .refine(
                      (v) =>
                        !v.startsWith('/') &&
                        !v.includes('\\') &&
                        !v.split('/').includes('..'),
                      'Use repository-relative POSIX globs',
                    ),
                )
                .max(100)
                .default([]),
              action: z.enum(['redeploy', 'restart']).default('redeploy'),
              http: z
                .object({
                  port: z.number().int().min(1).max(65535),
                  path: z
                    .string()
                    .regex(/^\/[^\s]*$/)
                    .default('/'),
                  timeoutSeconds: z.number().int().min(1).max(60).default(5),
                })
                .strict()
                .optional(),
            })
            .strict(),
        ),
      })
      .strict()
      .optional(),
    readiness: z
      .object({
        dockerHealth: z.boolean().default(true),
        http: z
          .object({
            port: z.number().int().min(1).max(65535),
            path: z
              .string()
              .regex(/^\/[^\s]*$/)
              .max(1000)
              .default('/'),
            timeoutSeconds: z.number().int().min(1).max(60).default(5),
          })
          .strict()
          .optional(),
        timeoutSeconds: z.number().int().min(1).max(1800).default(120),
        intervalSeconds: z.number().int().min(1).max(60).default(2),
      })
      .strict()
      .default({ dockerHealth: true, timeoutSeconds: 120, intervalSeconds: 2 }),
  })
  .strict()
  .superRefine((policy, ctx) => {
    if (policy.strategy === 'stop-first' && !policy.allowDowntime)
      ctx.addIssue({
        code: 'custom',
        message: 'Stop-before-start requires explicit downtime permission',
      })
    if (
      policy.strategy === 'blue-green' &&
      !policy.readiness.dockerHealth &&
      !policy.readiness.http &&
      !(
        Object.keys(policy.compose?.services ?? {}).length &&
        Object.values(policy.compose.services).every((service) => service.http)
      )
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Blue/green requires at least one readiness check',
      })
  })
export const platformConfigSchema = z
  .object({
    connector_id: z.string().uuid(),
    deployment: deploymentPolicySchema.optional(),
    build_inputs: buildInputsSchema.optional(),
    source: z.discriminatedUnion('type', [
      z
        .object({ type: z.literal('github'), config: deploymentSchema })
        .strict(),
      z
        .object({
          type: z.literal('image'),
          image: z
            .string()
            .min(1)
            .max(256)
            .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/)
            .refine(
              (v) =>
                !v.includes('://') &&
                (!v.includes('@') || /@sha256:[a-f0-9]{64}$/.test(v)),
              'Use an image name or SHA-256 digest without a credential URL',
            ),
          registry: z
            .object({
              server: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/),
              username: z.string().min(1).max(256),
              password: z.string().min(1).max(4096),
            })
            .strict()
            .optional(),
        })
        .strict(),
      z
        .object({
          type: z.literal('compose'),
          content: z.string().min(1).max(48000),
        })
        .strict(),
    ]),
    runtime: runtimeSchema,
  })
  .strict()
  .superRefine((config, ctx) => {
    if (
      config.source.type === 'github' &&
      config.source.config.connector_id !== config.connector_id
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Source host must match deployment host',
      })
  })
export const runtimeRequestSchema = z
  .object({
    action: z.enum([
      'inspect',
      'logs',
      'start',
      'stop',
      'restart',
      'terminal-open',
      'terminal-read',
      'terminal-write',
      'terminal-close',
      'terminal-resize',
    ]),
    session: z.string().uuid().optional(),
    input: z.string().max(8192).optional(),
    rows: z.number().int().min(1).max(500).optional(),
    cols: z.number().int().min(1).max(500).optional(),
  })
  .strict()
export const domainSchema = z
  .object({
    hostname: z
      .string()
      .toLowerCase()
      .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/)
      .max(253),
    path: z
      .string()
      .regex(/^\/[a-zA-Z0-9/_-]*$/)
      .max(256)
      .default('/'),
    port: z.number().int().min(1).max(65535),
    container: name,
    network: name,
    https: z.boolean().default(false),
    redirect: z.boolean().default(true),
  })
  .strict()
