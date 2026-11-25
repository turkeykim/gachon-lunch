import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const sources = {
  vision: 'https://www.gachon.ac.kr/kor/7347/subview.do',
  education: 'https://www.gachon.ac.kr/kor/7349/subview.do',
};

const htmlEntities = { amp: '&', nbsp: ' ', lt: '<', gt: '>', quot: '"', apos: "'", middot: '·', ndash: '–', bull: '•' };

function decodeCell(html) {
  return html.replace(/<[^>]*>/g, '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code) => {
    if (!code.startsWith('#')) return htmlEntities[code.toLowerCase()] ?? entity;
    const point = code[1].toLowerCase() === 'x' ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
    return point <= 0x10ffff ? String.fromCodePoint(point) : entity;
  }).replace(/\s+/g, ' ').trim();
}

export function parseMenu(html) {
  const table = [...html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)].find(([markup]) => markup.includes('일주일간 식단 안내'))?.[0];
  if (!table) throw new Error('식단표를 찾을 수 없습니다');
  const body = /<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i.exec(table)?.[1];
  if (body === undefined) throw new Error('식단표 본문을 찾을 수 없습니다');

  let date;
  const days = {};
  for (const [, row] of body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const header = /<th\b[^>]*>([\s\S]*?)<\/th>/i.exec(row);
    const postedDate = header && /\b(\d{4})[.\/-](\d{1,2})[.\/-](\d{1,2})\b/.exec(decodeCell(header[1]));
    if (postedDate) {
      const [, year, month, day] = postedDate;
      date = [year, month.padStart(2, '0'), day.padStart(2, '0')].join('-');
      days[date] ??= [];
    }
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => match[1]);
    if (!date || cells.length < 2) continue;
    const category = decodeCell(cells[0]);
    const items = cells.at(-1).split(/<br\s*\/?\s*>/gi).map(decodeCell).filter(Boolean);
    const cost = /([\d,]+)\s*원/.exec(category);
    let kind;
    if (/아침|조식/.test(category)) kind = 'breakfast';
    else if (/석식|저녁/.test(category)) kind = 'dinner';
    else if (/샐러드/.test(category)) kind = 'salad';
    else if (/점심|중식/.test(category)) {
      const option = category.match(/[AB]/i)?.[0]?.toLowerCase();
      kind = option || 'lunch';
    }
    if (!kind) continue;
    const price = cost ? Number(cost[1].replaceAll(',', '')) : category.includes('천원') ? 1000 : null;
    const available = items.length > 0 && !items.every((item) => /^[-–—]+$/.test(item));
    const notice = kind === 'salad' && /^\*/.test(items[0] ?? '');
    days[date].push({ kind, label: category.replace(/[\d,]+\s*원/g, '').trim(), price: available && !notice ? price : null, items: available ? items : [], notice });
  }
  return days;
}

function koreaDate() {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts();
  return ['year', 'month', 'day'].map((unit) => parts.find((part) => part.type === unit).value).join('-');
}

function mondayOf(day) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return date.toISOString().slice(0, 10);
}


async function fetchMenu(id, source, week, fetchPage) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetchPage(source, { signal: AbortSignal.timeout(12000), headers: { Accept: 'text/html', 'Accept-Language': 'ko-KR,ko;q=0.9' } });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const days = parseMenu(await response.text());
      if (!Object.keys(days).some(day => mondayOf(day) === week)) return [id, { status: 'unpublished', days: {} }];
      console.log(id + ': parsed ' + Object.keys(days).length + ' dates');
      return [id, { status: 'ok', days }];
    } catch (error) {
      console.warn(id + ', attempt ' + attempt + ': ' + error.message);
    }
  }
  return [id, { status: 'unavailable', days: {} }];
}

export async function collectMenus({ today = koreaDate(), fetchPage = fetch } = {}) {
  const week = mondayOf(today);
  const entries = await Promise.all(Object.entries(sources).map(([id, source]) => fetchMenu(id, source, week, fetchPage)));
  return { week, checkedAt: new Date().toISOString(), restaurants: Object.fromEntries(entries) };
}

async function lastPublished(base, week) {
  if (!base) return null;
  try {
    const url = new URL(base.endsWith('/') ? base : base + '/');
    const response = await fetch(new URL('menus.json', url), { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;
    const saved = await response.json();
    return saved.week === week ? saved.restaurants : null;
  } catch {
    return null;
  }
}

async function buildSite() {
  const current = await collectMenus();
  if (Object.values(current.restaurants).some(result => result.status === 'unavailable')) {
    const previous = await lastPublished(process.env.PAGES_BASE_URL, current.week);
    for (const [id, result] of Object.entries(current.restaurants)) {
      const saved = previous?.[id];
      if (result.status === 'unavailable' && (saved?.status === 'ok' || saved?.status === 'stale')) {
        current.restaurants[id] = { status: 'stale', days: saved.days };
      }
    }
  }
  const dist = new URL('./dist/', import.meta.url);
  await mkdir(dist, { recursive: true });
  await writeFile(new URL('index.html', dist), await readFile(new URL('index.html', import.meta.url)));
  await writeFile(new URL('menus.json', dist), JSON.stringify(current));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await buildSite();
