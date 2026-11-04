// Renders an underwriting deck JSON (GET /api/conversations/:id/deck without format=html) with this
// checkout's deck template, so a real site's package can be reviewed before the research service is
// redeployed. Usage: node scripts/render-deck.mjs deck.json [out.html]
import { readFileSync, writeFileSync } from 'node:fs';
import { renderDeckHtml } from '../acres-research/deliverable.mjs';

const [input, output = input.replace(/\.json$/i, '') + '.html'] = process.argv.slice(2);
if (!input) {
  console.error('Usage: node scripts/render-deck.mjs deck.json [out.html]');
  process.exit(1);
}
const deck = JSON.parse(readFileSync(input, 'utf8'));
if (!Array.isArray(deck.slides)) {
  console.error('That file is not a deck: expected the JSON body of /api/conversations/:id/deck.');
  process.exit(1);
}
writeFileSync(output, renderDeckHtml(deck));
console.log(`Wrote ${output}. Open it in a browser and use "Print or save PDF".`);
