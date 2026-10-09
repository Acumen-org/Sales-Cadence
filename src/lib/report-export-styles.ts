/**
 * The report's styles, written once. The Reports page puts REPORT_DOCUMENT_STYLES in a style tag
 * and the exported file carries the same rules, so the two can never drift apart.
 * tests/report-export-styles.test.ts fails when the document uses a class with no rule here.
 */
export const REPORT_DOCUMENT_STYLES = `
  .rp { display: grid; gap: 20px; color: #1f2a26; font-size: 13px; }
  .rp-meta { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 6px 16px; font-size: 12.5px; color: #55645d; }
  .rp-strong { font-weight: 500; color: #1f2a26; }
  .rp-card { background: #fff; border: 1px solid #e3e8e2; border-radius: 14px; min-width: 0; }
  .rp-tiles { display: grid; gap: 12px; grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .rp-tile { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 18px 20px; }
  .rp-label { font-size: 12px; font-weight: 500; color: #6b7a74; }
  .rp-value { margin-top: 8px; font-size: 30px; font-weight: 600; line-height: 1.1; letter-spacing: -0.04em; font-variant-numeric: tabular-nums; }
  .rp-zero { color: #98a59f; }
  .rp-sub { margin-top: 6px; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; font-size: 12px; color: #55645d; }
  .rp-spark { flex-shrink: 0; overflow: visible; }
  .rp-row { display: grid; gap: 16px; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); }
  .rp-figure { margin: 0; padding: 20px; }
  .rp-caption { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
  .rp-title { font-size: 14px; font-weight: 600; color: #1f2a26; }
  .rp-aside { font-size: 12px; color: #6b7a74; }
  .rp-legend { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-bottom: 8px; font-size: 12px; color: #3c4a44; }
  .rp-key { display: inline-flex; align-items: center; gap: 7px; min-width: 0; white-space: nowrap; }
  .rp-swatch { display: inline-block; flex-shrink: 0; width: 10px; height: 10px; border-radius: 3px; }
  .rp-svg { display: block; width: 100%; height: auto; overflow: visible; }
  .rp-col:hover rect, .rp-col:hover path { opacity: 0.86; }
  .rp-donut { display: grid; grid-template-columns: 148px minmax(0, 1fr); align-items: center; gap: 20px; }
  .rp-slices { display: grid; gap: 10px; }
  .rp-slice { display: grid; grid-template-columns: minmax(0, 1fr) auto 44px; align-items: center; gap: 10px; font-size: 12.5px; color: #3c4a44; }
  .rp-num { font-variant-numeric: tabular-nums; text-align: right; }
  .rp-muted { color: #6b7a74; }
  .rp-empty { margin: 0; padding: 28px 0; text-align: center; font-size: 12.5px; color: #98a59f; }
  .rp-delta { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; font-size: 12px; font-variant-numeric: tabular-nums; }
  .rp-up { color: #047857; } .rp-down { color: #b45309; } .rp-flat { color: #98a59f; }
  .rp-was { white-space: nowrap; font-size: 11.5px; color: #6b7a74; }
  .rp-table { width: 100%; border-collapse: collapse; font-size: 13px; text-align: left; }
  .rp-table th { padding: 8px 12px; border-bottom: 1px solid #e3e8e2; background: #f8faf9; font-size: 11.5px; font-weight: 500; color: #55645d; white-space: nowrap; }
  .rp-table td { padding: 10px 12px; border-bottom: 1px solid rgba(227, 232, 226, 0.7); vertical-align: middle; }
  .rp-table tr:last-child td { border-bottom: 0; }
  .rp-table .rp-r { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .rp-name { color: #1f2a26; }
  .rp-bar { display: flex; align-items: center; gap: 8px; min-width: 120px; }
  .rp-track { flex: 1; height: 8px; overflow: hidden; border-radius: 999px; background: #eef1ed; }
  .rp-fill { display: block; height: 100%; border-radius: 999px; }
  .rp-bar-value { min-width: 40px; text-align: right; font-variant-numeric: tabular-nums; }
  .rp-campaigns { display: grid; gap: 12px; }
  .rp-campaign { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 15rem) minmax(0, 11rem); align-items: center; gap: 16px; font-size: 12.5px; }
  .rp-clamp { overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow-wrap: break-word; font-weight: 500; color: #1f2a26; }
  .rp-small { font-size: 12px; color: #6b7a74; }
  .rp-split { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; color: #55645d; }
  .rp-progress { margin-top: 6px; height: 6px; overflow: hidden; border-radius: 999px; background: #e3e8e2; }
  .rp-progress-fill { height: 100%; border-radius: 999px; }
  .rp-end { text-align: right; color: #3c4a44; font-variant-numeric: tabular-nums; }
  .rp-scroll { overflow-x: auto; }
  @media (max-width: 900px) {
    .rp-tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .rp-row, .rp-campaign { grid-template-columns: minmax(0, 1fr); }
  }
`;

export const REPORT_EXPORT_STYLES = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px; background: #f5f6f4; color: #1f2a26; font: 14px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  h1 { font-size: 22px; letter-spacing: -0.02em; margin: 0 0 16px; }
  figure { margin: 0; }
  ${REPORT_DOCUMENT_STYLES}
  @media print { body { padding: 0; background: #fff; } .rp-card { break-inside: avoid; } }
`;
