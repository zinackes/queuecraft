/**
 * DIAGNOSTIC : à partir de combien de commandes "en vol" la connexion RCON casse-t-elle ?
 *
 * Le scénario B du benchmark (pipeliné ×8) fait fermer la connexion par le
 * serveur. Ce script cherche le seuil exact : il tente 1, 2, 3, 4, 8, 16
 * commandes en vol sur une connexion neuve à chaque fois, et note ce qui
 * survit. Jetable — sert uniquement à documenter la limite dans l'ADR.
 *
 * Lancement :  pnpm tsx src/pending-sweep.ts
 */
import { Rcon } from 'rcon-client'

const HOST = process.env.RCON_HOST ?? '127.0.0.1'
const PORT = Number(process.env.RCON_PORT ?? 25575)
const PASSWORD = process.env.RCON_PASSWORD ?? 'queuecraft-spike'
const Y = -59

async function tryPending(pending: number): Promise<string> {
  let rcon: Rcon | undefined
  try {
    rcon = await Rcon.connect({ host: HOST, port: PORT, password: PASSWORD, maxPending: pending, timeout: 8_000 })
    // Quand le serveur coupe la connexion, l'ecriture suivante emet un
    // 'error' ASYNCHRONE (EPIPE) que le try/catch ne voit pas : sans ce
    // listener, Node tue le process au lieu de nous laisser noter l'echec.
    rcon.on('error', () => {})
    const start = performance.now()
    // Une seule vague de `pending` commandes lancées sans attendre.
    const wave = Array.from({ length: pending }, (_, j) =>
      rcon!.send(`setblock ${j} ${Y} 4 minecraft:lime_concrete`),
    )
    const results = await Promise.all(wave)
    const ms = performance.now() - start
    const empty = results.filter((r) => r.length === 0).length
    return `OK   — ${pending} en vol en ${ms.toFixed(0)} ms (${empty}/${pending} réponses vides)`
  } catch (err) {
    return `CASSE — ${(err as Error)?.message ?? err}`
  } finally {
    await rcon?.end().catch(() => {})
  }
}

async function main() {
  console.log(`\nDiagnostic : seuil de pipelining RCON  →  ${HOST}:${PORT}\n`)
  for (const pending of [1, 2, 3, 4, 8, 16]) {
    console.log(`  maxPending=${String(pending).padStart(2)} : ${await tryPending(pending)}`)
  }
  console.log()
}

main().catch((err) => {
  console.error('Échec du diagnostic :', (err as Error)?.message ?? err)
  process.exit(1)
})
