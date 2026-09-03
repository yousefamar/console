// Loads the ring command schema from its vault note on demand (cheap: the
// note is a few KB and deliveries are rare), keeping the LAST GOOD schema
// when an edit leaves the yaml unparseable — a typo mid-edit must not flip
// the router to defaults and start mis-routing. Seeds the note on first use
// so Yousef always has an editable copy.

import type { NoteStore } from '../notes.js'
import { parseSchemaNote, seedSchemaNote, DEFAULT_SCHEMA, RING_SCHEMA_NOTE, type RingSchema } from './schema.js'

export interface LoadedSchema {
  schema: RingSchema
  errors: string[]
  /** True when `schema` is a previous good parse, not the current note. */
  stale: boolean
  path: string
}

export class RingSchemaLoader {
  private lastGood: RingSchema = structuredClone(DEFAULT_SCHEMA)
  private lastContent: string | null = null
  private lastErrors: string[] = []
  private seeded = false

  constructor(private store: NoteStore, private log: (msg: string) => void, private path = RING_SCHEMA_NOTE) {}

  /** Last good schema without I/O (for callers already past `load()`). */
  current(): RingSchema {
    return this.lastGood
  }

  async load(): Promise<LoadedSchema> {
    let md: string
    try {
      md = await this.store.read(this.path)
    } catch {
      if (!this.seeded) {
        this.seeded = true
        try {
          await this.store.write(this.path, seedSchemaNote())
          this.log(`[ring] seeded schema note ${this.path}`)
          md = seedSchemaNote()
        } catch (e) {
          this.log(`[ring] cannot seed ${this.path}: ${(e as Error).message}`)
          return { schema: this.lastGood, errors: [`schema note ${this.path} missing and could not be seeded`], stale: true, path: this.path }
        }
      } else {
        return { schema: this.lastGood, errors: [`schema note ${this.path} missing`], stale: true, path: this.path }
      }
    }
    if (md === this.lastContent) return { schema: this.lastGood, errors: this.lastErrors, stale: this.lastErrors.some((e) => e.startsWith('yaml')), path: this.path }
    const parsed = parseSchemaNote(md)
    this.lastContent = md
    const fatal = parsed.errors.some((e) => e.startsWith('yaml') || e.startsWith('no ```yaml'))
    if (fatal) {
      this.log(`[ring] schema note unparseable — keeping last good: ${parsed.errors.join('; ')}`)
      this.lastErrors = parsed.errors
      return { schema: this.lastGood, errors: parsed.errors, stale: true, path: this.path }
    }
    this.lastGood = parsed.schema
    this.lastErrors = parsed.errors
    if (parsed.errors.length) this.log(`[ring] schema warnings: ${parsed.errors.join('; ')}`)
    return { schema: parsed.schema, errors: parsed.errors, stale: false, path: this.path }
  }
}
