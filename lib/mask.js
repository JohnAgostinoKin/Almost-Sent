// lib/mask.js
//
// Best-effort PII scrubbing for the incoming line before it's stored (see
// api/draft.js's remember()) — never applied to what's sent to the model,
// only to what lands in Supabase's `inbox` table. Not exhaustive: this
// catches the common formatted cases, not every possible way a phone
// number or email could be written.

// Ordinary email shape: local@domain.tld. Matched before the phone regex
// below so an email's digits (e.g. a Gmail alias like "john123@gmail.com")
// never get chewed up by the phone pattern first.
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[a-z]{2,}/gi;

// Formatted phone numbers: optional leading +country code and/or an open
// paren ("(555) 123-4567" — the open paren has to be matched explicitly
// since the match otherwise starts at the first digit, leaving a dangling
// "(" behind), then digits separated by spaces/dashes/dots/parens —
// "555-123-4567", "(555) 123 4567", "+1 555.123.4567". Bounded (6 to 12
// separator/digit characters between the first and last digit) so this
// can't run away across an unrelated stretch of prose that happens to
// contain scattered digits.
const PHONE_RE = /\+?\(?\d[\d().\-\s]{6,12}\d/g;

// Fallback: a bare run of 7+ digits with no separators at all ("5551234567").
// Over-masking a stray long number is the safe failure direction for a
// privacy filter; under-masking a real phone number is not.
const BARE_DIGITS_RE = /\b\d{7,}\b/g;

function maskPII(text) {
  return String(text || "")
    .replace(EMAIL_RE, "[email]")
    .replace(PHONE_RE, "[phone]")
    .replace(BARE_DIGITS_RE, "[phone]");
}

module.exports = { EMAIL_RE, PHONE_RE, BARE_DIGITS_RE, maskPII };
