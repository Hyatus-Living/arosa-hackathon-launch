export const PLAN_TEXT_LIMIT = 3000;
const EXTENSIONS = new Set(['.json', '.csv', '.txt', '.md', '.svg', '.ifc']);

export async function readPlanText(file) {
  const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  if (!EXTENSIONS.has(extension)) throw new Error('Choose a UTF-8 text file (.json, .csv, .txt, .md, .svg or .ifc).');
  if (file.size > PLAN_TEXT_LIMIT * 4) throw new Error('This text file is too large to fit in a 3,000-character message.');
  const text = await file.text();
  if (!text.trim()) throw new Error('That text file is empty. Your question has not been changed.');
  if (text.includes('\0') || text.includes('\uFFFD')) throw new Error('The file could not be read as UTF-8 text. Your question has not been changed.');
  return text;
}

export function planTextMessage(draft, name, text) {
  const question = draft || 'Review this plan or survey text and state which details remain unverified.';
  const message = `${question}\n\n[Plan/survey text: ${name}]\n${text}\n[End of supplied text]`;
  if (message.length > PLAN_TEXT_LIMIT) throw new Error('The complete text does not fit with your question within 3,000 characters. Your question has not been changed.');
  return message;
}
