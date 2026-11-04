export const generatedUiTool = {
  name: 'generateSandboxedUi',
  description: 'Create a useful interactive interface only when a comparison, scenario, calculator, timeline or checklist is clearer than ordinary text. Use retrieved evidence and label hypothetical inputs. A simple factual question stays text. The UI is isolated and has no network, private account or server access. Match Arosa: set no page or card background colors of your own; the sandbox follows the app theme and provides CSS variables to use: var(--bg) and var(--surface) for backgrounds, var(--ink) and var(--ink-muted) for text, var(--line) for borders, and var(--success), var(--warning), var(--danger) only for state. Thin rounded borders, generous spacing, readable system fonts. Make controls usable on mobile. Use inline HTML, CSS and JavaScript with no imports, external resources, links, forms, embeds or top navigation. The sandbox may call Websandbox.connection.remote.sendPrompt({text}) for a user-clicked follow-up. Cite supplied source IDs visibly. Keep factual conclusions in the normal answer as well.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      initialHeight: {type: 'number', minimum: 100, maximum: 900},
      placeholderMessages: {type: 'array', items: {type: 'string', maxLength: 160}, maxItems: 3},
      css: {type: 'string', maxLength: 6000},
      html: {type: 'string', maxLength: 18000},
      jsFunctions: {type: 'string', maxLength: 10000},
      jsExpressions: {type: 'array', items: {type: 'string', maxLength: 4000}, maxItems: 8},
    },
    required: ['initialHeight', 'css', 'html'],
  },
};

const LIMIT_MESSAGE = 'Generated interface exceeded its limits. Use a shorter interface or a normal answer.';
const EXTERNAL_RESOURCE_MESSAGE = 'Generated interface used external resources. Use only inline HTML, CSS and JavaScript with no external resources, or a normal answer.';

const EXTERNAL_MARKUP_PATTERNS = [
  /<\s*(?:script|link|img|iframe|audio|video|source|embed|object)\b[^>]+(?:src|href|data)\s*=\s*["']\s*(?:https?:)?\/\//i,
  /<\s*base\b/i,
  /@import\b/i,
  /url\(\s*["']?\s*(?:https?:)?\/\//i,
];
const NETWORK_SCRIPT_PATTERN = /\b(?:fetch\s*\(|XMLHttpRequest\b|WebSocket\b|EventSource\b|sendBeacon\b)/;

function usesExternalResources(args) {
  const markup = `${args.css}\n${args.html}`;
  if (EXTERNAL_MARKUP_PATTERNS.some(pattern => pattern.test(markup))) return true;
  const scripts = `${args.jsFunctions || ''}\n${(args.jsExpressions || []).join('\n')}`;
  return NETWORK_SCRIPT_PATTERN.test(scripts);
}

export function generatedUiContent(args) {
  if (!args || typeof args !== 'object') throw new Error(LIMIT_MESSAGE);
  const invalid =
    typeof args.html !== 'string' || !args.html.trim() || args.html.length > 18000 ||
    typeof args.css !== 'string' || !args.css.trim() || args.css.length > 6000 ||
    (args.placeholderMessages !== undefined && (!Array.isArray(args.placeholderMessages) || args.placeholderMessages.length > 3 || args.placeholderMessages.some(message => typeof message !== 'string' || !message.trim() || message.length > 160))) ||
    (args.jsFunctions !== undefined && (typeof args.jsFunctions !== 'string' || args.jsFunctions.length > 10000)) ||
    (args.jsExpressions !== undefined && (!Array.isArray(args.jsExpressions) || args.jsExpressions.length > 8 || args.jsExpressions.some(expression => typeof expression !== 'string' || expression.length > 4000))) ||
    !Number.isFinite(args.initialHeight) || args.initialHeight < 100 || args.initialHeight > 900;
  if (invalid) throw new Error(LIMIT_MESSAGE);
  if (usesExternalResources(args)) throw new Error(EXTERNAL_RESOURCE_MESSAGE);
  return {
    initialHeight: args.initialHeight,
    generating: false,
    css: args.css,
    cssComplete: true,
    html: [args.html],
    htmlComplete: true,
    jsFunctions: args.jsFunctions || '',
    jsFunctionsComplete: true,
    jsExpressions: args.jsExpressions || [],
    jsExpressionsComplete: true,
  };
}
