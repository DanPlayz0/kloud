import { createHash, createHmac } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { stat, rm } from 'node:fs/promises'
import { request } from 'node:https'
import { pipeline } from 'node:stream/promises'

export interface RetainedPoint {
  id: string
  metadata: { size: number; key?: string; path?: string; job?: string }
  created: string
}
export function retentionPlan(
  points: RetainedPoint[],
  incoming: number,
  maxBytes: number,
  minimum: number,
) {
  if (
    !Number.isSafeInteger(incoming) ||
    incoming < 0 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    !Number.isInteger(minimum) ||
    minimum < 1
  )
    throw new Error('Invalid retention limits')
  let total = points.reduce((n, p) => n + p.metadata.size, 0) + incoming
  const eligible = points.slice(0, Math.max(0, points.length - minimum))
  const prune: RetainedPoint[] = []
  for (const p of eligible) {
    if (total <= maxBytes) break
    total -= p.metadata.size
    prune.push(p)
  }
  if (total > maxBytes)
    throw new Error(
      'Storage limit conflicts with minimum retained restore points; protected backups were preserved',
    )
  return prune
}
export async function fileChecksum(path: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
export interface S3Destination {
  kind: 's3'
  endpoint: string
  region: string
  bucket: string
  prefix: string
  accessKey: string
  secretKey: string
}
export function signedS3Request(
  config: S3Destination,
  method: string,
  key: string,
  checksum: string,
  now = new Date(),
  extra: Record<string, string> = {},
) {
  const url = new URL(config.endpoint)
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      'S3 requires an HTTPS endpoint without embedded credentials',
    )
  const encoded = [config.bucket, ...key.split('/')]
    .map((p) =>
      encodeURIComponent(p).replace(
        /[!'()*]/g,
        (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
      ),
    )
    .join('/')
  url.pathname = url.pathname.replace(/\/$/, '') + '/' + encoded
  const date = now.toISOString().replace(/[:-]|\.\d{3}/g, ''),
    day = date.slice(0, 8)
  const headers: Record<string, string> = {
    host: url.host,
    'x-amz-content-sha256': checksum,
    'x-amz-date': date,
    ...extra,
  }
  const names = Object.keys(headers).sort()
  const canonical = [
    method,
    url.pathname,
    '',
    names.map((k) => `${k}:${headers[k as keyof typeof headers]}\n`).join(''),
    names.join(';'),
    checksum,
  ].join('\n')
  const scope = `${day}/${config.region}/s3/aws4_request`
  const toSign = `AWS4-HMAC-SHA256\n${date}\n${scope}\n${createHash('sha256').update(canonical).digest('hex')}`
  const hmac = (key: Buffer | string, data: string) =>
    createHmac('sha256', key).update(data).digest()
  const signing = hmac(
    hmac(hmac(hmac(`AWS4${config.secretKey}`, day), config.region), 's3'),
    'aws4_request',
  )
  return {
    url,
    headers: {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${hmac(signing, toSign).toString('hex')}`,
    },
  }
}
export async function s3Transfer(
  config: S3Destination,
  method: 'PUT' | 'GET' | 'DELETE' | 'HEAD',
  key: string,
  path: string | undefined,
  signal: AbortSignal,
  checksum?: string,
) {
  const payload =
    method === 'PUT'
      ? (checksum ?? (await fileChecksum(path!)))
      : createHash('sha256').update('').digest('hex')
  const signed = signedS3Request(
    config,
    method,
    key,
    payload,
    new Date(),
    method === 'PUT' ? { 'x-amz-meta-sha256': payload } : {},
  )
  const size = method === 'PUT' ? (await stat(path!)).size : undefined
  return await new Promise<import('node:http').IncomingHttpHeaders>(
    (resolve, reject) => {
      const req = request(
        signed.url,
        {
          method,
          headers: {
            ...signed.headers,
            ...(size === undefined ? {} : { 'content-length': size }),
          },
          signal,
          timeout: 30000,
        },
        (res) => {
          if (
            !res.statusCode ||
            res.statusCode < 200 ||
            res.statusCode >= 300
          ) {
            res.resume()
            reject(
              new Error(
                `S3 ${method} failed (${res.statusCode ?? 'unavailable'}); check endpoint and destination credentials`,
              ),
            )
            return
          }
          if (method === 'GET')
            pipeline(
              res,
              createWriteStream(path!, { flags: 'wx', mode: 0o600 }),
            ).then(() => resolve(res.headers), reject)
          else {
            res.resume()
            res.on('end', () => resolve(res.headers))
            res.on('error', reject)
          }
        },
      )
      req.on('timeout', () => req.destroy(new Error('S3 request timed out')))
      req.on('error', reject)
      if (method === 'PUT') pipeline(createReadStream(path!), req).catch(reject)
      else req.end()
    },
  ).catch(async (e) => {
    if (method === 'GET' && path) await rm(path, { force: true })
    throw e
  })
}
