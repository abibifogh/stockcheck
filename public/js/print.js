import { state } from './app.js';
import { h } from './util.js';

/**
 * Turning a report into a PDF.
 *
 * This goes through the browser's own print dialog ("Save as PDF") rather than
 * a PDF library. That is a deliberate choice, not a shortcut:
 *
 *  - the charts are already SVG, so they come out as vector — sharp at any
 *    zoom, and selectable text rather than a screenshot;
 *  - no 500KB dependency to download, and nothing fetched from a CDN, which
 *    matters because the whole app is served from one origin;
 *  - page size, margins and orientation stay under the reader's control.
 *
 * What this file adds is everything the browser cannot know: a proper title
 * block, and a print stylesheet that hides the furniture.
 */

let cleanup = null;

export function printReport({ title, subtitle, note }) {
  // A second click while the dialog is open would stack two headers.
  if (cleanup) cleanup();

  const generated = new Date().toLocaleString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  const header = h('div.print-header',
    h('div.print-brand',
      h('span', '📦'),
      h('strong', state.settings.property_name || 'Nice Operation'),
    ),
    h('h1.print-title', title),
    subtitle ? h('div.print-subtitle', subtitle) : null,
    note ? h('div.print-note', note) : null,
    h('div.print-meta', `Prepared ${generated}${state.name ? ` · ${state.name}` : ''}`),
  );

  const footer = h('div.print-footer',
    'Figures come from the day sheets recorded by the kitchen and the delivery log. '
    + 'Costs use the average price paid for each item at the time it was used.',
  );

  document.body.prepend(header);
  document.body.append(footer);
  document.body.classList.add('printing');

  cleanup = () => {
    header.remove();
    footer.remove();
    document.body.classList.remove('printing');
    cleanup = null;
  };

  // Chrome fires this after the dialog closes; Safari may not, so also clean up
  // on a timer as a backstop. Either way the page must not be left altered.
  const after = () => {
    window.removeEventListener('afterprint', after);
    if (cleanup) cleanup();
  };
  window.addEventListener('afterprint', after);
  setTimeout(() => { if (cleanup) cleanup(); }, 60_000);

  // Give the browser a frame to lay the header out before the dialog opens.
  requestAnimationFrame(() => window.print());
}

/** The button every report screen carries. */
export function printButton({ title, subtitle, note }) {
  return h('button.btn-sm', {
    title: 'Opens your print dialog — choose “Save as PDF” as the destination',
    onclick: () => printReport({ title, subtitle, note }),
  }, '📄 Save as PDF');
}
