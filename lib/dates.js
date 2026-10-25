// Date helpers. All dates are plain 'YYYY-MM-DD' strings.

function todayIn(timezone) {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function parse(date) {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function format(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function addDays(date, n) {
  return format(parse(date) + n * 86400000);
}

function diffDays(a, b) {
  return Math.round((parse(a) - parse(b)) / 86400000);
}

// 0 = Sunday ... 6 = Saturday
function dayOfWeek(date) {
  return new Date(parse(date)).getUTCDay();
}

function range(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

function isValid(date) {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && format(parse(date)) === date;
}

// Calendar date ('YYYY-MM-DD') of an ISO timestamp in a time zone.
function dateOf(iso, timezone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

// Local wall-clock time 'YYYY-MM-DDTHH:mm' in a time zone -> ISO timestamp (UTC).
function zonedToIso(local, timezone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(local || ''));
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: timezone || 'Asia/Kolkata', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(guess)).map((p) => [p.type, p.value])
  );
  const asLocal = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  return new Date(guess - (asLocal - guess)).toISOString();
}

module.exports = { todayIn, addDays, diffDays, dayOfWeek, range, isValid, dateOf, zonedToIso };
