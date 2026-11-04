// Plan notes: what the floor plan page tells Arosa (a saved revision, an attached drawing). They never
// start a run of their own; they ride on the user's next message in the project's conversation.
const sentence = (n) => (n.kind === "revision" ? `I saved revision ${n.revision} of the floor plan.` : `I attached the drawing "${n.name}" to the floor plan.`);
const phrase = (n) => (n.kind === "revision" ? `you saved revision ${n.revision}` : `you attached ${n.name}`);

export function addPlanNote(notes, note) {
  if (note.kind === "revision") return [...notes.filter((n) => n.kind !== "revision"), note];
  return notes.some((n) => n.kind === note.kind && n.name === note.name) ? notes : [...notes, note];
}
export const planNotesLine = (notes) => `Arosa will see: ${notes.map(phrase).join("; ")}`;
// The notes go in front of the message when both fit the 3,000 character limit; otherwise they wait.
export function withPlanNotes(text, notes, limit = 3000) {
  if (!notes.length) return text;
  const message = `[Plan update: ${notes.map(sentence).join(" ")}]\n\n${text}`;
  return message.length <= limit ? message : text;
}
