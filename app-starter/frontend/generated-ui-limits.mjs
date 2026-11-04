// Bound collections before schema validation, which otherwise traverses every element.
export function assertGeneratedUiLimits(value) {
  const stringWithin = (text, limit) => typeof text === 'string' && text.length <= limit;
  if (!value || typeof value !== 'object' ||
      !Array.isArray(value.html) || value.html.length !== 1 ||
      !stringWithin(value.html[0], 18000) || !value.html[0].trim() ||
      !stringWithin(value.css, 6000) ||
      (value.jsFunctions !== undefined && !stringWithin(value.jsFunctions, 10000)) ||
      (value.jsExpressions !== undefined && (!Array.isArray(value.jsExpressions) ||
        value.jsExpressions.length > 8 || value.jsExpressions.some(text => !stringWithin(text, 4000)))) ||
      !Number.isFinite(value.initialHeight) || value.initialHeight < 100 || value.initialHeight > 900) {
    throw new Error('Generated interface exceeded its limits.');
  }
}
