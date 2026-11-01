import nodemailer from 'nodemailer'
import { smtpAvailable } from './auth-factors.js'
export async function sendInvitation(
  email: string,
  url: string,
): Promise<boolean> {
  if (!smtpAvailable()) return false
  const tls = process.env.SMTP_TLS ?? 'starttls'
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? (tls === 'implicit' ? 465 : 587)),
    secure: tls === 'implicit',
    requireTLS: tls === 'starttls',
    ignoreTLS: tls === 'plain',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
      : undefined,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    disableFileAccess: true,
    disableUrlAccess: true,
  })
  try {
    await transport.sendMail({
      from: process.env.SMTP_FROM,
      to: email,
      subject: 'Your Kloud organization invitation',
      text: `You have been invited to a Kloud organization. Open this link to accept using your account: ${url}\nThis invitation expires in 24 hours. If you did not expect this invitation, you can ignore it.`,
    })
    return true
  } catch {
    return false
  } finally {
    transport.close()
  }
}
