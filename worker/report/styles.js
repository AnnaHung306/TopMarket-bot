export const reportStyles = String.raw`
:root {
  color-scheme: dark;
  --background: #050506;
  --ink: #f5f7fa;
  --muted: #a9b3be;
  --accent: #00d5ff;
  --line: #d2e5f124;
  --sans: Manrope, -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans TC", sans-serif;
  --mono: ui-monospace, SFMono-Regular, Consolas, monospace;
  background: var(--background);
  color: var(--ink);
  font: 15px/1.55 var(--sans);
}
*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; min-width: 0; min-height: 100vh; }
h1, h2, h3, p { margin: 0; }
a { color: #70e8ff; text-underline-offset: 3px; }
button, input, select { font: inherit; }
:focus-visible { outline: 2px solid #75e8ff; outline-offset: 3px; }
::selection { color: #001419; background: var(--accent); }
body { isolation: isolate; }
.site-header {
  position: relative;
  z-index: 2;
  background: #09090b;
  border-bottom: 1px solid #f5f8ff1a;
}
.header-inner {
  width: min(100% - 64px, 1192px);
  margin: auto;
  min-height: 62px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
}
.header-brand { display: flex; align-items: center; gap: 14px; }
.header-brand img, .poster-brand { display: block; object-fit: contain; }
.header-brand > span {
  border-left: 1px solid #f5f8ff24;
  padding-left: 14px;
  color: var(--ink);
  font-size: 13px;
  font-weight: 700;
  white-space: nowrap;
}
.network, .eyebrow, .section-index, .total > span {
  font: 650 10px/1.3 var(--mono);
  letter-spacing: .1em;
}
.network {
  display: flex;
  align-items: center;
  gap: 7px;
  color: #bac1c8;
  font-size: 11px;
  white-space: nowrap;
}
.network span, .eyebrow span { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 12px #00d5ff66; }
.network i { font-style: normal; color: #82929e; }
.ambient {
  position: absolute;
  z-index: 0;
  display: block;
  top: 62px;
  left: 0;
  width: 100%;
  height: clamp(720px, 64vw, 920px);
  pointer-events: none;
  visibility: hidden;
}
.ambient[data-painted="true"]:not([data-gpu="unavailable"]) { visibility: visible; }
.intro .gpu-status { margin-top: 9px; color: var(--muted); font-size: 12px; }
main {
  position: relative;
  z-index: 1;
  width: min(100% - 64px, 1192px);
  margin: auto;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(286px, 327px);
  grid-template-areas:
    "intro intro"
    "query poster"
    "overview poster"
    "evidence poster"
    "holdings poster"
    "methodology poster"
    "footer footer";
  align-items: start;
  gap: 16px 20px;
}
.intro { grid-area: intro; padding: 40px 0 17px; }
.eyebrow { color: #8deaff; display: flex; align-items: center; gap: 9px; }
.intro h1 {
  margin: 11px 0 5px;
  font-size: clamp(2.75rem, 6vw, 4.55rem);
  line-height: 1.02;
  font-weight: 780;
  letter-spacing: -.06em;
}
.intro h1 span { color: var(--accent); }
.intro p { color: #bdc6ce; font-size: 14px; }
.query { grid-area: query; }
.overview { grid-area: overview; }
.evidence { grid-area: evidence; }
.holdings { grid-area: holdings; }
.poster { grid-area: poster; }
.methodology { grid-area: methodology; }
footer { grid-area: footer; }
.glass {
  position: relative;
  min-width: 0;
  padding: 22px;
  border: 1px solid #b8dded31;
  border-radius: 14px;
  background: linear-gradient(148deg, #c5e8f00d, transparent 52%), #0a0d12bd;
  box-shadow: inset 0 1px 0 #e7fbff16, 0 12px 36px #0005;
}
[data-lens] {
  --glass-refraction-base: blur(.5px) saturate(117%);
  border-color: #9eddf75c;
  background:
    linear-gradient(152deg, #c2efff16, transparent 32%, #07101843 69%, #00121d41),
    #060a10a1;
  box-shadow: inset 0 1px 1px #effdff70, inset 0 -1px 2px #62dfff37, 0 12px 36px #0008;
}
[data-lens]::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  box-shadow: inset 0 0 6px #94e6fc2e, inset 0 0 1px #cff4ff75;
  pointer-events: none;
}
[data-lens]:not([data-glass-refraction="active"]) {
  -webkit-backdrop-filter: var(--glass-refraction-base);
  backdrop-filter: var(--glass-refraction-base);
}
.glass-refraction-definitions {
  position: absolute;
  overflow: hidden;
  pointer-events: none;
}
@media (prefers-reduced-transparency: no-preference) and (forced-colors: none) {
  [data-glass-refraction="active"] {
    backdrop-filter: var(--glass-refraction-base, blur(3px) saturate(120%)) var(--glass-refraction-filter);
  }
}
.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}
.section-heading h2 { font-size: 17px; line-height: 1.35; }
.section-index { color: #9ebbc8; white-space: nowrap; }
label, .caption, .split span { color: var(--muted); font-size: 12px; }
label { display: block; }
.form-controls { display: flex; gap: 9px; margin-top: 6px; }
input, select, button {
  min-height: 42px;
  border: 1px solid #b7d7e248;
  border-radius: 7px;
  padding: 9px 12px;
  background: #06090cd1;
  color: var(--ink);
}
input::placeholder { color: #86929e; }
.form input { flex: 1 1 auto; min-width: 0; width: 100%; font: 13px var(--mono); }
button { cursor: pointer; font-weight: 720; white-space: nowrap; transition: background-color .15s, border-color .15s; }
button:disabled { color: #a0aeb6; background: #111a20b3; border-color: #b7d7e22b; cursor: not-allowed; }
button:not(:disabled):hover { border-color: #83e8ff; }
#analyze:not(:disabled), #download:not(:disabled) { background: var(--accent); border-color: var(--accent); color: #061419; }
#analyze:not(:disabled):hover, #download:not(:disabled):hover { background: #78ebff; }
#analyze span, #download span { margin-left: 4px; }
.quiet:not(:disabled) { background: #1c323b72; }
.quiet:not(:disabled):hover { background: #27444f; }
button.text-button {
  border: 0;
  background: transparent;
  color: #8cecff;
  font-size: 12px;
  min-height: 32px;
  padding: 2px 0 2px 6px;
}
.text-button:hover { text-decoration: underline; text-underline-offset: 3px; }
#cancel[hidden] { display: none; }
button.text-button:disabled { opacity: .55; }
.options-disclosure { margin-top: 11px; }
summary { cursor: pointer; color: #dce7ef; font-size: 13px; font-weight: 650; }
summary::marker { color: #83d7e8; }
.options { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; margin: 11px 0 8px; }
.options input, .options select { width: 100%; min-width: 0; margin-top: 5px; font-size: 13px; }
.scan-status { position: relative; margin-top: 16px; }
.scan-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 12px; }
.scan-phase { color: var(--ink); font-size: 13px; font-weight: 700; }
#status { color: #b7d4de; font-size: 12px; min-height: 19px; overflow-wrap: anywhere; }
.scan-percent { color: var(--accent); font: 700 17px/1.1 var(--mono); font-variant-numeric: tabular-nums; }
.scan-track {
  height: 7px;
  margin-top: 9px;
  border-radius: 999px;
  background: linear-gradient(180deg, #7496c633, #0d1c2ed9 40%, #20354e99);
  box-shadow: inset 0 1px 1px #a2d0ff29, inset 0 -1px 0 #02060cdd;
  overflow: hidden;
}
.scan-track span {
  position: relative;
  display: block;
  width: var(--scan-progress, 0%);
  height: 100%;
  border-radius: inherit;
  overflow: hidden;
  background: linear-gradient(180deg, #c5faff 0%, #48e1ff 21%, #12b4fd 46%, #137bed 75%, #287aff 100%);
  box-shadow: inset 0 1px 0 #fff9, inset 0 -1px 0 #8fdcffb3, 0 0 7px #28aaffaa;
  transition: width 240ms ease-out;
}
.scan-track span::after {
  content: "";
  position: absolute;
  inset: 0 0 0 auto;
  width: 20px;
  border-radius: inherit;
  background: radial-gradient(ellipse at 83% 34%, #efffffda, #7fefff70 22%, #8bc4ff00 70%);
}
.scan-status:is([data-phase=idle], [data-phase=preparing]) .scan-track span { transition: none; }
.scan-status progress:not([hidden]) { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
@media (prefers-reduced-motion: reduce) {
  .scan-track span { transition: none; }
}
.overview h3 { font-size: 13px; color: #c1d1db; font-weight: 550; }
.total { display: flex; align-items: baseline; flex-wrap: wrap; column-gap: 10px; }
.total .big { min-width: 0; overflow-wrap: anywhere; font-size: clamp(2.4rem, 5vw, 3.6rem); font-weight: 760; font-variant-numeric: tabular-nums; letter-spacing: -.06em; line-height: 1.08; }
.total > span { color: #71e8ff; }
.metrics {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin: 16px 0 0;
  border-top: 1px solid var(--line);
}
.metric { padding: 10px 11px 10px 0; border-bottom: 1px solid var(--line); }
.metric b, .split b { display: block; font-variant-numeric: tabular-nums; font-size: 21px; line-height: 1.25; margin: 2px 0 1px; overflow-wrap: anywhere; }
.metric small { display: block; color: var(--muted); font-size: 11px; }
.split { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; padding: 11px 0 0; }
.split b { font-size: 14px; color: #e3edf4; }
.warning {
  margin-top: 14px;
  padding: 9px 11px;
  border-left: 2px solid #41c8e88c;
  border-radius: 0 5px 5px 0;
  background: #36b2d013;
  color: #c5d9e2;
  font-size: 12px;
  line-height: 1.65;
}
.table-wrap { max-height: 340px; overflow: auto; border: 1px solid var(--line); border-radius: 8px; }
table { width: 100%; border-collapse: collapse; white-space: nowrap; font-size: 12px; }
th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--line); }
th { position: sticky; top: 0; background: #10161c; color: #c0d0db; }
tr:last-child td { border-bottom: 0; }
td:nth-child(2), td:nth-child(3) { font-variant-numeric: tabular-nums; }
.empty { padding: 20px 9px; text-align: center; color: var(--muted); white-space: normal; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 11px; }
.actions button { min-height: 36px; font-size: 12px; }
.holdings .caption + #assets { margin-top: 10px; }
.poster { position: sticky; top: 16px; }
.poster-top { display: flex; justify-content: space-between; align-items: center; gap: 8px; }

.poster h2 { margin-top: 10px; font-size: 27px; letter-spacing: -.04em; }
.wallet { font: 11px/1.5 var(--mono); color: var(--muted); overflow-wrap: anywhere; }
.poster-total { margin: 14px 0 9px; }
.poster .total .big { font-size: 35px; }
.poster-row { display: flex; justify-content: space-between; gap: 12px; border-top: 1px solid var(--line); padding: 7px 0; font-size: 12px; }
.poster-row span { color: #b9c8d1; }
.poster-row b { font-variant-numeric: tabular-nums; overflow-wrap: anywhere; text-align: right; }
.poster-date { margin-top: 8px; font: 10px/1.5 var(--mono); overflow-wrap: anywhere; }
.poster-actions { display: grid; gap: 7px; margin-top: 13px; }
.poster-actions button { width: 100%; min-height: 37px; font-size: 12px; }
#posterStatus { margin-top: 8px; }
#posterStatus:empty { display: none; }
#posterFile { margin-top: 12px; font-size: 12px; }
.methodology { padding: 15px 22px; }
.methodology > p { margin-top: 9px; }
.methodology ul { padding-inline-start: 19px; }
.methodology li + li { margin-top: 5px; }
.methodology a { font-size: 12px; }
footer { padding: 3px 0 22px; color: #9aa7b3; font-size: 11px; line-height: 1.7; }
@media (max-width: 830px) {
  main {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas: "intro" "query" "overview" "evidence" "holdings" "poster" "methodology" "footer";
  }
  .poster { position: relative; top: auto; }
  .ambient { height: 920px; }
}
@media (max-width: 540px) {
  .header-inner, main { width: calc(100% - 28px); }
  .header-inner { min-height: 57px; }
  .header-brand { gap: 8px; }
  .header-brand img { width: 55px; height: 30px; }
  .header-brand > span { padding-left: 8px; font-size: 12px; }
  .network { gap: 5px; letter-spacing: 0; }
  .intro { padding: 28px 1px 8px; }
  .intro h1 { font-size: clamp(2.35rem, 11vw, 3.6rem); }
  .intro p { font-size: 13px; }
  main { gap: 12px; }
  .glass { padding: 15px; }
  .section-heading { margin-bottom: 10px; }
  .section-index { font-size: 9px; }
  .form-controls { flex-wrap: wrap; }
  .form input { flex-basis: 100%; font-size: 16px; }
  .form-controls button { flex: 1; }
  .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .options { grid-template-columns: 1fr; }
  .options input, .options select { font-size: 16px; }
  .metric b { font-size: 19px; }
  .ambient { top: 57px; }
}
@media (prefers-reduced-transparency: reduce), (forced-colors: active) {
  [data-lens] { background: #11161b; }
  [data-lens]:not([data-glass-refraction="active"]) { -webkit-backdrop-filter: none; backdrop-filter: none; }
}
@media (prefers-reduced-motion: reduce) {
  button { transition: none; }
}
@media print {
  :root, body { background: #050506; print-color-adjust: exact; }
  .site-header, .ambient, main > :not(.poster), .poster-actions, #posterStatus, #posterFile, #posterImage { display: none !important; }
  main { display: block; width: 100%; }
  .poster { position: static; min-height: 90vh; background: #11161b; backdrop-filter: none !important; box-shadow: none; break-inside: avoid; }
}
@page { size: A4; margin: 12mm; }
`;
