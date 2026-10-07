import { execFile } from 'node:child_process';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config.module';
import type { Env } from '../../config/env.schema';

export type Bounds = [minLng: number, minLat: number, maxLng: number, maxLat: number];

/** Cuts a region out of a .pmtiles archive (the go-pmtiles CLI in production). */
export interface PmtilesExtractor {
  extract(input: string, output: string, bounds: Bounds, maxZoom: number): Promise<void>;
}

export const PMTILES_EXTRACTOR = Symbol('PMTILES_EXTRACTOR');

/** The CLI failed every attempt (or isn't installed): the tenant's build fails, the job goes on. */
export class PmtilesExtractError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'PmtilesExtractError';
  }
}

// settings-exempt: coordinate precision passed to the CLI (~1 cm), a format choice
const COORD_DECIMALS = 6;

/**
 * `pmtiles extract <input> <output> --bbox=… --maxzoom=…` (ADR 050), a local
 * process — still an external call by rule 5: a timeout, retries, a typed
 * error. Arguments go to execFile as an array: no shell, nothing interpolated.
 */
@Injectable()
export class PmtilesCli implements PmtilesExtractor {
  constructor(
    @Inject(APP_CONFIG)
    private readonly env: Pick<Env, 'PMTILES_BIN' | 'PMTILES_TIMEOUT_MS' | 'PMTILES_MAX_ATTEMPTS'>,
  ) {}

  async extract(input: string, output: string, bounds: Bounds, maxZoom: number): Promise<void> {
    const args = [
      'extract',
      input,
      output,
      `--bbox=${bounds.map((n) => n.toFixed(COORD_DECIMALS)).join(',')}`,
      `--maxzoom=${maxZoom}`,
    ];
    let last: unknown;
    for (let attempt = 1; attempt <= this.env.PMTILES_MAX_ATTEMPTS; attempt++) {
      try {
        await new Promise<void>((resolve, reject) => {
          execFile(
            this.env.PMTILES_BIN,
            args,
            { timeout: this.env.PMTILES_TIMEOUT_MS, killSignal: 'SIGKILL' },
            (error, _stdout, stderr) => {
              if (error) reject(new Error(`${error.message}: ${stderr.trim()}`, { cause: error }));
              else resolve();
            },
          );
        });
        return;
      } catch (error) {
        last = error;
      }
    }
    throw new PmtilesExtractError(
      `pmtiles extract failed after ${this.env.PMTILES_MAX_ATTEMPTS} attempt(s)`,
      this.env.PMTILES_MAX_ATTEMPTS,
      { cause: last },
    );
  }
}
