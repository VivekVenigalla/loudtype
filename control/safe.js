// Stream-safe mode: swear words and slurs become a symbol burst (#@%!) that
// keeps the word's size, weight and color, so the line still shows how it was
// said. Only what is shown (overlay, exports) is masked; the emotion model still
// reads the real words. Whole-word patterns, so "class", "assist", "Dickens",
// "cocktail" or "Scunthorpe" are never touched.

export const MASK = '#@%!';

// Matched against the word's letters only, lowercased (apostrophes dropped).
const PATTERNS = [
  /^(mother)?f+u+c+k+(s|ed|er|ers|in|ing|ings|wit|face|head|off|up)?$/,
  /^(bull|horse|dip|chicken)?sh+i+t+(s|ty|tier|tiest|head|heads|ted|ting|show|faced)?$/,
  /^bitch(es|y|ing|ed)?$/,
  /^(dumb|jack|smart|bad|kick|fat|lard)?ass(es|hole|holes|hat|hats)?$/,
  /^bastards?$/,
  /^dick(s|head|heads|wad|wads)?$/,
  /^cunts?$/,
  /^cock(s|sucker|suckers|sucking)?$/,
  /^(whore|slut)s?$/,
  /^piss(ed|es|ing)?$/,
  /^twats?$/,
  /^wank(er|ers|ing)?$/,
  // slurs
  /^nig(g|gg)+(a|as|az|er|ers|ah)$/,
  /^fag(s|got|gots|gy)?$/,
  /^retard(s|ed)?$/,
  /^trann(y|ies)$/,
  /^(kike|chink|spic|wetback|gook)s?$/,
];

/** True when this word (with any punctuation around it) is a swear word or slur. */
export function isSwear(word) {
  if (/[a-z]\*{2,}/i.test(word)) return true; // already starred by speech-to-text ("f***")
  const core = word.toLowerCase().replace(/['’]/g, '').replace(/[^a-z]/g, '');
  return !!core && PATTERNS.some((p) => p.test(core));
}

/** "fucking," → "#@%!," (punctuation around the word is kept). */
export function maskWord(word) {
  if (!isSwear(word)) return word;
  const [, lead, , trail] = /^([^\p{L}\p{N}*]*)(.*?)([^\p{L}\p{N}*]*)$/u.exec(word);
  return `${lead}${MASK}${trail}`;
}

/** A caption line event with its swear words masked (sound tags are left alone). */
export function maskLine(msg) {
  if (msg.type !== 'line' || !msg.words?.some((w) => !w.event && isSwear(w.word))) return msg;
  return { ...msg, words: msg.words.map((w) => (w.event ? w : { ...w, word: maskWord(w.word) })) };
}

/** An exported line (words + text) with its swear words masked. */
export function maskExportLine(line) {
  const words = line.words.map((w) => (w.event ? w : { ...w, word: maskWord(w.word) }));
  return { ...line, words, text: line.text.split(/(\s+)/).map((t) => (/\s/.test(t) ? t : maskWord(t))).join('') };
}
