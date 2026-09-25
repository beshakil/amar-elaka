import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import mjml2html from 'mjml';

// Caches the in-flight compile Promise (not just the resolved value) so
// concurrent first-sends of the same template dedupe onto one mjml2html()
// call instead of racing to compile it multiple times.
const compiledTemplateCache = new Map<string, Promise<string>>();

async function compileTemplate(template: string): Promise<string> {
  const source = readFileSync(join(__dirname, 'templates', `${template}.mjml`), 'utf8');
  const { html, errors } = await mjml2html(source);
  if (errors.length > 0) {
    throw new Error(
      `mail template "${template}" failed to compile: ${errors.map((error) => error.formattedMessage).join('; ')}`,
    );
  }
  return html;
}

function compile(template: string): Promise<string> {
  let pending = compiledTemplateCache.get(template);
  if (!pending) {
    pending = compileTemplate(template);
    compiledTemplateCache.set(template, pending);
    pending.catch(() => compiledTemplateCache.delete(template));
  }
  return pending;
}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Compiles the named `mail/templates/*.mjml` file once (cached in memory
 * thereafter) then interpolates `{{key}}` placeholders per call. MJML passes
 * `{{...}}` text through untouched, so this order — compile once, interpolate
 * per send — is safe and avoids recompiling MJML on every email.
 */
export async function renderMailTemplate(
  template: string,
  params: Record<string, string>,
): Promise<string> {
  const compiled = await compile(template);
  // Whitespace inside the braces is optional (`{{body}}` and `{{ body }}` are
  // the same placeholder), so reformatting a template can't silently break it.
  return compiled.replace(PLACEHOLDER, (match, key: string) =>
    Object.hasOwn(params, key) ? escapeHtml(params[key] ?? '') : match,
  );
}
