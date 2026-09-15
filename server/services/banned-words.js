/**
 * The default list the comment filter starts with.
 *
 * Scope, deliberately narrow: slurs and targeted abuse, plus a few spam
 * giveaways. It is not a profanity filter. A comic about anything with stakes
 * will have readers swearing in the comments, and a site that holds "damn" for
 * review teaches its moderator to approve everything without reading, which is
 * worse than no filter.
 *
 * Matching is on word boundaries, which is what keeps this from being the usual
 * embarrassment -- an unbounded list catches Scunthorpe, Penistone, "class
 * ic", "assume", "cockpit" and a hundred other innocent words, and every one of
 * those is a real reader wrongly accused.
 *
 * What it still cannot do: spacing and substitution defeat it (n i g g e r,
 * f4ggot), and context is invisible to it -- a slur quoted by the person it
 * targets reads identically to one thrown at them. It is a tripwire that puts
 * a comment in front of a human, not a judge. The Claude screening alongside it
 * is what actually reads meaning.
 *
 * Tomo can edit this list in the admin panel; this is only what the site starts
 * with rather than an empty box.
 */

const RACIAL = [
  'nigger',
  'niggers',
  'nigga',
  'niggas',
  'chink',
  'chinks',
  'gook',
  'gooks',
  'spic',
  'spics',
  'wetback',
  'wetbacks',
  'kike',
  'kikes',
  'towelhead',
  'towelheads',
  'sandnigger',
  'raghead',
  'ragheads',
  'coon',
  'coons',
  'jungle bunny',
  'porch monkey',
  'beaner',
  'beaners',
  'gyppo',
  'pikey',
  'abo',
  'darkie',
  'darky',
  'half-breed',
  'paki',
  'pakis',
];

const SEXUALITY_AND_GENDER = [
  'faggot',
  'faggots',
  'fag',
  'fags',
  'dyke',
  'dykes',
  'tranny',
  'trannies',
  'shemale',
  'shemales',
  'ladyboy',
  'he-she',
  'homo',
  'queer bait',
];

const ABILITY = ['retard', 'retards', 'retarded', 'tard', 'mongoloid', 'spastic', 'cripple'];

/**
 * Not slurs, but the things that turn a comment section poisonous: telling
 * somebody to kill themselves, and threats. Held rather than rejected, because
 * "kys" in a joke between friends and "kys" aimed at a stranger look the same
 * to a word list and only a person can tell them apart.
 */
const ABUSE = [
  'kill yourself',
  'kys',
  'neck yourself',
  'go die',
  'hang yourself',
  'i will find you',
  'i know where you live',
];

/** The usual comment spam. */
const SPAM = [
  'free robux',
  'free vbucks',
  'crypto giveaway',
  'binary options',
  'forex signals',
  'work from home',
  'click my profile',
  'onlyfans',
  'telegram me',
  'whatsapp me',
  'casino bonus',
  'porn',
  'xxx',
  'sex cam',
  'viagra',
  'cialis',
];

export const DEFAULT_BANNED_WORDS = [
  ...RACIAL,
  ...SEXUALITY_AND_GENDER,
  ...ABILITY,
  ...ABUSE,
  ...SPAM,
];

export const DEFAULT_BANNED_WORDS_TEXT = DEFAULT_BANNED_WORDS.join('\n');
