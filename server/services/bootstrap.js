import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import config from '../config.js';

/**
 * Seed the content directory on first boot.
 *
 * Managed hosts mount persistent volumes empty — unlike Docker named volumes,
 * nothing is copied in from the image. Without this, the first deploy would
 * come up with an empty chapter shelf and no config.json.
 *
 * The guard is deliberately conservative: seeding happens only when the target
 * has no config.json at all. Once the site is live and chapters have been
 * uploaded, this is a no-op on every subsequent boot, so a redeploy can never
 * overwrite published work.
 */
export function ensureContentSeeded() {
  const target = config.contentDir;
  const baseline = config.contentBaselineDir;

  const alreadySeeded = existsSync(join(target, 'config.json'));
  if (alreadySeeded) return { seeded: false, reason: 'content already present' };

  if (!existsSync(baseline) || !existsSync(join(baseline, 'config.json'))) {
    // Nothing to copy from. Create the directory so uploads still work, and
    // let the API serve empty language lists rather than failing outright.
    mkdirSync(target, { recursive: true });
    for (const lang of config.languages) {
      mkdirSync(join(target, 'chapters', lang), { recursive: true });
      mkdirSync(join(target, 'updates', lang), { recursive: true });
    }
    return { seeded: false, reason: 'no baseline content bundled' };
  }

  mkdirSync(target, { recursive: true });
  cpSync(baseline, target, { recursive: true, force: false, errorOnExist: false });

  const languages = existsSync(join(target, 'chapters'))
    ? readdirSync(join(target, 'chapters')).length
    : 0;

  return { seeded: true, reason: `copied baseline content (${languages} languages)` };
}
