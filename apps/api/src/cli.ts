import { randomUUID } from 'node:crypto'
import { pool, transaction } from './db.js'
import { token, digest, publicOrigin } from './security.js'
import { clearFactors } from './auth-factors.js'
const [command, username] = process.argv.slice(2)
try {
  if (
    !['bootstrap', 'recover'].includes(command ?? '') ||
    !username ||
    !/^[a-zA-Z0-9_.@-]{1,100}$/.test(username)
  )
    throw new Error('Usage: cli bootstrap|recover <username>')
  const invitation = token()
  await transaction(async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(842192)')
    let id: string
    if (command === 'bootstrap') {
      if ((await db.query('SELECT 1 FROM users WHERE admin')).rowCount)
        throw new Error('A Server Administrator already exists; use recover')
      id = randomUUID()
      await db.query(
        'INSERT INTO users(id,username,admin) VALUES($1,$2,true)',
        [id, username.toLowerCase()],
      )
    } else {
      const user = (
        await db.query('SELECT id FROM users WHERE username=$1 FOR UPDATE', [
          username.toLowerCase(),
        ])
      ).rows[0]
      if (!user) throw new Error('User does not exist')
      id = user.id
      await db.query(
        'UPDATE users SET disabled=false,password_hash=NULL WHERE id=$1',
        [id],
      )
      await clearFactors(db, id)
    }
    await db.query(
      `INSERT INTO invitations(token,user_id,expires) VALUES($1,$2,now()+interval '24 hours')`,
      [digest(invitation), id],
    )
  })
  console.log(`${publicOrigin}/enroll#${invitation}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Command failed')
  process.exitCode = 1
} finally {
  await pool.end()
}
