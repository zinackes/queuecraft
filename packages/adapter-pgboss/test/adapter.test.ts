/**
 * L'adapter contre un vrai pg-boss — PGlite in-process, zéro infra.
 * =================================================================
 * PGlite est un Postgres complet compilé en WASM ; pg-boss v12 le prend en
 * charge officiellement (`fromPglite` + `backend: 'pglite'`). On y sème deux
 * queues, on en fait échouer une partie, et on compare CHAQUE compteur du
 * modèle pivot à la vérité SQL lue directement dans la table des jobs.
 *
 * `emails` est partitionnée et `scraping` non : les deux queues vivent donc
 * dans DEUX tables différentes, ce qui exerce la lecture des échecs table
 * par table plutôt que le cas trivial d'une table commune.
 *
 * Les compteurs de `getQueues()` sont rafraîchis par le moniteur pg-boss
 * (ici toutes les secondes), donc l'adapter est en retard de <= 1 s sur la
 * base : les assertions attendent la convergence plutôt que de figer un
 * instant — c'est justement le comportement qu'on veut vérifier.
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { PgBoss, fromPglite } from 'pg-boss'
import type { QueueSnapshot } from '@queuecraft/core'
import { PgBossAdapter } from '../src/index.js'

const SCHEMA = 'pgboss'
const IMMEDIATE = 12
const DEFERRED = 4
const BACKLOG = 8
/** Un job sur trois échoue : de quoi remplir le cimetière. */
const FAILS_EVERY = 3
const EXPECTED_FAILED = Math.ceil(IMMEDIATE / FAILS_EVERY)
const HUGE_ERROR = 'x'.repeat(500)

interface Truth {
  waiting: number
  active: number
  completed: number
  failed: number
  delayed: number
}

async function makeBoss(): Promise<{ pglite: PGlite; boss: PgBoss }> {
  const pglite = await PGlite.create()
  const boss = new PgBoss({
    db: fromPglite(pglite),
    backend: 'pglite',
    schema: SCHEMA,
    supervise: true,
    monitorIntervalSeconds: 1,
    superviseIntervalSeconds: 1,
  })
  boss.on('error', () => {}) // sinon une erreur de fond tue le process
  await boss.start()
  return { pglite, boss }
}

/** La vérité : un GROUP BY sur les jobs, sans passer par pg-boss. */
async function sqlTruth(pglite: PGlite, queue: string): Promise<Truth> {
  const { rows } = await pglite.query<Truth>(
    `SELECT
       count(*) FILTER (WHERE state < 'active' AND start_after <= now())::int AS waiting,
       count(*) FILTER (WHERE state = 'active')::int                          AS active,
       count(*) FILTER (WHERE state IN ('completed','cancelled'))::int        AS completed,
       count(*) FILTER (WHERE state = 'failed')::int                          AS failed,
       count(*) FILTER (WHERE state < 'active' AND start_after > now())::int  AS delayed
     FROM ${SCHEMA}.job WHERE name = $1`,
    [queue],
  )
  const truth = rows[0]
  assert.ok(truth, `pas de ligne pour la queue ${queue}`)
  return truth
}

function countsOf(snapshots: QueueSnapshot[], queue: string): Truth {
  const snapshot = snapshots.find((s) => s.name === queue)
  assert.ok(snapshot, `queue ${queue} absente du snapshot`)
  return {
    waiting: snapshot.counts.waiting,
    active: snapshot.counts.active,
    completed: snapshot.counts.completed,
    failed: snapshot.counts.failed,
    delayed: snapshot.counts.delayed,
  }
}

/** Attend que `check()` passe sans exception, sinon relance la dernière. */
async function converges(check: () => Promise<void>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  while (Date.now() < deadline) {
    try {
      await check()
      return
    } catch (error) {
      last = error
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  throw last
}

describe('PgBossAdapter contre pg-boss + PGlite', () => {
  let pglite: PGlite
  let boss: PgBoss
  let adapter: PgBossAdapter

  before(async () => {
    ;({ pglite, boss } = await makeBoss())

    // retryLimit 0 : un échec est définitif, donc le décompte est certain.
    await boss.createQueue('emails', { partition: true, retryLimit: 0 })
    await boss.createQueue('scraping', { retryLimit: 0 })

    for (let i = 0; i < IMMEDIATE; i++) await boss.send('emails', { i })
    for (let i = 0; i < DEFERRED; i++) await boss.sendAfter('emails', { i }, null, 3_600)
    // scraping : un backlog que personne ne consomme encore.
    for (let i = 0; i < BACKLOG; i++) await boss.send('scraping', { i })

    // `perJobResults` règle chaque job du lot individuellement : un lot ne
    // sombre pas en entier parce qu'un seul job a échoué.
    await boss.work<{ i: number }>(
      'emails',
      { batchSize: IMMEDIATE, pollingIntervalSeconds: 1, perJobResults: true },
      async (jobs) =>
        jobs.map((job) =>
          job.data.i % FAILS_EVERY === 0
            ? {
                id: job.id,
                status: 'failed' as const,
                output: { message: `boom ${job.data.i} ${HUGE_ERROR}` },
              }
            : { id: job.id, status: 'completed' as const },
        ),
    )

    // Le scénario doit être JOUÉ avant qu'on observe : sinon on vérifierait
    // que deux zéros sont égaux.
    await converges(async () => {
      const truth = await sqlTruth(pglite, 'emails')
      assert.equal(truth.failed, EXPECTED_FAILED)
      assert.equal(truth.completed, IMMEDIATE - EXPECTED_FAILED)
    })
    await boss.offWork('emails')

    adapter = new PgBossAdapter({ boss, schema: SCHEMA, refreshMs: 250 })
    await adapter.start()
  })

  after(async () => {
    await adapter.stop()
    await boss.stop({ graceful: false })
    await pglite.close()
  })

  it('expose les deux queues, sans les queues internes de pg-boss', async () => {
    const snapshots = await adapter.snapshot()
    assert.deepEqual(
      snapshots.map((s) => s.name),
      ['emails', 'scraping'],
    )
    // Le postulat du fichier : deux tables distinctes, donc la lecture des
    // échecs doit vraiment interroger plusieurs tables.
    const tables = (await boss.getQueues(['emails', 'scraping'])).map((q) => q.table)
    assert.equal(new Set(tables).size, 2, `tables non distinctes : ${tables.join(', ')}`)
  })

  it('converge vers les compteurs réels des deux queues', async () => {
    await converges(async () => {
      const snapshots = await adapter.snapshot()
      for (const queue of ['emails', 'scraping']) {
        assert.deepEqual(countsOf(snapshots, queue), await sqlTruth(pglite, queue), queue)
      }
    })

    const emails = countsOf(await adapter.snapshot(), 'emails')
    assert.equal(emails.failed, EXPECTED_FAILED)
    assert.equal(emails.completed, IMMEDIATE - EXPECTED_FAILED)
    assert.equal(emails.delayed, DEFERRED)
    assert.equal(emails.waiting, 0)
    assert.equal(countsOf(await adapter.snapshot(), 'scraping').waiting, BACKLOG)
  })

  it('ne compte jamais un job différé deux fois', async () => {
    const { rows } = await pglite.query<{ queued: number }>(
      `SELECT count(*) FILTER (WHERE state < 'active')::int AS queued
         FROM ${SCHEMA}.job WHERE name = 'emails'`,
    )
    const counts = countsOf(await adapter.snapshot(), 'emails')
    assert.equal(counts.waiting + counts.delayed, rows[0]?.queued)
  })

  it('rend un snapshot en moins de 50 ms', async () => {
    const started = process.hrtime.bigint()
    for (let i = 0; i < 100; i++) await adapter.snapshot()
    const perCall = Number(process.hrtime.bigint() - started) / 1e6 / 100
    assert.ok(perCall < 50, `snapshot() a pris ${perCall.toFixed(3)} ms`)
    console.log(`      snapshot() : ${perCall.toFixed(3)} ms / appel`)
  })

  it('remonte les échecs réels, message tronqué à 200 caractères', async () => {
    const failures = await adapter.recentFailures(50)
    const { rows } = await pglite.query<{ id: string }>(
      `SELECT id FROM ${SCHEMA}.job WHERE name = 'emails' AND state = 'failed'`,
    )
    assert.equal(rows.length, EXPECTED_FAILED)
    assert.deepEqual(
      failures.map((f) => f.jobId).sort(),
      rows.map((r) => r.id).sort(),
    )
    for (const failure of failures) {
      assert.equal(failure.queue, 'emails')
      assert.ok(failure.error !== null, 'message d’erreur perdu')
      assert.ok(failure.error.length <= 200, `erreur non tronquée (${failure.error.length})`)
      assert.ok(failure.error.startsWith('boom '))
      assert.ok(failure.failedAt instanceof Date)
    }
  })

  it('respecte la limite demandée par le renderer', async () => {
    assert.equal((await adapter.recentFailures(2)).length, 2)
    assert.equal((await adapter.recentFailures(0)).length, 0)
  })

  it('mesure un débit pendant que la queue se vide', async () => {
    await boss.work('scraping', { batchSize: BACKLOG, pollingIntervalSeconds: 1 }, async () => {})

    await converges(async () => {
      const scraping = (await adapter.snapshot()).find((s) => s.name === 'scraping')
      assert.equal(scraping?.counts.waiting, 0)
      assert.ok(
        (scraping?.throughputPerMin ?? 0) > 0,
        `débit attendu > 0, obtenu ${scraping?.throughputPerMin}`,
      )
    })
    await boss.offWork('scraping')
  })

  it('compte les workers locaux, et distingue « aucun » de « inconnu »', async () => {
    // Plus aucun worker dans ce processus : l'adapter ne peut rien affirmer.
    await converges(async () => {
      for (const snapshot of await adapter.snapshot()) {
        assert.equal(snapshot.workers, null, snapshot.name)
      }
    })

    await boss.work('scraping', { pollingIntervalSeconds: 60 }, async () => {})
    await converges(async () => {
      const snapshots = await adapter.snapshot()
      assert.equal(snapshots.find((s) => s.name === 'scraping')?.workers, 1)
      assert.equal(snapshots.find((s) => s.name === 'emails')?.workers, 0)
    })
    await boss.offWork('scraping')
  })
})

describe('événements', () => {
  it('signale les nouveaux échecs, jamais l’historique déjà là', async () => {
    const { pglite, boss } = await makeBoss()
    await boss.createQueue('emails', { retryLimit: 0 })
    await boss.send('emails', { i: 0 })
    const first = await boss.fetch('emails')
    await boss.fail('emails', first.map((j) => j.id) as string[], { message: 'échec initial' })

    const adapter = new PgBossAdapter({ boss, schema: SCHEMA, refreshMs: 100 })
    const events: QueueEventLike[] = []
    const off = adapter.onEvent((event) => events.push(event))
    await adapter.start()

    // L'échec présent AVANT le démarrage ne doit rien émettre.
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(events.length, 0)

    await boss.send('emails', { i: 1 })
    const next = await boss.fetch('emails')
    await boss.fail('emails', next.map((j) => j.id) as string[], { message: 'échec observé' })

    await converges(async () => {
      assert.equal(events.length, 1)
    }, 5_000)
    assert.equal(events[0]?.type, 'job_failed')
    assert.equal(events[0]?.error, 'échec observé')

    off()
    await adapter.stop()
    await boss.stop({ graceful: false })
    await pglite.close()
  })
})

describe('résilience réseau', () => {
  it('sert le dernier snapshot connu quand la base tombe', async () => {
    const { pglite, boss } = await makeBoss()
    await boss.createQueue('emails')
    for (let i = 0; i < 5; i++) await boss.send('emails', { i })

    const errors: Error[] = []
    const adapter = new PgBossAdapter({
      boss,
      schema: SCHEMA,
      refreshMs: 100,
      onError: (error) => errors.push(error),
    })
    await adapter.start()

    await converges(async () => {
      assert.equal((await adapter.snapshot())[0]?.counts.waiting, 5)
    })
    const before = (await adapter.snapshot())[0]

    // La base disparaît sous l'adapter.
    await boss.stop({ graceful: false })
    await pglite.close()
    await new Promise((resolve) => setTimeout(resolve, 600))

    const after = (await adapter.snapshot())[0]
    assert.ok(errors.length > 0, 'aucune erreur signalée')
    assert.equal(after?.counts.waiting, 5)
    assert.equal(after?.capturedAt.getTime(), before?.capturedAt.getTime())
    await adapter.stop()
  })
})

interface QueueEventLike {
  type: string
  error?: string | null
}
