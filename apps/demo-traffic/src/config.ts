/**
 * LE PROFIL DE TRAFIC — module pur, zéro I/O.
 * ===========================================
 * Ce fichier décrit une « journée de production » : combien de jobs entrent
 * dans chaque queue, comment ce débit respire, et quelles erreurs remplissent
 * le cimetière. Il ne connaît ni pg-boss ni Minecraft — il ne décrit qu'un
 * TRAFIC.
 *
 * Le hasard passe par un PRNG semé (`SEED`) plutôt que par `Math.random` :
 * deux tournages avec la même graine donnent exactement les mêmes vagues,
 * donc on peut refaire une prise sans re-régler la caméra.
 *
 * Le dimensionnement. La capacité n'est pas `workers / 1,6 s` (la durée
 * moyenne d'un job) mais ce qui a été MESURÉ workers saturés : ~2,3 s par
 * job et par worker, l'écart venant de l'attente de polling (0,5 s max) et
 * de PGlite, mono-thread, qui encaisse aussi les insertions.
 *
 *     queue      workers   capacité mesurée   débit moyen   creux   pic
 *     scraping     10           4,3/s            3,2/s      0,3/s   6,1/s
 *     emails        6           2,6/s            1,9/s      0,5/s   3,3/s
 *     reports       3           1,3/s            0,95/s     0,3/s   1,6/s
 *
 * Le débit moyen est SOUS la capacité et le pic AU-DESSUS : c'est ce qui
 * fait la vague. Le backlog monte quand la sinusoïde passe au-dessus de la
 * ligne de capacité, puis se vide — donc des carts qui arrivent et repartent
 * plutôt qu'une voie saturée en permanence (ce qui ne se filme pas).
 */

/** Un générateur de nombres dans [0, 1[ — semé, donc reproductible. */
export type Rand = () => number

/** mulberry32 : quatre lignes, période 2^32, largement assez pour du faux trafic. */
export function seededRandom(seed: number): Rand {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

export function between(rand: Rand, min: number, max: number): number {
  return min + rand() * (max - min)
}

/** Tirage dans une liste. Lève plutôt que de rendre `undefined` (strict). */
export function pick<T>(rand: Rand, items: readonly T[]): T {
  const item = items[Math.floor(rand() * items.length)]
  if (item === undefined) throw new Error('pick() sur une liste vide')
  return item
}

/** Un job factice. `subject` sert d'ancrage réaliste dans les messages d'erreur. */
export interface TrafficJob {
  /** Numéro de séquence, unique par queue — permet de suivre un job à l'œil. */
  seq: number
  /** URL, destinataire, identifiant de rapport... selon la queue. */
  subject: string
}

export type ErrorFactory = (job: TrafficJob, rand: Rand) => string

export interface QueueProfile {
  name: string
  /** Débit moyen injecté en jobs/s, avant respiration et burst. */
  baseRate: number
  /** Amplitude de la respiration, 0..1 (0,85 = de 15 % à 185 % du débit). */
  amplitude: number
  /** Période de la respiration, en secondes. */
  periodSeconds: number
  /** Décalage de phase : les trois queues ne respirent pas ensemble. */
  phaseSeconds: number
  /** Workers pg-boss (`localConcurrency`) — le plafond de débit de sortie. */
  workers: number
  subject: (seq: number, rand: Rand) => string
  errors: readonly ErrorFactory[]
}

const HOSTS = ['shop.example.test', 'blog.example.test', 'api.partner.test', 'legacy.intranet.test']
const MAILBOXES = ['ada', 'grace', 'linus', 'margaret', 'dennis', 'barbara']
const MAIL_DOMAINS = ['example.test', 'mail.invalid', 'corp.example.test']
const REPORT_KINDS = ['daily-revenue', 'churn-cohorts', 'ads-spend', 'inventory-drift']

/** Un identifiant court façon trace-id, pour que les erreurs se ressemblent aux vraies. */
function hex(rand: Rand, length: number): string {
  let out = ''
  for (let i = 0; i < length; i++) out += Math.floor(rand() * 16).toString(16)
  return out
}

/**
 * Les trois queues. Les catalogues d'erreurs mélangent volontairement les
 * familles (réseau, protocole, données, quota) : c'est ce qui rend un mur de
 * tombes lisible — on doit pouvoir dire au premier coup d'œil « ça, c'est un
 * problème de quota », pas juste « ça a raté ».
 */
export const PROFILES: readonly QueueProfile[] = [
  {
    name: 'scraping',
    baseRate: 3.2,
    amplitude: 0.9,
    periodSeconds: 47,
    phaseSeconds: 0,
    workers: 10,
    subject: (seq, rand) => `https://${pick(rand, HOSTS)}/p/${seq}`,
    errors: [
      (job) => `ETIMEDOUT: ${job.subject} did not respond within 30000ms`,
      (_job, rand) => `HTTP 429 Too Many Requests — retry-after: ${Math.round(between(rand, 5, 120))}s`,
      (_job, rand) => `HTTP 503 Service Unavailable (edge cache, ray ${hex(rand, 8)})`,
      () => `parse error: unexpected token '<' at position 0 — expected JSON, got text/html`,
      (_job, rand) => `socket hang up (ECONNRESET) after ${Math.round(between(rand, 1, 64))} kB`,
      (job) => `redirect loop: ${job.subject} → 5 hops, giving up`,
      (job) => `robots.txt disallows ${new URL(job.subject).pathname}`,
    ],
  },
  {
    name: 'emails',
    baseRate: 1.9,
    amplitude: 0.75,
    periodSeconds: 71,
    phaseSeconds: 17,
    workers: 6,
    subject: (seq, rand) => `${pick(rand, MAILBOXES)}.${seq}@${pick(rand, MAIL_DOMAINS)}`,
    errors: [
      (job) => `SMTP 550 5.1.1 <${job.subject}>: recipient address rejected: user unknown`,
      (_job, rand) => `SMTP 421 4.7.0 too many connections from 203.0.113.${Math.round(between(rand, 2, 250))}`,
      (job) => `SMTP 452 4.2.2 mailbox full for <${job.subject}>`,
      (job) => `DNS lookup failed for mx.${job.subject.split('@')[1] ?? 'example.test'}: ENOTFOUND`,
      () => `TLS handshake timeout after 10000ms (smtp relay, STARTTLS)`,
      () => `HTTP 429 provider rate limit: 200 messages/min exceeded`,
      () => `template render error: missing variable {{first_name}}`,
    ],
  },
  {
    name: 'reports',
    baseRate: 0.95,
    amplitude: 0.65,
    periodSeconds: 113,
    phaseSeconds: 39,
    workers: 3,
    subject: (seq, rand) => `${pick(rand, REPORT_KINDS)}-${seq}`,
    errors: [
      (job) => `canceling statement due to statement timeout (30s) — ${job.subject}`,
      (_job, rand) =>
        `JavaScript heap out of memory while aggregating ${Math.round(between(rand, 800, 4_000))}k rows`,
      (_job, rand) => `parse error: malformed CSV at line ${Math.round(between(rand, 12, 90_000))} — unterminated quote`,
      (job) => `S3 PutObject failed: 403 AccessDenied (s3://qc-reports/${job.subject}.parquet)`,
      (_job, rand) => `deadlock detected on relation "facts_daily" (pid ${Math.round(between(rand, 1_000, 32_000))})`,
      () => `HTTP 429 billing API rate limit — retry-after: 30s`,
    ],
  },
]

/**
 * Les bursts : un coup de folie ponctuel par-dessus la sinusoïde. Sans eux
 * le trafic est trop régulier — c'est joli mais ça ne raconte rien. Avec,
 * on a des vagues de carts qui arrivent d'un coup, ce qu'on veut filmer.
 */
export const BURST = {
  /** Probabilité qu'une queue calme parte en burst, par seconde (≈ 1 par 40 s). */
  chancePerSecond: 0.025,
  minSeconds: 4,
  maxSeconds: 10,
  minFactor: 3,
  maxFactor: 6,
} as const

export interface TrafficConfig {
  /** Part des jobs qui échouent, 0..1. */
  failRate: number
  jobMinMs: number
  jobMaxMs: number
  /** Multiplie tous les débits (pour un tournage plus calme ou plus violent). */
  rateScale: number
  seed: number
  /** 0 = tourne jusqu'à Ctrl-C. */
  durationSeconds: number
}

/**
 * `FAIL_RATE` accepte les trois écritures qu'on tape naturellement :
 * `0.08`, `8` et `8%` veulent tous dire 8 %. Au-dessus de 1 sans `%`,
 * c'est forcément des pourcents — personne ne demande 800 % d'échecs.
 */
export function readRate(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const text = raw.trim()
  const value = Number(text.replace('%', ''))
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`FAIL_RATE invalide : « ${raw} » (attendu : 0.08, 8 ou 8%)`)
  }
  const rate = text.includes('%') || value > 1 ? value / 100 : value
  if (rate > 1) throw new Error(`FAIL_RATE au-dessus de 100 % : « ${raw} »`)
  return rate
}

export function readNumber(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} invalide : « ${raw} »`)
  return value
}

export function readConfig(env: NodeJS.ProcessEnv): TrafficConfig {
  const config: TrafficConfig = {
    failRate: readRate(env.FAIL_RATE, 0.08),
    jobMinMs: readNumber('JOB_MIN_MS', env.JOB_MIN_MS, 200),
    jobMaxMs: readNumber('JOB_MAX_MS', env.JOB_MAX_MS, 3_000),
    rateScale: readNumber('RATE_SCALE', env.RATE_SCALE, 1),
    // Sans graine explicite, une graine tirée au sort — et affichée au
    // démarrage, pour pouvoir rejouer exactement la même séquence.
    seed: Math.trunc(readNumber('SEED', env.SEED, Math.floor(Math.random() * 2 ** 31))),
    durationSeconds: readNumber('DURATION_S', env.DURATION_S, 0),
  }
  if (config.jobMinMs > config.jobMaxMs) {
    throw new Error(`JOB_MIN_MS (${config.jobMinMs}) dépasse JOB_MAX_MS (${config.jobMaxMs})`)
  }
  return config
}
