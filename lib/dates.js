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

module.exports = { todayIn, addDays, diffDays, dayOfWeek, range, isValid };
