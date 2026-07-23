/**
 * CONTRÔLE DE VÉRITÉ : les commandes mesurées sont-elles vraiment exécutées ?
 *
 * Le benchmark annonce des débits à 4 chiffres (2500+ cmd/s sur une seule
 * connexion). Avant de les consigner dans un ADR, il faut écarter l'hypothèse
 * "le serveur accuse réception sans rien faire". On pose N blocs, puis on
 * relit le monde bloc par bloc pour compter ceux qui existent réellement.
 *
 * Lancement :  pnpm tsx src/verify-effects.ts
 */
import { Rcon } from 'rcon-client'

const HOST = process.env.RCON_HOST ?? '127.0.0.1'
const PORT = Number(process.env.RCON_PORT ?? 25575)
const PASSWORD = process.env.RCON_PASSWORD ?? 'queuecraft-spike'
const Y = -55
const Z = 8
const N = 300

async function main() {
  const rcon = await Rcon.connect({ host: HOST, port: PORT, password: PASSWORD, maxPending: 1, timeout: 15_000 })
  rcon.on('error', () => {}) // ADR-002 : sans ce listener, un EPIPE async tue le process.
  try {
    await rcon.send('forceload add 0 0 511 15')
    await rcon.send(`fill 0 ${Y} ${Z} ${N - 1} ${Y} ${Z} minecraft:air`)

    // Phase 1 : poser N blocs le plus vite possible, comme le benchmark.
    const start = performance.now()
    for (let i = 0; i < N; i++) {
      await rcon.send(`setblock ${i} ${Y} ${Z} minecraft:lime_concrete`)
    }
    const totalS = (performance.now() - start) / 1000
    const claimed = N / totalS

    // Phase 2 : relire le monde. `execute if block` SANS `run` renvoie
    // "Test passed" ou "Test failed" — c'est notre vérité terrain.
    // (Ne pas enchaîner sur `data get block` : ça exige une block entity,
    // que le béton n'a pas, donc ça échoue même quand le bloc est là.)
    let present = 0
    let sample = ''
    for (let i = 0; i < N; i++) {
      const res = await rcon.send(`execute if block ${i} ${Y} ${Z} minecraft:lime_concrete`)
      if (i === 0) sample = res
      if (/passed/i.test(res)) present++
    }
    console.log(`\nRéponse type du sondage : ${JSON.stringify(sample)}`)

    console.log(`\nDébit annoncé par la même boucle : ${claimed.toFixed(0)} cmd/s`)
    console.log(`Blocs réellement présents        : ${present}/${N}`)
    console.log(
      present === N
        ? '→ Les commandes sont bien exécutées. Le débit mesuré est réel.\n'
        : `→ ALERTE : ${N - present} commandes perdues. Le débit mesuré est un mensonge.\n`,
    )
  } finally {
    await rcon.end()
  }
}

main().catch((err) => {
  console.error('Échec du contrôle :', (err as Error)?.message ?? err)
  process.exit(1)
})
