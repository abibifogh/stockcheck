// Hand-rolled SVG charts with hover read-outs.
//
// Written by hand rather than pulled from a CDN for two reasons: the Worker
// serves the whole app from one origin with no external requests, and the
// charts only need five shapes. Everything scales via viewBox, so they stay
// crisp on a phone and on a 27" screen.

import { h, fmtNum } from './util.js';

const NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v != null) el.setAttribute(k, v);
  }
  return el;
}

function niceTicks(min, max, count = 4) {
  if (min === max) {
    const pad = Math.abs(min) || 1;
    min -= pad * 0.5;
    max += pad * 0.5;
  }
  const span = max - min;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm >= 7.5 ? 10 : norm >= 3.5 ? 5 : norm >= 1.5 ? 2 : 1) * mag;
  const start = Math.floor(min / step) * step;
  const ticks = [];
  for (let v = start; v <= max + step * 0.5; v += step) ticks.push(Number(v.toFixed(10)));
  return ticks;
}

function tooltip() {
  const el = h('div', {
    style: {
      position: 'fixed', pointerEvents: 'none', zIndex: '90', opacity: '0',
      background: 'var(--surface)', border: '1px solid var(--border-strong)',
      borderRadius: '9px', padding: '.45rem .6rem', font: '500 .8rem/1.4 var(--sans)',
      color: 'var(--text)', boxShadow: 'var(--shadow)', whiteSpace: 'nowrap',
      transition: 'opacity .1s',
    },
  });
  document.body.append(el);
  return {
    el,
    show(html, x, y) {
      el.innerHTML = html;
      el.style.opacity = '1';
      const rect = el.getBoundingClientRect();
      const left = Math.min(Math.max(8, x - rect.width / 2), window.innerWidth - rect.width - 8);
      const top = y - rect.height - 12 < 8 ? y + 18 : y - rect.height - 12;
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
    },
    hide() { el.style.opacity = '0'; },
    destroy() { el.remove(); },
  };
}

// Charts detach their tooltip when the container leaves the DOM, so switching
// views never strands a floating box on screen.
//
// A chart is built before it is mounted, so the container starts out
// disconnected. Tearing down on that first state would kill the tooltip before
// it was ever used — we only clean up once it has actually been on the page.
function autoCleanup(container, tip) {
  let wasConnected = false;
  const observer = new MutationObserver(() => {
    if (container.isConnected) {
      wasConnected = true;
      return;
    }
    if (wasConnected) {
      tip.destroy();
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

/**
 * Multi-series line chart with an interactive crosshair.
 *
 * series: [{ name, color, values: [number|null], dashed?, area?, axis? }]
 *
 * A series may opt into `axis: 'right'`, which gives it its own scale. That
 * matters whenever two quantities share a chart but not a range — guests in
 * the dozens against a cost per guest in the twenties would otherwise flatten
 * the cost line into a meaningless streak along the bottom.
 */
export function lineChart({
  labels, series, height = 240, format = (v) => fmtNum(v, 2), yLabel = '', showPoints = true,
  rightFormat = null,
}) {
  const W = 860;
  const H = height;
  const hasRight = series.some((s) => s.axis === 'right');
  const pad = { top: 16, right: hasRight ? 52 : 16, bottom: 30, left: 54 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  const scaleFor = (subset) => {
    const all = subset.flatMap((s) => s.values).filter((v) => v != null && Number.isFinite(v));
    const rawMin = all.length ? Math.min(...all) : 0;
    const rawMax = all.length ? Math.max(...all) : 1;
    const ticks = niceTicks(Math.min(0, rawMin), rawMax || 1);
    return { ticks, min: ticks[0], max: ticks[ticks.length - 1] };
  };

  const leftSeries = series.filter((s) => s.axis !== 'right');
  const rightSeries = series.filter((s) => s.axis === 'right');
  const left = scaleFor(leftSeries.length ? leftSeries : series);
  const right = hasRight ? scaleFor(rightSeries) : null;

  const x = (i) => (labels.length === 1 ? plotW / 2 : (i / (labels.length - 1)) * plotW) + pad.left;
  const project = (v, scale) => pad.top + plotH - ((v - scale.min) / (scale.max - scale.min || 1)) * plotH;
  const y = (v, axis) => project(v, axis === 'right' ? right : left);

  const svg = svgEl('svg', {
    viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img',
    'aria-label': yLabel || 'Line chart', style: 'overflow: visible',
  });

  const leftColor = hasRight ? (leftSeries[0]?.color || 'var(--c1)') : 'var(--text-faint)';
  left.ticks.forEach((t) => {
    svg.append(svgEl('line', {
      x1: pad.left, x2: W - pad.right, y1: project(t, left), y2: project(t, left),
      stroke: 'var(--border)', 'stroke-width': 1,
    }));
    const label = svgEl('text', {
      x: pad.left - 8, y: project(t, left) + 4, 'text-anchor': 'end',
      fill: leftColor, 'font-size': 11,
    });
    label.textContent = fmtNum(t, Math.abs(t) < 10 ? 1 : 0);
    svg.append(label);
  });

  if (hasRight) {
    // Right-hand ticks are drawn without gridlines so the two scales cannot be
    // mistaken for one another.
    const rightColor = rightSeries[0]?.color || 'var(--c2)';
    for (const t of right.ticks) {
      const label = svgEl('text', {
        x: W - pad.right + 8, y: project(t, right) + 4, 'text-anchor': 'start',
        fill: rightColor, 'font-size': 11,
      });
      label.textContent = fmtNum(t, Math.abs(t) < 10 ? 1 : 0);
      svg.append(label);
    }
  }

  const every = Math.ceil(labels.length / 12);
  labels.forEach((label, i) => {
    if (i % every !== 0 && i !== labels.length - 1) return;
    const text = svgEl('text', {
      x: x(i), y: H - 8, 'text-anchor': 'middle', fill: 'var(--text-faint)', 'font-size': 11,
    });
    text.textContent = label;
    svg.append(text);
  });

  series.forEach((s, si) => {
    const color = s.color || `var(--c${(si % 8) + 1})`;
    const segments = [];
    let current = [];
    s.values.forEach((v, i) => {
      if (v == null || !Number.isFinite(v)) {
        if (current.length) segments.push(current);
        current = [];
      } else {
        current.push([x(i), y(v, s.axis), i]);
      }
    });
    if (current.length) segments.push(current);

    for (const seg of segments) {
      if (s.area && seg.length > 1) {
        const d = `M ${seg[0][0]} ${pad.top + plotH} ` +
          seg.map(([px, py]) => `L ${px} ${py}`).join(' ') +
          ` L ${seg[seg.length - 1][0]} ${pad.top + plotH} Z`;
        svg.append(svgEl('path', { d, fill: color, opacity: 0.1 }));
      }
      const d = seg.map(([px, py], idx) => `${idx ? 'L' : 'M'} ${px} ${py}`).join(' ');
      svg.append(svgEl('path', {
        d, fill: 'none', stroke: color, 'stroke-width': s.width || 2.4,
        'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        'stroke-dasharray': s.dashed ? '5 4' : null,
        opacity: s.dashed ? 0.75 : 1,
      }));
      if (showPoints && seg.length <= 40) {
        for (const [px, py] of seg) {
          svg.append(svgEl('circle', { cx: px, cy: py, r: 3, fill: 'var(--surface)', stroke: color, 'stroke-width': 2 }));
        }
      }
    }
  });

  const crosshair = svgEl('line', {
    y1: pad.top, y2: pad.top + plotH, stroke: 'var(--text-faint)',
    'stroke-width': 1, 'stroke-dasharray': '3 3', opacity: 0,
  });
  svg.append(crosshair);

  const markers = series.map((s, si) =>
    svgEl('circle', { r: 5, fill: s.color || `var(--c${(si % 8) + 1})`, stroke: 'var(--surface)', 'stroke-width': 2, opacity: 0 }));
  markers.forEach((m) => svg.append(m));

  const container = h('div.chart', svg);
  const tip = tooltip();
  autoCleanup(container, tip);

  const locate = (event) => {
    const rect = svg.getBoundingClientRect();
    const scale = W / rect.width;
    const px = (event.clientX - rect.left) * scale;
    const idx = labels.length === 1
      ? 0
      : Math.round(((px - pad.left) / plotW) * (labels.length - 1));
    return Math.max(0, Math.min(labels.length - 1, idx));
  };

  const onMove = (event) => {
    if (!labels.length) return;
    const i = locate(event);
    const cx = x(i);
    crosshair.setAttribute('x1', cx);
    crosshair.setAttribute('x2', cx);
    crosshair.setAttribute('opacity', 1);

    const rows = series.map((s, si) => {
      const v = s.values[i];
      const color = s.color || `var(--c${(si % 8) + 1})`;
      if (v == null || !Number.isFinite(v)) {
        markers[si].setAttribute('opacity', 0);
        return `<div style="color:var(--text-faint)">${s.name}: no data</div>`;
      }
      markers[si].setAttribute('cx', cx);
      markers[si].setAttribute('cy', y(v, s.axis));
      markers[si].setAttribute('opacity', 1);
      const fmt = s.axis === 'right' && rightFormat ? rightFormat : format;
      return `<div style="display:flex;gap:.4rem;align-items:center">
        <i style="width:8px;height:8px;border-radius:2px;background:${color};display:inline-block"></i>
        <span style="color:var(--text-dim)">${s.name}</span>
        <b style="margin-left:auto">${fmt(v)}</b></div>`;
    }).join('');

    const rect = svg.getBoundingClientRect();
    tip.show(
      `<div style="font-weight:650;margin-bottom:.2rem">${labels[i]}</div>${rows}`,
      rect.left + (cx / W) * rect.width,
      rect.top + (pad.top / H) * rect.height,
    );
  };

  const onLeave = () => {
    crosshair.setAttribute('opacity', 0);
    markers.forEach((m) => m.setAttribute('opacity', 0));
    tip.hide();
  };

  svg.addEventListener('mousemove', onMove);
  svg.addEventListener('mouseleave', onLeave);
  svg.addEventListener('touchmove', (e) => { onMove(e.touches[0]); }, { passive: true });
  svg.addEventListener('touchend', onLeave);

  if (series.length > 1) {
    container.append(h('div.legend', series.map((s, si) =>
      h('span', h('i', { style: { background: s.color || `var(--c${(si % 8) + 1})` } }), s.name))));
  }

  return container;
}

/**
 * Grouped bars — used for this-week vs last-week style comparisons.
 * groups: [{ label, values: [{ name, value, color }] }]
 */
export function barChart({ groups, height = 240, format = (v) => fmtNum(v, 2), stacked = false }) {
  const W = 860;
  const H = height;
  const pad = { top: 16, right: 16, bottom: 34, left: 54 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  const seriesNames = groups[0]?.values.map((v) => v.name) ?? [];
  const totals = groups.map((g) => (stacked
    ? g.values.reduce((a, v) => a + (v.value || 0), 0)
    : Math.max(0, ...g.values.map((v) => v.value || 0))));
  const ticks = niceTicks(0, Math.max(...totals, 1));
  const yMax = ticks[ticks.length - 1];
  const y = (v) => pad.top + plotH - (v / (yMax || 1)) * plotH;

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img' });

  for (const t of ticks) {
    svg.append(svgEl('line', { x1: pad.left, x2: W - pad.right, y1: y(t), y2: y(t), stroke: 'var(--border)' }));
    const label = svgEl('text', { x: pad.left - 8, y: y(t) + 4, 'text-anchor': 'end', fill: 'var(--text-faint)', 'font-size': 11 });
    label.textContent = fmtNum(t, t < 10 ? 1 : 0);
    svg.append(label);
  }

  const slot = plotW / Math.max(groups.length, 1);
  const inner = Math.min(slot * 0.72, 64);
  const tip = tooltip();

  groups.forEach((g, gi) => {
    const cx = pad.left + slot * gi + slot / 2;
    const count = stacked ? 1 : g.values.length;
    const barW = inner / Math.max(count, 1);

    let stackTop = pad.top + plotH;
    g.values.forEach((v, vi) => {
      const value = v.value || 0;
      const color = v.color || `var(--c${(vi % 8) + 1})`;
      const barH = Math.max(0, pad.top + plotH - y(value));
      const bx = stacked ? cx - inner / 2 : cx - inner / 2 + barW * vi;
      const by = stacked ? stackTop - barH : y(value);
      if (stacked) stackTop -= barH;

      const rect = svgEl('rect', {
        x: bx, y: by, width: stacked ? inner : barW - 2, height: barH,
        rx: 4, fill: color, opacity: v.faded ? 0.4 : 0.9,
      });
      rect.style.cursor = 'pointer';
      rect.addEventListener('mouseenter', (event) => {
        rect.setAttribute('opacity', 1);
        tip.show(
          `<div style="font-weight:650;margin-bottom:.2rem">${g.label}</div>
           <div style="display:flex;gap:.5rem"><span style="color:var(--text-dim)">${v.name}</span><b style="margin-left:auto">${format(value)}</b></div>`,
          event.clientX, event.clientY,
        );
      });
      rect.addEventListener('mouseleave', () => {
        rect.setAttribute('opacity', v.faded ? 0.4 : 0.9);
        tip.hide();
      });
      svg.append(rect);
    });

    if (groups.length <= 20) {
      const label = svgEl('text', { x: cx, y: H - 10, 'text-anchor': 'middle', fill: 'var(--text-faint)', 'font-size': 11 });
      label.textContent = g.label;
      svg.append(label);
    }
  });

  const container = h('div.chart', svg);
  autoCleanup(container, tip);

  if (seriesNames.length > 1) {
    container.append(h('div.legend', seriesNames.map((name, i) =>
      h('span', h('i', { style: { background: groups[0].values[i].color || `var(--c${(i % 8) + 1})` } }), name))));
  }
  return container;
}

/** Donut for category share. */
export function donutChart({ slices, size = 220, format = (v) => fmtNum(v, 2), centerLabel = '', centerValue = '' }) {
  const total = slices.reduce((a, s) => a + (s.value || 0), 0);
  const R = size / 2;
  const inner = R * 0.62;
  const svg = svgEl('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size, role: 'img' });
  const tip = tooltip();

  if (total <= 0) {
    svg.append(svgEl('circle', { cx: R, cy: R, r: (R + inner) / 2, fill: 'none', stroke: 'var(--surface-3)', 'stroke-width': R - inner }));
  }

  let angle = -Math.PI / 2;
  slices.forEach((s, i) => {
    const value = s.value || 0;
    if (value <= 0 || total <= 0) return;
    const sweep = (value / total) * Math.PI * 2;
    const end = angle + sweep;
    const large = sweep > Math.PI ? 1 : 0;
    const p = (radius, a) => `${R + radius * Math.cos(a)} ${R + radius * Math.sin(a)}`;
    const path = svgEl('path', {
      d: `M ${p(R, angle)} A ${R} ${R} 0 ${large} 1 ${p(R, end)} L ${p(inner, end)} A ${inner} ${inner} 0 ${large} 0 ${p(inner, angle)} Z`,
      fill: s.color || `var(--c${(i % 8) + 1})`,
      opacity: 0.92,
    });
    path.style.cursor = 'pointer';
    path.addEventListener('mouseenter', (event) => {
      path.setAttribute('opacity', 1);
      tip.show(
        `<div style="font-weight:650">${s.label}</div><div>${format(value)} · ${fmtNum((value / total) * 100, 1)}%</div>`,
        event.clientX, event.clientY,
      );
    });
    path.addEventListener('mouseleave', () => { path.setAttribute('opacity', 0.92); tip.hide(); });
    svg.append(path);
    angle = end;
  });

  if (centerValue) {
    const v = svgEl('text', { x: R, y: R + 2, 'text-anchor': 'middle', fill: 'var(--text)', 'font-size': 19, 'font-weight': 680 });
    v.textContent = centerValue;
    svg.append(v);
  }
  if (centerLabel) {
    const l = svgEl('text', { x: R, y: R + 20, 'text-anchor': 'middle', fill: 'var(--text-faint)', 'font-size': 11 });
    l.textContent = centerLabel;
    svg.append(l);
  }

  const container = h('div', { style: { display: 'grid', placeItems: 'center' } }, svg);
  autoCleanup(container, tip);
  return container;
}

/** Inline trend line for stat tiles. */
export function sparkline(values, { width = 120, height = 30, color = 'var(--accent)', fill = true } = {}) {
  const clean = values.filter((v) => v != null && Number.isFinite(v));
  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, width, height, 'aria-hidden': 'true' });
  if (clean.length < 2) return h('div.stat-spark', svg);

  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const span = max - min || 1;
  const step = width / (values.length - 1);

  const points = [];
  values.forEach((v, i) => {
    if (v == null || !Number.isFinite(v)) return;
    points.push([i * step, height - 2 - ((v - min) / span) * (height - 4)]);
  });

  if (fill) {
    svg.append(svgEl('path', {
      d: `M ${points[0][0]} ${height} ${points.map(([x, y]) => `L ${x} ${y}`).join(' ')} L ${points.at(-1)[0]} ${height} Z`,
      fill: color, opacity: 0.14,
    }));
  }
  svg.append(svgEl('path', {
    d: points.map(([x, y], i) => `${i ? 'L' : 'M'} ${x} ${y}`).join(' '),
    fill: 'none', stroke: color, 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
  }));
  svg.append(svgEl('circle', { cx: points.at(-1)[0], cy: points.at(-1)[1], r: 2.5, fill: color }));

  return h('div.stat-spark', svg);
}

/** Horizontal ranked bars — the clearest way to read "what cost the most". */
export function rankedBars({ rows, format = (v) => fmtNum(v, 2), max = null, colorFor = null }) {
  const top = max ?? Math.max(...rows.map((r) => Math.abs(r.value)), 1);
  return h('div', { style: { display: 'grid', gap: '.5rem' } },
    rows.map((row, i) => h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(90px, 1.4fr) 3fr auto', gap: '.6rem', alignItems: 'center', fontSize: '.85rem' } },
      h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: row.label }, row.label),
      h('div.bar-track', h('div.bar-fill', {
        style: {
          width: `${Math.min(100, (Math.abs(row.value) / top) * 100)}%`,
          background: colorFor ? colorFor(row, i) : `var(--c${(i % 8) + 1})`,
        },
      })),
      h('b.mono', { style: { fontSize: '.82rem' } }, format(row.value)),
    )),
  );
}
