import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { migrateGit } from './migrations-git.js'

test(
  'v30 upgrades existing saved credentials without widening access or losing cross-project bindings',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    })
    const db = await pool.connect()
    const schema = `git_upgrade_${randomUUID().replaceAll('-', '')}`
    const shared = randomUUID(),
      personal = randomUUID(),
      registry = randomUUID(),
      owner = randomUUID()
    try {
      await db.query(`CREATE SCHEMA ${schema}`)
      await db.query(`SET search_path TO ${schema}`)
      // Model the existing v29 foreign keys and data, rather than a fresh v30 database.
      await db.query(`
      CREATE TABLE migrations(version integer PRIMARY KEY);
      INSERT INTO migrations VALUES(20),(24),(26),(28),(29);
      CREATE TABLE users(id uuid PRIMARY KEY);
      CREATE TABLE projects(slug text PRIMARY KEY);
      CREATE TABLE services(project_slug text REFERENCES projects ON DELETE CASCADE,slug text,PRIMARY KEY(project_slug,slug));
      CREATE TABLE git_connections(id uuid PRIMARY KEY,project text NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,owner uuid REFERENCES users,project_access boolean NOT NULL DEFAULT false,CHECK(NOT project_access OR owner IS NULL));
      CREATE TABLE registry_connections(id uuid PRIMARY KEY,project text NOT NULL REFERENCES projects(slug) ON DELETE CASCADE);
      CREATE TABLE github_app_setups(state text PRIMARY KEY,project_access boolean NOT NULL DEFAULT false);
      CREATE TABLE git_repository_bindings(connection uuid REFERENCES git_connections ON DELETE CASCADE,project text,service text,repository_id text,FOREIGN KEY(project,service) REFERENCES services(project_slug,slug) ON DELETE CASCADE);
      CREATE TABLE registry_bindings(connection uuid REFERENCES registry_connections ON DELETE CASCADE,project text,service text,FOREIGN KEY(project,service) REFERENCES services(project_slug,slug) ON DELETE CASCADE);
      INSERT INTO projects VALUES('home'),('consumer');
      INSERT INTO services VALUES('home','web'),('consumer','web');
      INSERT INTO github_app_setups VALUES('pending',true);
    `)
      await db.query('INSERT INTO users VALUES($1)', [owner])
      await db.query(
        "INSERT INTO git_connections VALUES($1,'home',NULL,true),($2,'home',$3,false)",
        [shared, personal, owner],
      )
      await db.query("INSERT INTO registry_connections VALUES($1,'home')", [
        registry,
      ])
      await db.query(
        "INSERT INTO git_repository_bindings VALUES($1,'consumer','web','991')",
        [shared],
      )
      await db.query(
        "INSERT INTO registry_bindings VALUES($1,'consumer','web')",
        [registry],
      )
      await migrateGit(db)
      await migrateGit(db)
      assert.deepEqual(
        (
          await db.query(
            'SELECT connection,project FROM git_connection_projects',
          )
        ).rows,
        [{ connection: shared, project: 'home' }],
      )
      assert.equal(
        (
          await db.query(
            'SELECT count(*)::int AS count FROM git_connections WHERE all_projects',
          )
        ).rows[0].count,
        0,
      )
      assert.deepEqual(
        (
          await db.query(
            'SELECT project_access,all_projects,available_projects FROM github_app_setups',
          )
        ).rows,
        [
          {
            project_access: true,
            all_projects: false,
            available_projects: null,
          },
        ],
      )
      await assert.rejects(
        db.query('UPDATE git_connections SET all_projects=true WHERE id=$1', [
          personal,
        ]),
        (error: unknown) => (error as { code?: string }).code === '23514',
      )
      await db.query("DELETE FROM projects WHERE slug='home'")
      assert.equal(
        (
          await db.query(
            'SELECT count(*)::int AS count FROM git_connections WHERE project IS NULL',
          )
        ).rows[0].count,
        2,
      )
      assert.equal(
        (
          await db.query(
            'SELECT project FROM registry_connections WHERE id=$1',
            [registry],
          )
        ).rows[0].project,
        null,
      )
      assert.equal(
        (
          await db.query(
            'SELECT count(*)::int AS count FROM git_connection_projects',
          )
        ).rows[0].count,
        0,
      )
      assert.equal(
        (
          await db.query(
            'SELECT count(*)::int AS count FROM git_repository_bindings',
          )
        ).rows[0].count,
        1,
      )
      assert.equal(
        (await db.query('SELECT count(*)::int AS count FROM registry_bindings'))
          .rows[0].count,
        1,
      )
    } finally {
      await db.query('SET search_path TO public')
      await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
      db.release()
      await pool.end()
    }
  },
)
