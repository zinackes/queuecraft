/**
 * SONDE DE COMPATIBILITÉ (ADR D4) — à lancer sur les DEUX cibles.
 * ==============================================================
 * Le renderer repose sur une poignée de détails NBT qui ont bougé
 * récemment (1.21.5 a réécrit le SNBT et le stockage des composants
 * de texte). Les deux cibles de D4 — Paper 1.21.11 et 26.2 — sont
 * postérieures à ce changement, donc UNE syntaxe devrait couvrir les
 * deux. « Devrait » n'est pas une preuve : ce script la demande au
 * serveur avant qu'on écrive une ligne de rendu par-dessus.
 *
 * Chaque sonde est indépendante : un échec est noté, pas fatal.
 *
 * Lancement :  pnpm probe            (serveur du spike démarré)
 *              MC_VERSION=26.2 ...   (voir spikes/rcon-benchmark/README.md)
 */
import { Rcon } from 'rcon-client'

const HOST = process.env.RCON_HOST ?? '127.0.0.1'
const PORT = Number(process.env.RCON_PORT ?? 25575)
const PASSWORD = process.env.RCON_PASSWORD ?? 'queuecraft-spike'

// Zone de sonde : à l'écart de la gare (qui vit autour de x=0..64).
const X = -200
const Y = -59
const Z = -200

type Probe = { name: string; ok: boolean; detail: string }

async function main() {
  const rcon = await Rcon.connect({
    host: HOST,
    port: PORT,
    password: PASSWORD,
    maxPending: 1, // ADR-002 §3 : jamais plus d'une commande en vol.
    timeout: 15_000,
  })
  // Sans ce listener, un EPIPE asynchrone tue le process (ADR-002).
  rcon.on('error', () => {})

  const results: Probe[] = []
  const send = (cmd: string) => rcon.send(cmd)

  /** Une sonde = une commande + un verdict lu dans la réponse du serveur. */
  async function probe(name: string, cmd: string, ok: (reply: string) => boolean) {
    try {
      const reply = await send(cmd)
      results.push({ name, ok: ok(reply), detail: reply.trim().slice(0, 160) })
    } catch (err) {
      results.push({ name, ok: false, detail: `EXCEPTION ${(err as Error)?.message ?? err}` })
    }
  }

  // Un serveur ne parle pas d'erreur en HTTP : il répond en texte. Une commande
  // refusée commence par "Unknown or incomplete", "Expected", "Invalid"...
  const accepted = (reply: string) =>
    reply.length > 0 &&
    !/^unknown|^expected|^invalid|incorrect argument|failed to|no entity was found|error/i.test(reply.trim())

  try {
    const version = await send('version').catch(() => '(inconnue)')
    console.log(`\nSonde de compatibilité Queuecraft  →  ${HOST}:${PORT}`)
    console.log(`Serveur : ${version.trim().slice(0, 90)}\n`)

    await send(`forceload add ${X} ${Z} ${X + 16} ${Z + 16}`)
    await send(`kill @e[tag=qc-probe]`)

    // ---- 1. text_display : composant de texte stocké en NBT (forme 1.21.5+)
    await probe(
      'summon text_display, text NBT nu           {text:"..."}',
      `summon minecraft:text_display ${X} ${Y + 2} ${Z} {Tags:["qc-probe","qc-probe-plain"],billboard:"center",text:"queuecraft"}`,
      accepted,
    )

    // ---- 2. La forme ANCIENNE (chaîne JSON) : doit échouer sur ≥1.21.5.
    //         Si elle passe, c'est qu'on vise un serveur plus vieux que prévu.
    await probe(
      'summon text_display, ancienne forme JSON   {text:\'{"text":"..."}\'}',
      `summon minecraft:text_display ${X + 1} ${Y + 2} ${Z} {Tags:["qc-probe"],text:'{"text":"legacy"}'}`,
      accepted,
    )

    // ---- 3. Composant riche : couleur + gras (ce qu'on veut pour le panneau).
    await probe(
      'summon text_display, composant riche       {text:{text:"..",color:"gold"}}',
      `summon minecraft:text_display ${X + 2} ${Y + 2} ${Z} {Tags:["qc-probe","qc-probe-rich"],billboard:"center",alignment:"center",see_through:false,text:{text:"12.4k",color:"gold",bold:true},background:1073741824,line_width:400}`,
      accepted,
    )

    // ---- 4. Retour à la ligne : \n dans une chaîne SNBT.
    //         S'il n'est pas supporté, il faudra un text_display PAR LIGNE
    //         (donc 3 commandes par tick au lieu d'une pour le panneau).
    //         Un summon accepté ne suffit pas : on relit pour voir si le
    //         serveur a stocké un VRAI saut de ligne ou les deux caractères.
    await probe(
      'summon text_display, multi-ligne "a\\nb"    (échappement SNBT)',
      `summon minecraft:text_display ${X + 3} ${Y + 2} ${Z} {Tags:["qc-probe","qc-probe-nl"],billboard:"center",text:"ligne1\\nligne2"}`,
      accepted,
    )
    await probe(
      'data get entity text multi-ligne (vrai saut de ligne ?)',
      `data get entity @e[tag=qc-probe-nl,limit=1] text`,
      (r) => r.includes('\n') || r.includes('\\n'),
    )

    // ---- 5. LA commande du régime établi : mise à jour du texte.
    await probe(
      'data merge entity (mise à jour du texte)',
      `data merge entity @e[tag=qc-probe-plain,limit=1] {text:{text:"84 waiting",color:"aqua"}}`,
      accepted,
    )

    // ---- 6. Relecture : la mutation a-t-elle vraiment pris ?
    await probe(
      'data get entity text (vérité terrain)',
      `data get entity @e[tag=qc-probe-plain,limit=1] text`,
      (r) => /84 waiting/.test(r),
    )

    // ---- 7. Champs d'interpolation (snake_case depuis 1.21.5).
    await probe(
      'interpolation_duration / start_interpolation',
      `data merge entity @e[tag=qc-probe-rich,limit=1] {interpolation_duration:6,start_interpolation:0,transformation:{left_rotation:[0f,0f,0f,1f],right_rotation:[0f,0f,0f,1f],translation:[0f,0f,0f],scale:[1.4f,1.4f,1.4f]}}`,
      accepted,
    )

    // ---- 8. Minecart sans gravité (le backlog). NoGravity = zéro physique.
    await probe(
      'summon minecart {NoGravity:1b}',
      `summon minecraft:minecart ${X + 5} ${Y + 1} ${Z} {Tags:["qc-probe","qc-probe-cart"],NoGravity:1b}`,
      accepted,
    )

    // ---- 9. Déplacement d'un cart : c'est ce qui remplace summon/kill au tick.
    await probe(
      'tp du minecart (déplacement d\'emplacement)',
      `tp @e[tag=qc-probe-cart,limit=1] ${X + 5} ${Y + 1} ${Z + 3}`,
      accepted,
    )

    // ---- 10. Villager statique (les workers).
    await probe(
      'summon villager {NoAI,NoGravity,Invulnerable,Silent}',
      `summon minecraft:villager ${X + 7} ${Y + 1} ${Z} {Tags:["qc-probe","qc-probe-villager"],Rotation:[90f,0f],NoAI:1b,NoGravity:1b,Invulnerable:1b,Silent:1b,PersistenceRequired:1b,VillagerData:{profession:"minecraft:librarian",level:1,type:"minecraft:plains"}}`,
      accepted,
    )

    // ---- 11. Sélecteur de comptage : sert à la vérification sans joueur.
    await probe(
      'execute if entity (contrôle sans joueur)',
      `execute if entity @e[tag=qc-probe-cart,limit=1]`,
      (r) => /passed/i.test(r),
    )

    // ---- 12. time : la seule commande d'ambiance que le renderer émet.
    await probe('time set noon (ambiance de démo)', 'time set noon', accepted)

    // ---- 13. gamerule : dans la liste blanche du skill, mais REFUSÉ par
    //          Paper 1.21.11-132 quel que soit le nom de règle. La sonde le
    //          garde sous surveillance : si une cible l'accepte un jour, on
    //          le saura ici et pas en production.
    await probe('gamerule (attendu : ÉCHEC sur Paper 1.21.11)', 'gamerule doDaylightCycle false', accepted)

    // ---- 14. fill : une commande pour des centaines de blocs (la vraie optim).
    await probe(
      'fill (quai / rails)',
      `fill ${X} ${Y} ${Z} ${X + 15} ${Y} ${Z + 5} minecraft:smooth_stone`,
      accepted,
    )

    // Ménage : la sonde ne laisse rien derrière elle.
    await send('kill @e[tag=qc-probe]')
    await send(`fill ${X} ${Y} ${Z} ${X + 15} ${Y + 2} ${Z + 5} minecraft:air`)
    await send(`forceload remove ${X} ${Z} ${X + 16} ${Z + 16}`)
  } finally {
    await rcon.end().catch(() => {})
  }

  console.log('Résultats\n─────────')
  for (const r of results) {
    console.log(`  ${r.ok ? 'OK   ' : 'ÉCHEC'} │ ${r.name}`)
    if (!r.ok || r.detail) console.log(`        │   ${r.detail || '(réponse vide)'}`)
  }

  // Deux sondes ont le droit d'échouer : la forme JSON obsolète et
  // `gamerule`, qu'aucune commande du renderer n'utilise.
  const tolerated = /ancienne forme|gamerule/
  const failures = results.filter((r) => !r.ok && !tolerated.test(r.name))
  console.log(
    `\n${failures.length === 0
      ? 'Toutes les sondes utiles passent : la syntaxe du renderer est valide sur ce serveur.'
      : `${failures.length} sonde(s) en échec — corriger commands.ts AVANT d'aller plus loin.`}\n`,
  )
  process.exitCode = failures.length === 0 ? 0 : 1
}

main().catch((err) => {
  console.error('\nÉchec de la sonde :', (err as Error)?.message ?? err)
  console.error('Le serveur est-il démarré ?  →  cd spikes/rcon-benchmark && docker compose up -d')
  process.exit(1)
})
