/**
 * LE TABLEAU DE BORD TEXTE — la démo se vérifie sans Minecraft.
 * =============================================================
 * Objectif : voir en une seconde si le trafic est vivant, si les workers
 * suivent, si les échecs tombent — et si la mémoire dérive. Sans serveur
 * de jeu, sans navigateur, sans dépendance.
 *
 * Ce qu'il affiche vient de DEUX sources qu'on garde volontairement
 * séparées :
 *   · `in/s` est mesuré par le producteur (ce qu'on a inséré) ;
 *   · tout le reste vient de l'adapter, donc de la base, via le modèle
 *     pivot — exactement ce que le renderer envoie dans le monde.
 * Si ces deux colonnes divergent durablement, c'est un vrai signal, pas un
 * artefact d'affichage.
 */
import type { FailedJobDetail, QueueSnapshot } from '@queuecraft/core'
import { healthOf } from '@queuecraft/renderer'
import type { QueueTraffic } from './traffic.js'

export interface Frame {
  elapsedMs: number
  backend: string
  seed: number
  failRate: number
  snapshots: QueueSnapshot[]
  traffic: QueueTraffic[]
  failures: FailedJobDetail[]
  /** Ligne d'état du renderer Minecraft, ou `null` s'il n'est pas branché. */
  render: string | null
  log: readonly string[]
  memory: { rss: number; heapUsed: number; rssPeak: number }
}

const ESC = '\x1b['
const HOME = `${ESC}H`
const CLEAR_EOL = `${ESC}K`
const CLEAR_BELOW = `${ESC}J`
const HIDE_CURSOR = `${ESC}?25l`
const SHOW_CURSOR = `${ESC}?25h`

const BLOCKS = ' ▁▂▃▄▅▆▇█'
const MEGA = 1024 * 1024

/** Une ligne toutes les 5 s quand la sortie n'est pas un terminal (pipe, CI). */
const PLAIN_EVERY = 5

export class Dashboard {
  readonly #stream: NodeJS.WriteStream
  readonly #tty: boolean
  readonly #color: boolean
  readonly #history = new Map<string, number[]>()
  #frames = 0

  constructor(stream: NodeJS.WriteStream = process.stdout) {
    this.#stream = stream
    this.#tty = stream.isTTY === true
    this.#color = this.#tty && !process.env.NO_COLOR
    if (this.#tty) stream.write(HIDE_CURSOR)
  }

  render(frame: Frame): void {
    for (const queue of frame.traffic) {
      const history = this.#history.get(queue.name) ?? []
      history.push(queue.insertedPerSec)
      if (history.length > 120) history.shift()
      this.#history.set(queue.name, history)
    }

    if (!this.#tty) {
      if (this.#frames++ % PLAIN_EVERY === 0) this.#stream.write(`${this.#plain(frame)}\n`)
      return
    }
    const lines = this.#compose(frame)
    this.#stream.write(`${HOME}${lines.join(`${CLEAR_EOL}\n`)}${CLEAR_EOL}\n${CLEAR_BELOW}`)
    this.#frames++
  }

  close(): void {
    if (this.#tty) this.#stream.write(`${SHOW_CURSOR}\n`)
  }

  #compose(frame: Frame): string[] {
    // `||` et non `??` : un pty sans taille annonce 0 colonne, pas `undefined`.
    const width = this.#stream.columns || 100
    const spark = Math.max(12, Math.min(48, width - 74))

    const lines: string[] = ['']
    lines.push(
      `  ${this.#c('1', 'Queuecraft')} ${this.#c('2', '· trafic de démo ·')} ` +
        `${frame.backend} · FAIL_RATE ${(frame.failRate * 100).toFixed(0)} % · seed ${frame.seed}` +
        `${this.#c('2', `   t+${clock(frame.elapsedMs)}`)}`,
    )
    lines.push('')
    lines.push(
      this.#c(
        '2',
        `  ${'queue'.padEnd(10)}${head('in/s', 6)}${head('out/s', 7)}${head('waiting', 9)}` +
          `${head('active', 8)}${head('done', 9)}${head('failed', 8)}${head('crew', 6)}  ` +
          `vague — jobs/s injectés (${spark} s)`,
      ),
    )

    for (const queue of frame.traffic) {
      const snapshot = frame.snapshots.find((s) => s.name === queue.name)
      const counts = snapshot?.counts
      const health = healthOf(counts?.completed ?? 0, counts?.failed ?? 0)
      const out = snapshot?.throughputPerMin
      lines.push(
        `  ${this.#c(healthColor(health), queue.name.padEnd(10))}` +
          num(queue.insertedPerSec, 6, 1) +
          num(out === null || out === undefined ? null : out / 60, 7, 1) +
          num(counts?.waiting ?? null, 9) +
          num(counts?.active ?? null, 8) +
          num(counts?.completed ?? null, 9) +
          num(counts?.failed ?? null, 8) +
          num(snapshot?.workers ?? null, 6) +
          '  ' +
          this.#c(queue.bursting ? '33' : '36', this.#spark(queue.name, spark)) +
          (queue.bursting ? this.#c('33', ' burst') : ''),
      )
    }

    lines.push('')
    lines.push(this.#c('2', '  derniers échecs'))
    const failures = frame.failures.slice(0, 3)
    if (failures.length === 0) {
      lines.push(this.#c('2', '    (aucun pour l’instant)'))
    }
    for (const failure of failures) {
      lines.push(
        `    ${this.#c('31', failure.queue.padEnd(10))}` +
          `${this.#c('2', `${failure.jobId.slice(0, 8)}  `)}${cut(failure.error ?? '—', width - 26)}`,
      )
    }

    if (frame.log.length > 0) {
      lines.push('')
      lines.push(this.#c('2', '  journal'))
      for (const line of frame.log.slice(-3)) lines.push(`    ${this.#c('33', cut(line, width - 6))}`)
    }

    // Le rss de départ ne sert PAS de référence : PGlite réserve son arène
    // WASM au démarrage puis la rend, donc la dérive vue de t=0 est
    // négative et ne veut rien dire. On montre la valeur et son pic ; le
    // verdict de fuite se lit sur la seconde moitié du run (voir summary()).
    const { rss, heapUsed, rssPeak } = frame.memory
    lines.push('')
    lines.push(
      this.#c(
        '2',
        `  mémoire rss ${(rss / MEGA).toFixed(0)} Mo (pic ${(rssPeak / MEGA).toFixed(0)}) · ` +
          `heap ${(heapUsed / MEGA).toFixed(0)} Mo   ` +
          `insérés ${total(frame.traffic, 'inserted')} · réglés ${total(frame.traffic, 'settled')} · ` +
          `ratés ${total(frame.traffic, 'failed')}`,
      ),
    )
    lines.push(this.#c('2', `  ${frame.render ?? 'monde Minecraft non branché (--render pour le brancher)'}`))
    lines.push(this.#c('2', '  Ctrl-C pour arrêter'))
    return lines
  }

  /** Sortie non-TTY : une ligne par échantillon, greppable. */
  #plain(frame: Frame): string {
    const queues = frame.traffic
      .map((queue) => {
        const counts = frame.snapshots.find((s) => s.name === queue.name)?.counts
        return (
          `${queue.name} in=${queue.insertedPerSec.toFixed(1)}/s w=${counts?.waiting ?? '?'} ` +
          `a=${counts?.active ?? '?'} done=${counts?.completed ?? '?'} fail=${counts?.failed ?? '?'}`
        )
      })
      .join(' | ')
    return (
      `t+${clock(frame.elapsedMs)} ${queues} | rss=${(frame.memory.rss / MEGA).toFixed(0)}Mo` +
      (frame.render ? ` | ${frame.render}` : '')
    )
  }

  #spark(queue: string, width: number): string {
    const history = (this.#history.get(queue) ?? []).slice(-width)
    const max = Math.max(1, ...history)
    return history
      .map((value) => BLOCKS[Math.min(8, Math.max(0, Math.round((value / max) * 8)))] ?? ' ')
      .join('')
      .padStart(width)
  }

  #c(code: string, text: string): string {
    return this.#color ? `${ESC}${code}m${text}${ESC}0m` : text
  }
}

function healthColor(health: 'healthy' | 'degraded' | 'critical'): string {
  return health === 'healthy' ? '32' : health === 'degraded' ? '33' : '31'
}

function head(label: string, width: number): string {
  return label.padStart(width)
}

/** Une valeur inconnue s'affiche « — » : on ne fait jamais passer null pour 0. */
function num(value: number | null, width: number, decimals = 0): string {
  if (value === null) return '—'.padStart(width)
  return value.toFixed(decimals).padStart(width)
}

function total(traffic: readonly QueueTraffic[], key: 'inserted' | 'settled' | 'failed'): number {
  return traffic.reduce((sum, queue) => sum + queue[key], 0)
}

function clock(ms: number): string {
  const seconds = Math.floor(ms / 1_000)
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

function cut(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ')
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(1, max - 1))}…`
}
