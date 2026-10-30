import { z } from 'zod'
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
    build_file: relativePath,
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
    host: z.string().min(1).max(256),
    containers: z.array(containerSchema).max(5000),
  })
  .strict()
  .refine(
    (s) => new Set(s.containers.map((c) => c.id)).size === s.containers.length,
    'Duplicate containers',
  )
