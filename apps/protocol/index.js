import { z } from 'zod'
import { publicAddressesSchema } from './addresses.js'
export const buildArtifactSchema = z
  .object({
    images: z
      .array(
        z.object({
          tag: z.string(),
          file: z.string().regex(/^image-\d+\.tar$/),
        }),
      )
      .max(100),
  })
  .strict()
const relativePath = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (v) =>
      v === '.' ||
      (/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(v) &&
        !v.split('/').some((p) => p === '..' || p === '.')),
    'Use a repository-relative path without traversal',
  )
export const deploymentSchema = z
  .object({
    connector_id: z.string().uuid(),
    container_name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$/),
    repository: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
      .max(201),
    connection_id: z.string().uuid().optional(),
    repository_id: z.string().min(1).max(100).optional(),
    provider_url: z.string().url().max(500).optional(),
    branch: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_./-]*$/)
      .refine(
        (s) =>
          !s.includes('..') &&
          !s.includes('//') &&
          !s.endsWith('/') &&
          !s.endsWith('.lock'),
      ),
    kind: z.enum(['dockerfile', 'compose']),
    app_root: relativePath.optional(),
    build_file: relativePath,
    build_arguments: z
      .record(
        z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
        z.string().max(16384),
      )
      .optional(),
    context: relativePath.default('.'),
    service: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/)
      .max(100)
      .default('app'),
    enabled: z.boolean().default(true),
    managed: z.boolean().optional(),
  })
  .strict()
export const deploymentJobSchema = z
  .object({
    id: z.string().uuid(),
    deployment_id: z.string().uuid(),
    project: z.string(),
    application: z.string(),
    commit: z.string().regex(/^[a-f0-9]{40}$/),
    config: deploymentSchema,
    watch_baselines: z
      .record(
        z
          .string()
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/)
          .max(100),
        z.string().regex(/^[a-f0-9]{40}$/),
      )
      .optional(),
    source_auth: z
      .object({
        token: z.string().min(1).max(4096),
        url: z.string().url().max(500),
        username: z.string().max(100).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
export const slug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(100)
export const containerSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    name: z.string().min(1).max(256),
    state: z.enum([
      'created',
      'running',
      'paused',
      'restarting',
      'removing',
      'exited',
      'dead',
    ]),
    health: z.enum(['healthy', 'unhealthy', 'starting']).optional(),
    project: slug.nullable(),
    application: slug.nullable(),
    cpu: z.number().finite().nonnegative().nullable(),
    memory: z.number().int().nonnegative().nullable(),
    memoryLimit: z.number().int().nonnegative().nullable(),
  })
  .strict()
export const snapshotSchema = z
  .object({
    version: z.literal(1),
    type: z.literal('snapshot'),
    public_addresses: publicAddressesSchema.optional(),
    host: z.string().min(1).max(256),
    containers: z.array(containerSchema).max(5000),
  })
  .strict()
  .refine(
    (s) => new Set(s.containers.map((c) => c.id)).size === s.containers.length,
    'Duplicate containers',
  )
