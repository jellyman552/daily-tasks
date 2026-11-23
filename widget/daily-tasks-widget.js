// Daily Tasks widget for Scriptable (https://scriptable.app).
// Works on the Lock Screen (rectangular, circular, inline) and the Home Screen (small, medium).
//
// Setup: in the Daily Tasks app open Settings › Copy widget link, and paste it below.

const WIDGET_LINK = 'PASTE_YOUR_WIDGET_LINK_HERE';

// ---------------------------------------------------------------

const appUrl = WIDGET_LINK.split('/api/')[0] + '/';

function fmt(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
function dur(min) {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}
function minsUntil(iso, now) { return Math.round((new Date(iso) - now) / 60000); }

// What the widget is about: the task you should be doing now, else the next one.
function headline(d, now) {
  if (d.current) {
    const t = d.current;
    const left = minsUntil(t.endAt, now);
    return {
      label: 'Now', title: t.title,
      detail: left > 0 ? `until ${fmt(t.end)} · ${dur(left)} left` : `${dur(-left)} over`,
      short: `Now: ${t.title}`,
    };
  }
  if (d.next) {
    const t = d.next;
    return { label: 'Next', title: t.title, detail: `${fmt(t.start)} · ${dur(t.duration)}`, short: `${fmt(t.start)} ${t.title}` };
  }
  if (d.total > 0) return { label: 'Today', title: 'All done', detail: `${d.done} of ${d.total} finished`, short: 'All tasks done' };
  return { label: 'Today', title: 'Nothing planned', detail: '', short: 'No tasks today' };
}

// Ask iOS to refresh around the next start or end time (it may be a little later; iOS decides).
function nextRefresh(d, now) {
  const times = [];
  if (d.current) times.push(new Date(d.current.endAt));
  for (const t of d.upcoming || []) times.push(new Date(t.startAt));
  const soon = times.filter(t => t > now).sort((a, b) => a - b)[0];
  const fallback = new Date(now.getTime() + 15 * 60000);
  return soon && soon < fallback ? soon : fallback;
}

function buildError(family, msg) {
  const w = new ListWidget();
  const t = w.addText(family === 'accessoryInline' ? 'Tasks: offline' : msg);
  t.font = Font.systemFont(12);
  return w;
}

function build(d, family) {
  const now = new Date();
  const h = headline(d, now);
  const w = new ListWidget();
  w.url = appUrl;
  w.refreshAfterDate = nextRefresh(d, now);

  if (family === 'accessoryInline') {
    w.addText(h.short);
    return w;
  }

  if (family === 'accessoryCircular') {
    w.addSpacer();
    const n = w.addText(`${d.done}/${d.total}`);
    n.font = Font.boldRoundedSystemFont(18); n.centerAlignText(); n.minimumScaleFactor = 0.6;
    const l = w.addText('done');
    l.font = Font.systemFont(10); l.centerAlignText();
    w.addSpacer();
    return w;
  }

  if (family === 'accessoryRectangular') {
    const top = w.addText(`${h.label.toUpperCase()} · ${d.done}/${d.total} DONE`);
    top.font = Font.semiboldSystemFont(11); top.textOpacity = 0.7;
    const title = w.addText(h.title);
    title.font = Font.boldSystemFont(15); title.lineLimit = 1; title.minimumScaleFactor = 0.7;
    if (h.detail) { const det = w.addText(h.detail); det.font = Font.systemFont(12); det.lineLimit = 1; }
    return w;
  }

  // Home Screen sizes.
  const accent = new Color('#2f6f5e');
  w.backgroundColor = Color.dynamic(new Color('#f6f5f2'), new Color('#1f1f22'));
  const text = Color.dynamic(new Color('#1c1c1e'), new Color('#f2f2f4'));
  const muted = Color.dynamic(new Color('#6e6e73'), new Color('#9b9ba1'));
  w.setPadding(14, 14, 14, 14);

  const head = w.addText(`${h.label.toUpperCase()} · ${d.done} of ${d.total} done`);
  head.font = Font.semiboldSystemFont(11); head.textColor = accent;
  w.addSpacer(4);
  const title = w.addText(h.title);
  title.font = Font.boldSystemFont(family === 'small' ? 16 : 18); title.textColor = text; title.lineLimit = 2;
  if (h.detail) { const det = w.addText(h.detail); det.font = Font.systemFont(12); det.textColor = muted; }

  const later = d.current ? d.upcoming : (d.upcoming || []).slice(1);
  const rows = family === 'small' ? later.slice(0, 2) : later.slice(0, 3);
  if (rows.length) {
    w.addSpacer(8);
    for (const t of rows) {
      const r = w.addText(`${fmt(t.start)}  ${t.title}`);
      r.font = Font.systemFont(12); r.textColor = muted; r.lineLimit = 1;
    }
  }
  w.addSpacer();
  return w;
}

async function main() {
  const family = config.widgetFamily || 'medium';
  let widget;
  if (WIDGET_LINK.includes('PASTE_YOUR')) {
    widget = buildError(family, 'Paste your widget link into the script.');
  } else {
    try {
      const req = new Request(WIDGET_LINK);
      req.timeoutInterval = 15;
      const data = await req.loadJSON();
      if (data.error) throw new Error(data.error);
      widget = build(data, family);
    } catch (e) {
      widget = buildError(family, `Can't reach Daily Tasks.\n${e.message || e}`);
    }
  }
  if (config.runsInWidget) Script.setWidget(widget);
  else await widget.presentMedium();
  Script.complete();
}

await main();
