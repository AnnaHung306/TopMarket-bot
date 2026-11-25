// Material parameters from Gavin's original glass poster, e015b3b3ba181c79d463035132b825c243c3b1c0,
// worker/report/styles.js [data-lens]. Geometry and typography stay in exports.mjs.
export const posterGlassCss = String.raw`
  .glass {
    position: relative;
    background:
      linear-gradient(152deg, #c2efff16, transparent 32%, #07101843 69%, #00121d41),
      #060a10a1;
    -webkit-backdrop-filter: blur(.5px) saturate(117%);
    backdrop-filter: blur(.5px) saturate(117%);
    border: 1px solid #9eddf75c;
    box-shadow: inset 0 1px 1px #effdff70, inset 0 -1px 2px #62dfff37, 0 12px 36px #0008;
  }
  .glass::before {
    content: "";
    position: absolute;
    inset: 0;
    box-sizing: border-box;
    border-radius: inherit;
    box-shadow: inset 0 0 6px #94e6fc2e, inset 0 0 1px #cff4ff75;
    pointer-events: none;
  }
`;
