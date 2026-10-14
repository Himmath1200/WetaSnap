/**
 * Steps 11 and 12: the lead score, and when to follow up.
 *
 * The score is deliberately boring and explainable — an exhibition lead is worth following up on
 * when you can actually reach the person, you know who they are, and the person on the stand
 * thought it went well. Every point can be pointed at, which matters when a sales lead asks why
 * one card is at the top of the list. There is no model here and no hidden weighting.
 */
export interface ScoreInput {
  email: string;
  phone: string;
  orgDomain: string;
  jobTitle: string;
  interest: 'hot' | 'warm' | 'cold' | null;
  consent: boolean;
  notes: string;
  timesMet: number;
  hasCardPhoto: boolean;
}

export interface Score { score: number; reasons: string[] }

/** Words that mean the person can say yes without asking anybody. */
const SENIOR = /\b(ceo|cto|coo|cfo|cio|founder|owner|president|vp|vice[- ]president|managing|director|head|chief|partner|inhaber|geschäftsführ|gesch.ftsf.hr|gerente|directeur)\b/i;
const BUYER = /\b(purchas|procurement|buyer|einkauf|acquisti|compras|achat)\b/i;

export function scoreLead(input: ScoreInput): Score {
  let score = 0;
  const reasons: string[] = [];
  const add = (points: number, why: string) => { score += points; reasons.push(`${points > 0 ? '+' : ''}${points} ${why}`); };

  if (input.email) add(20, 'email address');
  if (input.phone) add(12, 'phone number');
  if (input.orgDomain) add(8, 'company domain');
  if (SENIOR.test(input.jobTitle)) add(15, 'decision maker');
  else if (BUYER.test(input.jobTitle)) add(12, 'buying role');
  else if (input.jobTitle) add(5, 'job title');

  if (input.interest === 'hot') add(25, 'marked hot');
  else if (input.interest === 'warm') add(14, 'marked warm');
  else if (input.interest === 'cold') add(3, 'marked cold');

  if (input.consent) add(5, 'consent given');
  if (input.notes.trim().length >= 20) add(5, 'notes from the conversation');
  if (input.hasCardPhoto) add(3, 'card photo on file');
  if (input.timesMet > 1) add(Math.min(10, (input.timesMet - 1) * 5), 'met more than once');

  if (!input.email && !input.phone) {
    score = Math.min(score, 20);
    reasons.push('capped: no way to reach them');
  }
  return { score: Math.max(0, Math.min(100, Math.round(score))), reasons };
}

/**
 * Step 13: when this one should be picked up again. Hot leads go stale in a day, cold ones can
 * wait for the post-show mailing — the date is a suggestion the admin can change.
 */
export function followUpDate(interest: 'hot' | 'warm' | 'cold' | null, from = new Date()): string {
  const days = interest === 'hot' ? 1 : interest === 'warm' ? 3 : interest === 'cold' ? 14 : 7;
  const when = new Date(from);
  when.setDate(when.getDate() + days);
  return when.toISOString().slice(0, 10);
}
